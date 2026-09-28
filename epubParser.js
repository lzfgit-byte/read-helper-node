const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getDefaultRules, mergeChapterTitles } = require('./parseRules');

// ---------------------------------------------------------------------------
// 最小 ZIP 读取实现（不依赖第三方库）
// ---------------------------------------------------------------------------

const SIG_LOCAL_HEADER = 0x04034b50;
const SIG_CENTRAL_HEADER = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const ZIP64_EXTRA_ID = 0x0001;

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === SIG_EOCD) {
      return offset;
    }
  }
  return -1;
}

// 读取中央目录，返回 { name, method, compressedSize, uncompressedSize, localOffset }
function readCentralDirectory(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw new Error('不是有效的 ZIP/EPUB 文件（未找到中央目录）');
  }
  let entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  // ZIP64：条目数或偏移为 0xFFFF/0xFFFFFFFF 时改从 ZIP64 EOCD 读取
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    const locatorOffset = eocdOffset - 20;
    if (locatorOffset >= 0 && buffer.readUInt32LE(locatorOffset) === SIG_ZIP64_LOCATOR) {
      const zip64Offset = Number(buffer.readBigUInt64LE(locatorOffset + 8));
      if (zip64Offset + 56 <= buffer.length && buffer.readUInt32LE(zip64Offset) === SIG_ZIP64_EOCD) {
        entryCount = Number(buffer.readBigUInt64LE(zip64Offset + 32));
        centralOffset = Number(buffer.readBigUInt64LE(zip64Offset + 48));
      }
    }
  }

  const entries = [];
  let offset = centralOffset;
  for (let i = 0; i < entryCount && offset + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL_HEADER) {
      break;
    }
    const method = buffer.readUInt16LE(offset + 10);
    let compressedSize = buffer.readUInt32LE(offset + 20);
    let uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    let localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    // 解析 ZIP64 扩展字段（值按 未压缩大小 / 压缩大小 / 本地头偏移 顺序存放）
    let extraOffset = offset + 46 + nameLength;
    const extraEnd = extraOffset + extraLength;
    while (extraOffset + 4 <= extraEnd) {
      const headerId = buffer.readUInt16LE(extraOffset);
      const dataSize = buffer.readUInt16LE(extraOffset + 2);
      if (headerId === ZIP64_EXTRA_ID) {
        let cursor = extraOffset + 4;
        if (uncompressedSize === 0xffffffff && cursor + 8 <= buffer.length) {
          uncompressedSize = Number(buffer.readBigUInt64LE(cursor));
          cursor += 8;
        }
        if (compressedSize === 0xffffffff && cursor + 8 <= buffer.length) {
          compressedSize = Number(buffer.readBigUInt64LE(cursor));
          cursor += 8;
        }
        if (localOffset === 0xffffffff && cursor + 8 <= buffer.length) {
          localOffset = Number(buffer.readBigUInt64LE(cursor));
          cursor += 8;
        }
      }
      extraOffset += 4 + dataSize;
    }

    if (!name.endsWith('/')) {
      entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// 打开 ZIP，按需解压并缓存条目内容
function openZip(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const entries = readCentralDirectory(buffer);
  const byName = new Map();
  const byLowerName = new Map();
  for (const entry of entries) {
    byName.set(entry.name, entry);
    if (!byLowerName.has(entry.name.toLowerCase())) {
      byLowerName.set(entry.name.toLowerCase(), entry.name);
    }
  }
  const cache = new Map();

  function resolveName(name) {
    const cleaned = String(name || '').replace(/^\/+/, '');
    if (byName.has(cleaned)) {
      return cleaned;
    }
    const lower = cleaned.toLowerCase();
    if (byLowerName.has(lower)) {
      return byLowerName.get(lower);
    }
    // 部分工具会写成 URL 编码后的路径
    try {
      const decoded = decodeURIComponent(cleaned);
      if (byName.has(decoded)) {
        return decoded;
      }
      if (byLowerName.has(decoded.toLowerCase())) {
        return byLowerName.get(decoded.toLowerCase());
      }
    } catch {
      // 忽略解码失败
    }
    return null;
  }

  function read(name) {
    const resolved = resolveName(name);
    if (!resolved) {
      return null;
    }
    if (cache.has(resolved)) {
      return cache.get(resolved);
    }
    const entry = byName.get(resolved);
    const headerOk = entry.localOffset + 30 <= buffer.length &&
      buffer.readUInt32LE(entry.localOffset) === SIG_LOCAL_HEADER;
    if (!headerOk) {
      return null;
    }
    const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    let data;
    if (entry.method === 0) {
      data = Buffer.from(raw);
    } else if (entry.method === 8) {
      data = zlib.inflateRawSync(raw);
    } else {
      throw new Error(`不支持的压缩方式：${entry.method}（${entry.name}）`);
    }
    cache.set(resolved, data);
    return data;
  }

  return {
    names: () => [...byName.keys()],
    has: (name) => Boolean(resolveName(name)),
    read,
    resolveName
  };
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

const IMAGE_MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.apng': 'image/apng',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
};

// 非图片资源（字体/媒体等）：同样参与内嵌预算与按需回退，但不计入正文图片统计
const ASSET_MEDIA_TYPES = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.css': 'text/css',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

const XHTML_MEDIA_TYPES = new Set(['application/xhtml+xml', 'text/html', 'application/dtb']);

function xmlUnescape(value) {
  return String(value == null ? '' : value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeCodePoint(code) {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  } catch {
    return '';
  }
}

// 按 XML 声明/HTML meta 中声明的字符集解码，兼容少数 GBK 编码的中文 EPUB
function decodeText(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return String(buffer == null ? '' : buffer);
  }
  const head = buffer.subarray(0, 2048).toString('latin1');
  const match = head.match(/encoding\s*=\s*["']([\w-]+)["']/i) || head.match(/charset\s*=\s*["']?([\w-]+)/i);
  const charset = (match ? match[1] : 'utf-8').toLowerCase();
  if (charset && charset !== 'utf-8' && charset !== 'utf8' && !charset.startsWith('utf-8')) {
    try {
      return new TextDecoder(charset).decode(buffer).replace(/^\uFEFF/, '');
    } catch {
      // 运行环境不支持该字符集时退回 UTF-8
    }
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function parseAttributes(tag) {
  const attrs = {};
  const regex = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = regex.exec(tag))) {
    attrs[match[1].toLowerCase()] = xmlUnescape(match[3] !== undefined ? match[3] : match[4]);
  }
  return attrs;
}

function stripTags(value) {
  return String(value == null ? '' : value).replace(/<[^>]*>/g, '');
}

// 占位图（1×1 透明图等）判定：这类 src 只是为了懒加载，真正地址在 data-src 一类属性里
const IMAGE_PLACEHOLDER_LIMIT = 512;
const LAZY_SRC_ATTRIBUTES = ['data-src', 'data-original', 'data-lazy-src', 'data-echo', 'data-url'];

function isPlaceholderSrc(value) {
  const src = String(value || '').trim();
  if (!src) {
    return true;
  }
  if (!/^data:/i.test(src)) {
    return false;
  }
  const comma = src.indexOf(',');
  return comma < 0 || src.length - comma - 1 <= IMAGE_PLACEHOLDER_LIMIT;
}

// 选取 <img> 真正要加载的地址：src 是占位（空 / 内联小图）时改用 data-src 等懒加载属性
function pickImageHref(attrs) {
  const localPath = (value) => {
    const candidate = String(value || '').trim();
    return candidate && !/^(data:|https?:|blob:|\/\/)/i.test(candidate) ? candidate : '';
  };
  const fromSrc = localPath(attrs.src);
  if (fromSrc) {
    return fromSrc;
  }
  if (isPlaceholderSrc(attrs.src)) {
    for (const name of LAZY_SRC_ATTRIBUTES) {
      const candidate = localPath(attrs[name]);
      if (candidate) {
        return candidate;
      }
    }
  }
  return attrs.src || attrs['xlink:href'] || attrs.href || '';
}

// 地址已经换成可显示的值后，去掉懒加载候选属性与 srcset，
// 避免别的阅读器（如 legado 的 Coil 加载链路）又去取那个取不到的原始地址
function stripLazyImageAttributes(tag) {
  let output = String(tag);
  for (const name of LAZY_SRC_ATTRIBUTES) {
    output = output.replace(new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'gi'), '');
  }
  return output.replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}


