const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
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
  return IMAGE_MEDIA_TYPES[ext] || '';
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

function createResourceLoader(zip) {
  const cache = new Map();

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

  // sink 为当前章节的图片收集数组，便于前端知道每章内嵌了哪些图片
  function loadImage(href, baseDir, sink, meta = {}) {
    const resource = load(href, baseDir);
    if (!resource) {
      return null;
    }
    if (Array.isArray(sink)) {
      sink.push({
        href: resource.href,
        mediaType: resource.mediaType,
        bytes: resource.data.length,
        ...meta
      });
    }
    return resource;
  }

  // 样式表中的 url(...) 同样替换为 base64，保证背景图也能显示
  function inlineCssUrls(css, baseDir, sink) {
    return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, quote, href) => {
      const value = String(href).trim();
      if (!value || /^(data:|https?:|#|blob:)/i.test(value)) {
        return whole;
      }
      const resource = loadImage(value, baseDir, sink, { from: 'css' });
      return resource ? `url("${resource.dataUri}")` : whole;
    });
  }

  return { load, loadImage, inlineCssUrls };
}

// 处理 <head> 中的本地样式表与 <style>，返回可直接拼进章节内容的 CSS
function collectHeadStyles(headHtml, baseDir, loader, options, images) {
  const inlineImages = options.inlineImages !== false;
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

// 把章节文档处理成“自包含”的 HTML 片段：内联样式 + 图片转 base64 data URI
function inlineResources(documentHtml, baseDir, loader, options, images) {
  const inlineImages = options.inlineImages !== false;
  const source = String(documentHtml || '');
  const headMatch = source.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const headStyles = options.inlineStyles === false
    ? ''
    : collectHeadStyles(headMatch ? headMatch[1] : '', baseDir, loader, options, images);
  let output = extractBody(source);

  // 2. 仅包含一张图片的 <svg> 包裹，直接替换为 <img> 以简化前端渲染
  output = inlineImages ? output.replace(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/gi, (whole, svgAttrs, inner) => {
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
    const svgParsed = parseAttributes(svgAttrs);
    const size = [
      svgParsed.width ? `width="${svgParsed.width}"` : '',
      svgParsed.height ? `height="${svgParsed.height}"` : ''
    ].filter(Boolean).join(' ');
    const alt = imageAttrs.alt ? ` alt="${imageAttrs.alt}"` : ' alt=""';
    return `<img src="${resource.dataUri}"${alt}${size ? ` ${size}` : ''} />`;
  }) : output;

  // 3. <img> 与 SVG <image> 的资源地址改为 base64
  if (inlineImages) {
    output = output.replace(/<(img|image)\b([^>]*?)\/?>/gi, (whole, tagName, rawAttrs) => {
      const attrs = parseAttributes(rawAttrs);
      const href = attrs.src || attrs['xlink:href'] || attrs.href || '';
      if (!href || /^(data:|https?:|blob:)/i.test(href)) {
        return whole;
      }
      const resource = loader.loadImage(href, baseDir, images, { from: tagName.toLowerCase() });
      if (!resource) {
        return whole;
      }
      if (tagName.toLowerCase() === 'image') {
        const alt = attrs.alt ? ` alt="${attrs.alt}"` : ' alt=""';
        return `<img src="${resource.dataUri}"${alt} />`;
      }
      return whole.replace(/src\s*=\s*("([^"]*)"|'([^']*)')/i, `src="${resource.dataUri}"`);
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

  const beforeStyles = headStyles ? `<style>\n${headStyles}\n</style>\n` : '';
  return sanitizeHtml(`${beforeStyles}${output}`);
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

  const loader = createResourceLoader(zip);
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
    chapters,
    images: settings.inlineImages === false ? [] : allImages,
    stats: {
      entries: zip.names().length,
      spineCount: spineRefs.length,
      chapterCount: chapters.length,
      imageCount: settings.inlineImages === false ? 0 : allImages.length
    }
  };
  // 封面原始字节仅供调用方（主进程）写文件或按 URL 提供，不参与 JSON 序列化
  Object.defineProperty(result, 'coverData', { value: coverData, enumerable: false });
  return result;
}

function parseEpubFile(filePath, options = {}) {
  return parseEpubBuffer(fs.readFileSync(filePath), options);
}

module.exports = {
  parseEpubBuffer,
  parseEpubFile,
  openZip,
  readCentralDirectory,
  decodeText,
  htmlToText
};