function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function cleanTitle(value) {
  return normalizeText(xmlUnescape(stripTags(value)));
}

function getAttribute(rawAttrs, name) {
  const regex = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const match = String(rawAttrs || '').match(regex);
  if (!match) {
    return '';
  }
  return xmlUnescape(match[2] !== undefined ? match[2] : match[3]);
}

function pathDir(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

// 以 baseDir 为基准解析相对路径，处理 ./ 与 ../
function joinPath(baseDir, href) {
  const raw = String(href || '').replace(/\\/g, '/').trim();
  const segments = [];
  if (!raw.startsWith('/')) {
    segments.push(...String(baseDir || '').replace(/\\/g, '/').split('/'));
  }
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

function guessMediaType(href) {
  const ext = path.extname(String(href || '').split(/[?#]/)[0]).toLowerCase();
  return IMAGE_MEDIA_TYPES[ext] || ASSET_MEDIA_TYPES[ext] || '';
}

function isImageMediaType(mediaType) {
  return /^image\//i.test(String(mediaType || ''));
}

function toDataUri(buffer, mediaType) {
  return `data:${mediaType || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
}

function htmlToText(html) {
  const text = xmlUnescape(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|figcaption)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 返回给前端的内容会直接插入 DOM，这里剔除脚本与内联事件，避免 EPUB 内的脚本执行
function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

// ---------------------------------------------------------------------------
// EPUB 结构解析
// ---------------------------------------------------------------------------

function parseContainer(xml) {
  const rootfileMatch = xml.match(/<rootfile\b[^>]*>/i);
  if (!rootfileMatch) {
    return '';
  }
  const fullPath = getAttribute(rootfileMatch[0], 'full-path');
  return fullPath.replace(/^\/+/, '');
}

function parseManifest(opfXml) {
  const manifestBlock = opfXml.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i);
  const items = new Map();
  if (!manifestBlock) {
    return items;
  }
  const itemRegex = /<item\b([^>]*?)\/?>/gi;
  let match;
  while ((match = itemRegex.exec(manifestBlock[1]))) {
    const attrs = parseAttributes(match[1]);
    if (!attrs.id || !attrs.href) {
      continue;
    }
    items.set(attrs.id, {
      id: attrs.id,
      href: attrs.href,
      mediaType: attrs['media-type'] || '',
      properties: attrs.properties || ''
    });
  }
  return items;
}

function parseSpine(opfXml, manifest) {
  const spineBlock = opfXml.match(/<spine\b([^>]*)>([\s\S]*?)<\/spine>/i);
  const refs = [];
  if (!spineBlock) {
    return { refs, tocId: '' };
  }
  const tocId = getAttribute(spineBlock[1], 'toc');
  const itemrefRegex = /<itemref\b([^>]*?)\/?>/gi;
  let match;
  while ((match = itemrefRegex.exec(spineBlock[2]))) {
    const attrs = parseAttributes(match[1]);
    const item = attrs.idref ? manifest.get(attrs.idref) : null;
    if (item) {
      refs.push({ ...item, linear: attrs.linear !== 'no' });
    }
  }
  return { refs, tocId };
}

function parseMetadata(opfXml) {
  const metadataBlock = opfXml.match(/<metadata\b[^>]*>([\s\S]*?)<\/metadata>/i);
  const block = metadataBlock ? metadataBlock[1] : opfXml;
  const readTag = (tag) => {
    const regex = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i');
    const match = block.match(regex);
    return match ? cleanTitle(match[1]) : '';
  };
  const metas = [];
  const metaRegex = /<meta\b([^>]*?)\/?>/gi;
  let match;
  while ((match = metaRegex.exec(block))) {
    metas.push(parseAttributes(match[1]));
  }
  return {
    title: readTag('title'),
    author: readTag('creator'),
    description: readTag('description'),
    language: readTag('language'),
    identifier: readTag('identifier'),
    publisher: readTag('publisher'),
    date: readTag('date'),
    metas
  };
}

function parseGuide(opfXml) {
  const references = [];
  const referenceRegex = /<reference\b([^>]*?)\/?>/gi;
  let match;
  while ((match = referenceRegex.exec(opfXml))) {
    const attrs = parseAttributes(match[1]);
    if (attrs.href) {
      references.push({ type: (attrs.type || '').toLowerCase(), href: attrs.href, title: attrs.title || '' });
    }
  }
  return references;
}

// NCX（EPUB2）目录：逐个 navPoint 提取 navLabel/text 与 content/@src
function parseNcxToc(xml) {
  const items = [];
  const regex = /<navPoint\b[^>]*>[\s\S]*?<navLabel\b[^>]*>[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<content\b([^>]*?)\/?>/gi;
  let match;
  while ((match = regex.exec(xml))) {
    const src = getAttribute(match[2], 'src');
    const title = cleanTitle(match[1]);
    if (src) {
      items.push({ title: title || src, href: src });
    }
  }
  return items;
}

// Nav 文档（EPUB3）目录：按 <ol> 嵌套深度计算层级
function parseNavToc(xml) {
  const navMatch = xml.match(/<nav\b[^>]*epub:type\s*=\s*["']toc["'][^>]*>([\s\S]*?)<\/nav>/i) ||
    xml.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i);
  const navHtml = navMatch ? navMatch[1] : xml;
  const items = [];
  const tokenRegex = /<ol\b[^>]*>|<\/ol>|<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  let depth = 0;
  let match;
  while ((match = tokenRegex.exec(navHtml))) {
    const token = match[0];
    if (/^<ol/i.test(token)) {
      depth += 1;
      continue;
    }
    if (/^<\/ol/i.test(token)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const href = getAttribute(match[1], 'href');
    const title = cleanTitle(match[2]);
    if (href) {
      items.push({ title: title || href, href, level: Math.max(0, depth - 1) });
    }
  }
  return items;
}

function normalizeHrefKey(href) {
  return String(href || '').split('#')[0].split('?')[0].replace(/^\.\//, '').replace(/\\/g, '/');
}

function extractHeadingTitle(html) {
  const match = html.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i) ||
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanTitle(match[1]) : '';
}

function extractBody(html) {
  const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return match ? match[1] : html.replace(/[\s\S]*?<html\b[^>]*>/i, '');
}

// ---------------------------------------------------------------------------
// 资源内嵌（图片转 base64 data URI、样式表内联）
// ---------------------------------------------------------------------------

// 图片安全上限（与 PDF 解析保持一致），超限的图片改为按需 URL 而不是 base64
const IMAGE_LIMITS = {
  // 单张图片的原始字节上限
  maxBytes: 8 * 1024 * 1024,
  // 整本内嵌图片的原始字节总量上限
  maxInlineBytes: 24 * 1024 * 1024
};

// 按需图片地址：/epub-image?id=<书籍id>&href=<书籍内路径>
function buildImageUrl(base, href) {
  const safeBase = String(base || '').replace(/["<>]/g, '');
  const separator = safeBase.includes('?') ? '&' : '?';
  return `${safeBase}${separator}href=${encodeURIComponent(href)}`;
}

function createResourceLoader(zip, options = {}) {
  const cache = new Map();
  const settings = {
    imageMode: options.imageMode === 'url' || options.imageMode === 'none' || options.imageMode === 'inline'
      ? options.imageMode
      : (options.inlineImages === false ? 'none' : 'inline'),
    imageUrlBase: typeof options.imageUrlBase === 'string' ? options.imageUrlBase : '',
    maxImageBytes: Number.isFinite(options.maxImageBytes) && options.maxImageBytes > 0
      ? options.maxImageBytes
      : IMAGE_LIMITS.maxBytes,
    maxInlineImageBytes: Number.isFinite(options.maxInlineImageBytes) && options.maxInlineImageBytes > 0
      ? options.maxInlineImageBytes
      : 0,
    // 只内嵌指定下标的章节，其余章节只保留结构（未指定=整本内嵌）
    imageChapterIndex: Number.isInteger(options.imageChapterIndex) && options.imageChapterIndex >= 0
      ? options.imageChapterIndex
      : null,
    // 或按章节文件路径指定（章节合并后下标可能变化，用 href 更稳）
    imageChapterHref: typeof options.imageChapterHref === 'string' && options.imageChapterHref
      ? options.imageChapterHref
      : '',
    // 字体等非图片资源默认不内嵌（改用按需地址），需要旧的“全内嵌”行为时传 true
    inlineFonts: options.inlineFonts === true,
    // 超预算资源写盘后返回地址的回调（未保存的解析；已保存的书籍用 imageUrlBase）
    resourceCache: typeof options.resourceCache === 'function' ? options.resourceCache : null
  };
  // 内嵌预算：整本 base64 的总量与张数，超过就改用按需地址
  const state = {
    bytes: 0,
    inlined: 0,
    skipped: 0,
    referenced: 0,
    // 当前正在处理的章节（配合 imageChapterIndex / imageChapterHref 做按章内嵌）
    chapterIndex: 0,
    chapterHref: '',
    // 字体等非图片资源（不计入正文图片统计，但同样占用预算）
    assetCount: 0,
    assetBytes: 0
  };

  function load(href, baseDir) {
    const key = `${baseDir}|${href}`;
    if (cache.has(key)) {
      return cache.get(key);
    }
    const target = joinPath(baseDir, href);
    const data = zip.read(target);
    if (!data) {
      cache.set(key, null);
      return null;
    }
    const mediaType = guessMediaType(target) || 'application/octet-stream';
    const result = { href: target, mediaType, data, dataUri: toDataUri(data, mediaType) };
    cache.set(key, result);
    return result;
  }

  // 超预算资源的按需地址：书籍内地址（已保存的书）或写盘缓存（未保存的解析）
  function resourceUrl(resource) {
    if (settings.imageUrlBase) {
      return buildImageUrl(settings.imageUrlBase, resource.href);
    }
    if (settings.resourceCache) {
      try {
        return settings.resourceCache(resource) || null;
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  // 决定一个资源用 base64 还是按需地址；两者都不行时返回 null（调用方保留原标签）
  function imageSrc(resource) {
    if (!resource || settings.imageMode === 'none') {
      return null;
    }
    // 只要指定了章节：其它章节不生成图片数据（结构不变，图片标签原样保留）
    if (settings.imageChapterHref && settings.imageChapterHref !== state.chapterHref) {
      return null;
    }
    if (settings.imageChapterIndex !== null && state.chapterIndex !== settings.imageChapterIndex) {
      return null;
    }
    const size = resource.data.length;
    const image = isImageMediaType(resource.mediaType);
    // 字体等非图片资源默认不内嵌：同一字体常被多章引用，base64 会在每章重复一份
    // （一本书能因此膨胀几十 MB），直接给按需地址；没有地址就保留原始 href。
    if (!image && settings.inlineFonts !== true) {
      const url = resourceUrl(resource);
      if (url) {
        state.assetCount += 1;
        return url;
      }
      return null;
    }
    // 单张过大：能给按需地址就给，否则跳过（防止单张图直接拉爆内存）
    if (size > settings.maxImageBytes) {
      state.skipped += 1;
      const url = resourceUrl(resource);
      if (url) {
        return url;
      }
      return null;
    }
    // 总预算只在调用方显式给正数时生效（默认不限，保证正文图片都是 base64）
    if (settings.maxInlineImageBytes > 0 && state.bytes + size > settings.maxInlineImageBytes) {
      state.skipped += 1;
      const url = resourceUrl(resource);
      if (url) {
        return url;
      }
      return null;
    }
    if (settings.imageMode === 'url') {
      const url = resourceUrl(resource);
      if (url) {
        return url;
      }
    }
    state.bytes += size;
    state.inlined += 1;
    if (!image) {
      state.assetCount += 1;
      state.assetBytes += size;
    }
    return resource.dataUri;
  }

  // sink 为当前章节的图片收集数组，便于前端知道每章用了哪些图片
  function loadImage(href, baseDir, sink, meta = {}) {
    const resource = load(href, baseDir);
    const src = imageSrc(resource);
    if (!resource || !src) {
      return null;
    }
    // 字体等资源不计入正文图片列表与图片张数
    if (isImageMediaType(resource.mediaType)) {
      state.referenced += 1;
      if (Array.isArray(sink)) {
        sink.push({
          href: resource.href,
          mediaType: resource.mediaType,
          bytes: resource.data.length,
          source: src.startsWith('data:') ? 'base64' : 'url',
          ...meta
        });
      }
    }
    return { ...resource, src };
  }

  // 样式表中的 url(...) 同样替换，保证背景图也能显示
  function inlineCssUrls(css, baseDir, sink) {
    return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, quote, href) => {
      const value = String(href).trim();
      if (!value || /^(data:|https?:|#|blob:)/i.test(value)) {
        return whole;
      }
      const resource = loadImage(value, baseDir, sink, { from: 'css' });
      return resource ? `url("${resource.src}")` : whole;
    });
  }

  return {
    load,
    loadImage,
    inlineCssUrls,
    state,
    imageMode: settings.imageMode,
    rewritesImages: settings.imageMode !== 'none',
    setChapter: (index, href) => {
      state.chapterIndex = index;
      state.chapterHref = href || '';
    }
  };
}

// 处理 <head> 中的本地样式表与 <style>，返回可直接拼进章节内容的 CSS
function collectHeadStyles(headHtml, baseDir, loader, options, images) {
  const inlineImages = loader.rewritesImages;
  const parts = [];
  const head = String(headHtml || '');
  const linkRegex = /<link\b([^>]*?)\/?>/gi;
  let match;
  while ((match = linkRegex.exec(head))) {
    const attrs = parseAttributes(match[1]);
    const rel = (attrs.rel || '').toLowerCase();
    const href = attrs.href || '';
    if (!rel.includes('stylesheet') || !href) {
      continue;
    }
    const resource = loader.load(href, baseDir);
    if (!resource) {
      continue;
    }
    const css = decodeText(resource.data);
    parts.push(inlineImages ? loader.inlineCssUrls(css, pathDir(resource.href), images) : css);
  }
  const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((match = styleRegex.exec(head))) {
    const css = match[1];
    parts.push(inlineImages ? loader.inlineCssUrls(css, baseDir, images) : css);
  }
  return parts.join('\n');
}

// 正文图片只保留 <img> 本身：多看书系等 EPUB 会把插图/注号图包成
// <sup><a href="..."><img/></a></sup>，阅读器里会显示成上标链接而不是正文图片。
// 仅当包裹层里除 <img> 外没有其它内容时才拆掉，避免误删带文字的链接。
const IMAGE_WRAPPER_TAGS = ['sup', 'sub', 'a'];
// 包裹层内除 <img> 外只允许空白与 &nbsp;，避免误删带文字/其它标签的链接
const IMAGE_ONLY_CONTENT_REGEX = /^(?:(?:&nbsp;|&#160;|\s)*<img\b[^>]*\/?>)+(?:&nbsp;|&#160;|\s)*$/i;

function unwrapImageWrappers(html) {
  let output = String(html || '');
  // 嵌套层最多迭代几轮，例如 <sup><a><img/></a></sup>
  for (let pass = 0; pass < 4; pass++) {
    const before = output;
    for (const tag of IMAGE_WRAPPER_TAGS) {
      const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
      output = output.replace(regex, (whole, inner) =>
        (IMAGE_ONLY_CONTENT_REGEX.test(inner) ? inner.trim() : whole));
    }
    if (output === before) {
      break;
    }
  }
  return output;
}

// 读取真正的 src 属性（要求属性名前有空白边界，避免把 data-src 当成 src）
function readSrcAttribute(rawAttrs) {
  const match = String(rawAttrs || '').match(/(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (!match) {
    return '';
  }
  return match[1] !== undefined ? match[1] : match[2];
}

// 正文图片只定死一种格式：src + alt + width/height + display:block。
// 其它属性（data-ratio / data-w / data-w-new / class / srcset / data-src …）全部丢弃：
// 读者端（legado 的 HtmlFormatter.formatKeepImg）只要看到 data-src / data-original
// 就会改用那个地址、把我们写在 src 里的 base64 丢掉。
function buildContentImageTag(src) {
  const safeSrc = String(src == null ? '' : src).replace(/"/g, '&quot;');
  return `<img src="${safeSrc}" alt="" width="100%" height="100%" style="display:block">`;
}

// 图片样式合并为块级：保留原有其它声明，只把 display 换成 block
function mergeBlockStyle(value) {
  const parts = String(value || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !/^display\s*:/i.test(part));
  return ['display:block', ...parts].join('; ');
}

function toBlockImageTag(rawAttrs) {
  const attrs = String(rawAttrs || '').trim();
  // 有 src（base64 或按需地址）就统一成固定格式，顺手丢掉其它所有属性
  const src = readSrcAttribute(attrs);
  if (src) {
    return buildContentImageTag(src);
  }
  // 没取到图片（书里没这个资源）：保持原样，只补块级样式
  const styleMatch = attrs.match(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i);
  if (styleMatch) {
    const value = styleMatch[2] !== undefined ? styleMatch[2] : styleMatch[3];
    return `<img ${attrs.replace(styleMatch[0], ` style="${mergeBlockStyle(value)}"`)} />`;
  }
  return attrs ? `<img ${attrs} style="display:block" />` : '<img style="display:block" />';
}

// 正文图片统一改成块级，并在前后补 <br/> 分隔；已在图片旁的 <br/> 不会重复添加
function blockifyContentImages(html) {
  const source = String(html || '');
  const regex = /(?:<br\s*\/?>\s*)?<img\b([^>]*?)\/?>(?:\s*<br\s*\/?>)?/gi;
  let output = '';
  let cursor = 0;
  let lastEndedWithBreak = false;
  let match;
  while ((match = regex.exec(source))) {
    const gap = source.slice(cursor, match.index);
    output += gap;
    // 紧接着上一张图（中间只有空白）时不再重复前置 <br/>
    const needsLeadingBreak = !(lastEndedWithBreak && gap.trim() === '');
    output += `${needsLeadingBreak ? '<br/>' : ''}${toBlockImageTag(match[1])}<br/>`;
    lastEndedWithBreak = true;
    cursor = regex.lastIndex;
  }
  output += source.slice(cursor);
  return output;
}

// ---------------------------------------------------------------------------
// 章节注释：把脚注/尾注（注释）收集起来统一放到章节末尾
// ---------------------------------------------------------------------------

const NOTE_CONTAINER_TAGS = ['div', 'aside', 'section', 'p', 'li', 'blockquote'];
// 行内注释标记（如 <sup><a class="duokan-footnote-item">），不是注释正文
const NOTE_MARKER_PATTERN = /footnote-item|footnote-ref|note-ref|noteref|duokan-footnote-item/i;
const NOTE_WORD_PATTERN = /footnote|endnote|annotation|duokan|zhushi|注释|注解|脚注|尾注|(?:^|[\s_-])note(?:[\s_-]|$)/i;

function escapeRegExp(value) {
  return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 按标签名扫描元素块，处理同名标签嵌套的平衡匹配；只有 accept 命中的块才返回
function scanElementBlocks(html, tagNames, accept) {
  const source = String(html || '');
  const names = tagNames.join('|');
  const pattern = new RegExp(`<(${names})\\b([^>]*?)(/?)>|<\\/(${names})\\s*>`, 'gi');
  const blocks = [];
  const stack = [];
  let match;
  while ((match = pattern.exec(source))) {
    if (match[0].startsWith('</')) {
      const frame = stack.pop();
      if (frame && frame.accepted) {
        blocks.push({
          tagName: frame.tagName,
          rawAttrs: frame.rawAttrs,
          attrs: frame.attrs,
          start: frame.start,
          end: match.index + match[0].length,
          inner: source.slice(frame.innerStart, match.index)
        });
      }
      continue;
    }
    const tagName = match[1];
    const rawAttrs = match[2] || '';
    const selfClosing = match[3] === '/' || /\/\s*$/.test(rawAttrs);
    const attrs = parseAttributes(rawAttrs);
    const accepted = accept(tagName, rawAttrs, attrs);
    if (selfClosing) {
      if (accepted) {
        blocks.push({ tagName, rawAttrs, attrs, start: match.index, end: pattern.lastIndex, inner: '' });
      }
      continue;
    }
    stack.push({ tagName, rawAttrs, attrs, accepted, start: match.index, innerStart: pattern.lastIndex });
  }
  return blocks.sort((a, b) => a.start - b.start);
}

// 是否是注释正文块（本章内的隐藏注释等），排除行内注释标记
function isNoteContainer(tagName, attrs) {
  const type = `${attrs['epub:type'] || ''} ${attrs.role || ''}`;
  const marker = `${attrs.class || ''} ${attrs.id || ''} ${type}`;
  if (NOTE_MARKER_PATTERN.test(marker)) {
    return false;
  }
  if (/(footnote|endnote|annotation|note)/i.test(type)) {
    return true;
  }
  if (!NOTE_WORD_PATTERN.test(marker)) {
    return false;
  }
  // 带 note/注释 关键字的普通标签只在明确是注释容器时才算，避免误伤正文
  return tagName === 'div' || tagName === 'aside' || tagName === 'section' ||
    /注释|注解|脚注|尾注|footnote|endnote/i.test(marker);
}

// 注释正文清理：去掉注号与注释包裹标签、段落转 <br/>、去掉行首注释编号
function normalizeNoteContent(html) {
  let text = String(html || '')
    .replace(/<span\b[^>]*class\s*=\s*["'][^"']*(?:footnote-number|note-number)[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, '');
  // 去掉注释相关的包裹标签，只保留其内容
  for (let pass = 0; pass < 3; pass++) {
    const before = text;
    text = text.replace(
      /<span\b[^>]*class\s*=\s*["'][^"']*(?:duokan-footnote|footnote-text|note-text|footnote-content)[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi,
      '$1'
    );
    if (text === before) {
      break;
    }
  }
  return text
    .replace(/<p\b[^>]*>/gi, '')
    .replace(/<\/p\s*>/gi, '<br/>')
    .replace(/(?:\s*<br\s*\/?>\s*)+/gi, '<br/>')
    .replace(/^(?:\s|<br\s*\/?>)+/i, '')
    .replace(/(?:\s|<br\s*\/?>)+$/i, '')
    .replace(/^[\[(（【]\s*\d{1,3}\s*[\])）】]\s*/, '')
    .replace(/^\d{1,3}[.、]\s+/, '')
    .trim();
}

// 注释标记（承载注释 id 的元素或指向它的链接）在正文里的位置
function findMarkerPosition(html, id) {
  if (!id) {
    return -1;
  }
  const safe = escapeRegExp(id);
  const patterns = [
    new RegExp(`\\sid\\s*=\\s*["']${safe}["']`, 'i'),
    new RegExp(`(?:xlink:)?href\\s*=\\s*["'][^"']*#${safe}["']`, 'i')
  ];
  let position = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match && (position < 0 || match.index < position)) {
      position = match.index;
    }
  }
  return position;
}

// 指向其它 xhtml 的注释链接（注释正文在单独文件里的情况）
function findNoteReferences(html, baseDir, loader) {
  const source = String(html || '');
  const refs = [];
  const anchorRegex = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(source))) {
    const attrs = parseAttributes(match[1]);
    const href = attrs.href || attrs['xlink:href'] || '';
    const hashIndex = href.indexOf('#');
    if (hashIndex <= 0) {
      continue;
    }
    const target = href.slice(0, hashIndex);
    const id = href.slice(hashIndex + 1);
    if (!target || !id || /^(?:data|https?|mailto):/i.test(target)) {
      continue;
    }
    const text = normalizeText(stripTags(match[2]));
    const marker = `${attrs.class || ''} ${attrs.id || ''} ${text}`;
    const isNumberMarker = /^[\[(（【]?\d{1,3}[\])）】]?$/.test(text);
    if (!isNumberMarker && !NOTE_WORD_PATTERN.test(marker)) {
      continue;
    }
    if (!loader.load(target, baseDir)) {
      continue;
    }
    refs.push({ target, id, position: match.index });
  }
  return refs;
}

// 从其它 xhtml 里按 id 取注释正文
function findElementById(html, id) {
  const source = String(html || '');
  if (!id) {
    return '';
  }
  const idPattern = new RegExp(`\\sid\\s*=\\s*["']${escapeRegExp(id)}["']`, 'i');
  const match = idPattern.exec(source);
  if (!match) {
    return '';
  }
  const tagStart = source.lastIndexOf('<', match.index);
  if (tagStart < 0) {
    return '';
  }
  const nameMatch = source.slice(tagStart + 1).match(/^([a-zA-Z][\w:-]*)/);
  if (!nameMatch) {
    return '';
  }
  const block = scanElementBlocks(source.slice(tagStart), [nameMatch[1]], (tagName, rawAttrs) => idPattern.test(rawAttrs))[0];
  return block ? block.inner : '';
}

/**
 * 把章节里的注释挪到章节末尾，返回 { html, notesHtml }：
 * html 为删掉注释块后的正文，notesHtml 形如
 * `<br/>【注释】<br/>[1] 注释一<br/>[2] 注释二<br/>`
 * 编号按注释标记在正文中出现的顺序排列。
 */
function collectChapterNotes(bodyHtml, baseDir, loader, options = {}) {
  const source = String(bodyHtml || '');
  const title = typeof options.notesTitle === 'string' && options.notesTitle.trim()
    ? options.notesTitle.trim()
    : '【注释】';
  const candidates = scanElementBlocks(
    source,
    NOTE_CONTAINER_TAGS,
    (tagName, rawAttrs, attrs) => isNoteContainer(tagName, attrs)
  ).filter((block) => block.inner && block.inner.trim());
  // 嵌套的注释块只保留最外层，避免同一条注释被重复收集
  const blocks = candidates.filter((block) => !candidates.some((other) =>
    other !== block && other.start <= block.start && other.end >= block.end));

  let cleaned = source;
  for (const block of [...blocks].sort((a, b) => b.start - a.start)) {
    cleaned = `${cleaned.slice(0, block.start)}${cleaned.slice(block.end)}`;
  }

  const notes = [];
  const seen = new Set();
  const addNote = (id, content, fallbackPosition) => {
    const text = normalizeNoteContent(content);
    if (!text) {
      return;
    }
    const key = id || `#${fallbackPosition}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    notes.push({ id, content: text, fallbackPosition });
  };

  for (const block of blocks) {
    addNote(block.attrs.id || '', block.inner, block.start);
  }
  for (const ref of findNoteReferences(cleaned, baseDir, loader)) {
    if (!ref.id || seen.has(ref.id)) {
      continue;
    }
    const resource = loader.load(ref.target, baseDir);
    if (resource) {
      addNote(ref.id, findElementById(decodeText(resource.data), ref.id), ref.position);
    }
  }

  if (notes.length === 0) {
    return { html: source, notesHtml: '' };
  }
  for (const note of notes) {
    const position = findMarkerPosition(cleaned, note.id);
    note.position = position >= 0 ? position : note.fallbackPosition;
  }
  notes.sort((a, b) => a.position - b.position);
  const lines = notes.map((note, index) => `[${index + 1}] ${note.content}`);
  return { html: cleaned, notesHtml: `<br/>${title}<br/>${lines.join('<br/>')}<br/>` };
}

// 把章节文档处理成“自包含”的 HTML 片段：内联样式 + 图片内嵌（超预算的改用按需地址）
function inlineResources(documentHtml, baseDir, loader, options, images) {
  const inlineImages = loader.rewritesImages;
  const source = String(documentHtml || '');
  const headMatch = source.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const headStyles = options.inlineStyles === false
    ? ''
    : collectHeadStyles(headMatch ? headMatch[1] : '', baseDir, loader, options, images);
  let output = extractBody(source);

  // 1. 章节注释（脚注/尾注）统一挪到章节末尾，图片类步骤随后会一并处理注释里的图
  if (options.notesToEnd !== false) {
    const collected = collectChapterNotes(output, baseDir, loader, options);
    output = `${collected.html}${collected.notesHtml}`;
  }

  // 2. 仅包含一张图片的 <svg> 包裹，直接替换为 <img> 以简化前端渲染
  output = inlineImages ? output.replace(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/gi, (whole, _svgAttrs, inner) => {
    const imageTag = inner.match(/<image\b([^>]*?)\/?>/i);
    if (!imageTag) {
      return whole;
    }
    const imageAttrs = parseAttributes(imageTag[1]);
    const href = imageAttrs['xlink:href'] || imageAttrs.href || '';
    const resource = href ? loader.loadImage(href, baseDir, images, { from: 'svg' }) : null;
    if (!resource) {
      return whole;
    }
    return buildContentImageTag(resource.src);
  }) : output;

  // 3. <img> 与 SVG <image> 的资源地址改为 base64（或按需地址）
  if (inlineImages) {
    output = output.replace(/<(img|image)\b([^>]*?)\/?>/gi, (whole, tagName, rawAttrs) => {
      const attrs = parseAttributes(rawAttrs);
      const href = pickImageHref(attrs);
      const isImgTag = tagName.toLowerCase() !== 'image';
      // 已经是 data:/http(s)/blob: 的地址不需要从书里取资源
      const localHref = /^(data:|https?:|blob:)/i.test(href) ? '' : href;
      const resource = localHref ? loader.loadImage(localHref, baseDir, images, { from: tagName.toLowerCase() }) : null;
      if (resource) {
        return buildContentImageTag(resource.src);
      }
      // SVG <image> 取不到资源时保持原样
      if (!isImgTag) {
        return whole;
      }
      // 取不到本地资源（外链图片 / 书里没有这个文件）：保留原 src（按需地址或外链），
      // 只输出固定格式，把 data-src / data-original / srcset 这类候选属性一并丢掉
      const fallbackSrc = readSrcAttribute(rawAttrs);
      return fallbackSrc ? buildContentImageTag(fallbackSrc) : stripLazyImageAttributes(whole);
    });
  }

  // 4. style 属性中的 url(...) 同样内嵌
  if (inlineImages) {
    output = output.replace(/style\s*=\s*("([^"]*)"|'([^']*)')/gi, (whole, _raw, dq, sq) => {
      const css = dq !== undefined ? dq : sq;
      const quote = dq !== undefined ? '"' : "'";
      return `style=${quote}${loader.inlineCssUrls(css, baseDir, images)}${quote}`;
    });
  }

  // 5. 正文图片去掉 <sup>/<sub>/<a> 包裹，直接以 <img> 内联展示
  if (options.unwrapImages !== false) {
    output = unwrapImageWrappers(output);
  }

  // 6. 正文图片改成块级样式，并在前后加 <br/> 分隔
  if (options.blockImages !== false) {
    output = blockifyContentImages(output);
  }

  const beforeStyles = headStyles ? `<style>\n${headStyles}\n</style>\n` : '';
  return sanitizeHtml(`${beforeStyles}${output}`);
}

// ---------------------------------------------------------------------------
// 章节合并：标题被拆到不同 xhtml 时（如“第十二章”一页 + “风起云涌”一页）合为一个目录
// ---------------------------------------------------------------------------

function normalizeForCompare(value) {
  return String(value == null ? '' : value).replace(/\s+/g, '').trim();
}

function chapterTextOf(chapter) {
  if (typeof chapter.text === 'string') {
    return chapter.text;
  }
  return htmlToText(chapter.content);
}

// 无正文的章节：没有文本，或只有标题；插图页（含 <img>）视为有内容，不参与合并
function isTitleOnlyChapter(chapter) {
  if (/<img\b/i.test(String(chapter.content || ''))) {
    return false;
  }
  const text = normalizeForCompare(chapterTextOf(chapter));
  if (!text) {
    return true;
  }
  return text === normalizeForCompare(chapter.title);
}

// 把无正文的章节与下一个有正文的章节合并，正文跟在这个目录之后；
// 合并后的标题仍需符合章节规则（与 TXT 章节解析同一套判断）。
function mergeTitleOnlyChapters(chapters, rules, directoryEntries) {
  const merged = [];
  for (const chapter of chapters) {
    let current = chapter;
    while (merged.length > 0) {
      const previous = merged[merged.length - 1];
      // 只处理“上一章没有正文 + 当前章有正文”的情况
      if (!isTitleOnlyChapter(previous) || isTitleOnlyChapter(current)) {
        break;
      }
      const mergedTitle = mergeChapterTitles(previous.title, current.title, rules, directoryEntries);
      if (!mergedTitle) {
        break;
      }
      merged.pop();
      current = {
        ...current,
        title: mergedTitle,
        sourceHrefs: [previous.href, current.href].filter(Boolean)
      };
    }
    merged.push(current);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function buildTocLookup(toc, opfDir) {
  const lookup = new Map();
  for (const item of toc) {
    const key = normalizeHrefKey(joinPath(opfDir, item.href));
    if (!lookup.has(key)) {
      lookup.set(key, item.title);
    }
  }
  return lookup;
}

function parseEpubBuffer(input, options = {}) {
  const settings = {
    inlineImages: options.inlineImages !== false,
    inlineStyles: options.inlineStyles !== false,
    includeText: options.includeText !== false,
    includeChapters: options.includeChapters !== false,
    unwrapImages: options.unwrapImages !== false,
    blockImages: options.blockImages !== false,
    notesToEnd: options.notesToEnd !== false,
    notesTitle: options.notesTitle,
    // 图片：inline=base64（默认，正文自包含，离线也能看）/ url=按需地址 / none=不动
    imageMode: options.imageMode === 'url' || options.imageMode === 'none' || options.imageMode === 'inline'
      ? options.imageMode
      : (options.inlineImages === false ? 'none' : 'inline'),
    imageUrlBase: typeof options.imageUrlBase === 'string' ? options.imageUrlBase : '',
    maxImageBytes: Number.isFinite(options.maxImageBytes) && options.maxImageBytes > 0
      ? options.maxImageBytes
      : IMAGE_LIMITS.maxBytes,
    // 整本内嵌总量上限：默认 0 = 不限（图片一律 base64）；给了正数才会超限降级
    maxInlineImageBytes: Number.isFinite(options.maxInlineImageBytes) && options.maxInlineImageBytes > 0
      ? options.maxInlineImageBytes
      : 0,
    // 只内嵌指定下标的章节（未指定则整本都内嵌）
    imageChapterIndex: Number.isInteger(options.imageChapterIndex) && options.imageChapterIndex >= 0
      ? options.imageChapterIndex
      : null,
    // 或按章节文件路径指定（章节合并后下标可能变化，用 href 更稳）
    imageChapterHref: typeof options.imageChapterHref === 'string' ? options.imageChapterHref : '',
    // 字体等非图片资源默认不内嵌（同一字体被多章引用会重复几十份 base64）
    inlineFonts: options.inlineFonts === true,
    // 超预算资源写盘后返回地址（未保存的解析；已保存的书籍用 imageUrlBase）
    resourceCache: typeof options.resourceCache === 'function' ? options.resourceCache : null,
    // 章节标题规则（与 TXT 解析共用）用于判断拆开的标题能否合并
    rules: options.rules && typeof options.rules === 'object' ? options.rules : getDefaultRules(),
    directoryEntries: Array.isArray(options.directoryEntries) ? options.directoryEntries : [],
    maxChapters: Number.isFinite(options.maxChapters) && options.maxChapters > 0 ? options.maxChapters : Infinity
  };
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const zip = openZip(buffer);

  let opfPath = '';
  const containerData = zip.read('META-INF/container.xml');
  if (containerData) {
    opfPath = parseContainer(decodeText(containerData));
  }
  if (!opfPath || !zip.has(opfPath)) {
    opfPath = zip.names().find((name) => /\.opf$/i.test(name)) || '';
  }
  if (!opfPath) {
    throw new Error('EPUB 中未找到 OPF 文件（缺少 META-INF/container.xml）');
  }

  const opfXml = decodeText(zip.read(opfPath));
  const opfDir = pathDir(opfPath);
  const manifest = parseManifest(opfXml);
  const { refs: spineRefs, tocId } = parseSpine(opfXml, manifest);
  const metadata = parseMetadata(opfXml);
  const guide = parseGuide(opfXml);

  // 目录：优先使用 spine@toc 指定的 NCX，其次查找 nav 文档
  let toc = [];
  const ncxItem = (tocId && manifest.get(tocId)) ||
    [...manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml' || /\.ncx$/i.test(item.href));
  if (ncxItem) {
    const ncxData = zip.read(joinPath(opfDir, ncxItem.href));
    if (ncxData) {
      toc = parseNcxToc(decodeText(ncxData));
    }
  }
  if (toc.length === 0) {
    const navItem = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'));
    if (navItem) {
      const navData = zip.read(joinPath(opfDir, navItem.href));
      if (navData) {
        toc = parseNavToc(decodeText(navData));
      }
    }
  }

  const loader = createResourceLoader(zip, settings);
  const tocLookup = buildTocLookup(toc, opfDir);

  // 封面：meta[name=cover] -> properties="cover-image" -> guide[type=cover] 内的图片
  // 封面不内嵌为 base64，只返回元信息与原始字节，由调用方通过 URL 提供
  let coverMeta = null;
  let coverData = null;
  const coverId = (metadata.metas.find((meta) => (meta.name || '').toLowerCase() === 'cover') || {}).content;
  let coverItem = coverId ? manifest.get(coverId) : null;
  if (!coverItem) {
    coverItem = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('cover-image'));
  }
  if (coverItem) {
    const href = joinPath(opfDir, coverItem.href);
    const data = zip.read(href);
    if (data) {
      coverMeta = {
        href,
        mediaType: coverItem.mediaType || guessMediaType(href) || 'image/jpeg',
        bytes: data.length,
        from: 'manifest'
      };
      coverData = data;
    }
  }
  if (!coverMeta) {
    const coverReference = guide.find((reference) => reference.type === 'cover');
    if (coverReference) {
      const pagePath = joinPath(opfDir, coverReference.href);
      const pageData = zip.read(pagePath);
      if (pageData) {
        const imageMatch = decodeText(pageData).match(/<(?:img|image)\b([^>]*?)\/?>/i);
        const href = imageMatch
          ? (parseAttributes(imageMatch[1]).src ||
            parseAttributes(imageMatch[1])['xlink:href'] ||
            parseAttributes(imageMatch[1]).href)
          : '';
        const resource = href ? loader.load(href, pathDir(pagePath)) : null;
        if (resource) {
          coverMeta = {
            href: resource.href,
            mediaType: resource.mediaType,
            bytes: resource.data.length,
            from: 'guide'
          };
          coverData = resource.data;
        }
      }
    }
  }

  const chapters = [];
  const allImages = [];
  if (settings.includeChapters) {
    for (const ref of spineRefs) {
      if (chapters.length >= settings.maxChapters) {
        break;
      }
      const href = joinPath(opfDir, ref.href);
      const data = zip.read(href);
      if (!data) {
        continue;
      }
      const raw = decodeText(data);
      const body = extractBody(raw);
      const index = chapters.length + 1;
      const tocTitle = tocLookup.get(normalizeHrefKey(href)) || '';
      const title = extractHeadingTitle(body) || tocTitle || `第${index}章`;
      // 配合 imageChapterIndex / imageChapterHref：只给目标章节生成图片数据
      loader.setChapter(index - 1, href);
      const chapterImages = [];
      const chapterHtml = inlineResources(raw, pathDir(href), loader, settings, chapterImages);
      for (const image of chapterImages) {
        if (!allImages.some((existing) => existing.href === image.href)) {
          allImages.push(image);
        }
      }
      const chapter = {
        index,
        id: ref.id,
        href,
        title,
        mediaType: XHTML_MEDIA_TYPES.has(ref.mediaType) ? ref.mediaType : (ref.mediaType || 'application/xhtml+xml'),
        content: chapterHtml,
        images: chapterImages
      };
      if (settings.includeText) {
        chapter.text = htmlToText(chapterHtml);
      }
      chapters.push(chapter);
    }
  }

  // 标题被拆到不同 xhtml 时合并为一个目录（正文跟在这个目录后）
  const mergedChapters = settings.includeChapters
    ? mergeTitleOnlyChapters(chapters, settings.rules, settings.directoryEntries)
    : chapters;
  mergedChapters.forEach((chapter, position) => {
    chapter.index = position + 1;
  });

  const result = {
    title: metadata.title,
    author: metadata.author,
    description: metadata.description,
    language: metadata.language,
    identifier: metadata.identifier,
    publisher: metadata.publisher,
    date: metadata.date,
    cover: coverMeta,
    toc: toc.map((item) => ({ title: item.title, href: joinPath(opfDir, item.href), level: item.level || 0 })),
    chapters: mergedChapters,
    images: allImages,
    stats: {
      entries: zip.names().length,
      spineCount: spineRefs.length,
      chapterCount: mergedChapters.length,
      imageMode: loader.imageMode,
      // 正文里引用的图片张数（base64 或按需地址），以及其中内嵌的
      imageCount: allImages.length,
      inlinedImages: loader.state.inlined,
      imageBytes: loader.state.bytes,
      skippedImages: loader.state.skipped,
      // 字体等非图片资源（同样占用内嵌预算）
      assetCount: loader.state.assetCount,
      assetBytes: loader.state.assetBytes
    }
  };
  // 封面原始字节仅供调用方（主进程）写文件或按 URL 提供，不参与 JSON 序列化
  Object.defineProperty(result, 'coverData', { value: coverData, enumerable: false });
  return result;
}

function parseEpubFile(filePath, options = {}) {
  return parseEpubBuffer(fs.readFileSync(filePath), options);
}

// 按需读取书籍内的单个资源（供 /epub-image 接口使用），href 为书籍内的相对路径
function readEpubResource(input, href) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const target = String(href || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!target || target.split('/').includes('..')) {
    return null;
  }
  const zip = openZip(buffer);
  const data = zip.read(target);
  if (!data) {
    return null;
  }
  return { href: target, mediaType: guessMediaType(target) || 'application/octet-stream', data };
}

module.exports = {
  parseEpubBuffer,
  parseEpubFile,
  readEpubResource,
  openZip,
  readCentralDirectory,
  decodeText,
  htmlToText,
  unwrapImageWrappers,
  blockifyContentImages,
  collectChapterNotes,
  scanElementBlocks,
  mergeTitleOnlyChapters
};
