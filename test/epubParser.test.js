const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { parseEpubBuffer, readEpubResource } = require('../epubParser');
const { getDefaultRules } = require('../parseRules');

// --- 图片标签格式：正文图片只允许 src + alt + width/height + display:block ---
const CONTENT_IMAGE_TAG = /^<img src="[^"]*" alt="" width="100%" height="100%" style="display:block">$/;

function assertContentImageTag(tag, label = '') {
  assert.match(String(tag), CONTENT_IMAGE_TAG, `图片只能保留固定属性 ${label}：${tag}`);
  assert.ok(!/\s(data-[\w-]+|class|srcset|style="[^"]*;)/.test(String(tag)), `不应有其它属性 ${label}：${tag}`);
}

// --- 极简 ZIP 打包（仅测试用），支持 store 与 deflate 两种方式 ---
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function createZip(files) {
  const localChunks = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const nameBuffer = Buffer.from(file.name, 'utf8');
    const raw = file.compress ? zlib.deflateRawSync(data) : data;
    const method = file.compress ? 8 : 0;
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(raw.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    localChunks.push(header, nameBuffer, raw);
    directory.push({ nameBuffer, method, crc, compressedSize: raw.length, size: data.length, offset });
    offset += header.length + nameBuffer.length + raw.length;
  }

  const centralChunks = [];
  let centralSize = 0;
  for (const entry of directory) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.nameBuffer.length, 28);
    header.writeUInt32LE(entry.offset, 42);
    centralChunks.push(header, entry.nameBuffer);
    centralSize += header.length + entry.nameBuffer.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(directory.length, 8);
  eocd.writeUInt16LE(directory.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const PNG_BUFFER = Buffer.from(PNG_BASE64, 'base64');
// 1×1 透明 GIF：常见的懒加载占位图
const PLACEHOLDER_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const COVER_BUFFER = Buffer.from(`cover-${PNG_BASE64}`, 'base64');

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const OPF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试书籍</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:description>这是一本用于测试的 EPUB</dc:description>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="bookid">urn:uuid:test-book</dc:identifier>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover-image" href="images/cover.jpg" media-type="image/jpeg"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

const NCX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>第一章 出发</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
    <navPoint id="n2" playOrder="2">
      <navLabel><text>第二章 目录标题</text></navLabel>
      <content src="chapter2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`;

const CHAPTER_1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>ignore me</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
  <body>
    <h1>第一章 出发</h1>
    <p>正文第一段。</p>
    <img src="images/pic.png" alt="插图"/>
    <p style="background-image:url('images/pic.png')">样式背景</p>
    <script>alert('xss')</script>
  </body>
</html>`;

const CHAPTER_2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <p>没有标题的章节</p>
  </body>
</html>`;

const STYLE_CSS = 'body { color: #333; }\n.cover { background-image: url(images/pic.png); }';

function createSampleEpub(overrides = {}) {
  const files = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML, compress: true },
    { name: 'OEBPS/content.opf', data: OPF_XML, compress: true },
    { name: 'OEBPS/toc.ncx', data: NCX_XML, compress: true },
    { name: 'OEBPS/style.css', data: STYLE_CSS, compress: true },
    { name: 'OEBPS/images/cover.jpg', data: COVER_BUFFER },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    { name: 'OEBPS/chapter1.xhtml', data: CHAPTER_1, compress: true },
    { name: 'OEBPS/chapter2.xhtml', data: CHAPTER_2, compress: true }
  ];
  return createZip(overrides.files || files);
}

// 微信读书等导出：真正要显示的地址在 data-src（或 src 是 1×1 占位图）时，
// base64 必须写进真正的 src，否则阅读器上图片不显示
const LAZY_CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1>作者简介</h1>
    <div class="qrbodypic">
      <img alt="" data-ratio="1.304" data-w data-w-new data-src="https://example.com/remote.jpg" src="images/pic.png" class="calibre3"/>
    </div>
    <p><img src="${PLACEHOLDER_GIF}" data-src="images/pic.png" alt="占位图"/></p>
    <p><img data-src="images/pic.png" alt="只有 data-src"/></p>
  </body>
</html>`;

// 取不到本地资源（外链 / data-original 覆盖）时，也必须清掉懒加载候选属性：
// legado 的 HtmlFormatter.formatKeepImg 发现 data-src / data-original 就只会用它
const LAZY_UNRESOLVED_CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <p><img src="https://example.com/remote.jpg" data-src="images/pic.png" srcset="images/pic.png 1x"/></p>
    <p><img src="images/pic.png" data-original="https://example.com/remote.jpg"/></p>
  </body>
</html>`;

function createLazyImageEpub(chapter = LAZY_CHAPTER) {
  return createZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML, compress: true },
    {
      name: 'OEBPS/content.opf',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>懒加载图片</dc:title>
    <dc:identifier id="bookid">urn:uuid:lazy</dc:identifier>
  </metadata>
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`,
      compress: true
    },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    { name: 'OEBPS/chapter1.xhtml', data: chapter, compress: true }
  ]);
}

test('writes the inlined image into the real src, not into data-src', () => {
  const result = parseEpubBuffer(createLazyImageEpub(), { imageMode: 'url', imageUrlBase: '/epub-image?id=1' });
  const [chapter] = result.chapters;
  const tags = chapter.content.match(/<img\b[^>]*>/gi) || [];

  assert.equal(tags.length, 3, `三个 img（实际 ${tags.length}）`);
  // 1. 原样是 data-src + src：src 换成可显示的地址，data-src 这类懒加载候选被清掉
  assert.ok(tags[0].includes('src="/epub-image?id=1&href=OEBPS%2Fimages%2Fpic.png"'), `src 应被改写：${tags[0]}`);
  assert.ok(!tags[0].includes('data-src'), `data-src 应被清掉（否则阅读器可能去取它）：${tags[0]}`);
  // 2. src 是占位图时，用 data-src 指向的本地图片
  assert.ok(!tags[1].includes('src="data:image/gif'), `占位图应被替换：${tags[1]}`);
  assert.ok(tags[1].includes('src="/epub-image?id=1&href=OEBPS%2Fimages%2Fpic.png"'), `占位图替换：${tags[1]}`);
  // 3. 只有 data-src 时补出 src
  assert.ok(tags[2].includes('src="/epub-image?id=1&href=OEBPS%2Fimages%2Fpic.png"'), `补出 src：${tags[2]}`);
  // 三张图都只保留固定属性（data-ratio / class / srcset 等一律丢掉）
  tags.forEach((tag, index) => assertContentImageTag(tag, `第 ${index + 1} 张`));
});

test('inlines lazy loaded images as base64 when within budget', () => {
  const result = parseEpubBuffer(createLazyImageEpub());
  const tags = result.chapters[0].content.match(/<img\b[^>]*>/gi) || [];
  const payload = PNG_BUFFER.toString('base64');

  assert.equal(tags.length, 3);
  assert.ok(tags.every((tag) => tag.includes(`src="data:image/png;base64,${payload}"`)), '三张图都以 base64 内嵌');
  tags.forEach((tag, index) => assertContentImageTag(tag, `第 ${index + 1} 张`));
  // 逐字相等：data-ratio / data-w / data-w-new / class / data-src 等一个都不留
  tags.forEach((tag) => assert.equal(
    tag,
    `<img src="data:image/png;base64,${payload}" alt="" width="100%" height="100%" style="display:block">`,
    `图片只能输出固定格式：${tag}`
  ));
  assert.equal(result.stats.imageCount, 1, '同一张图只记一次（去重后的引用数）');
  assert.equal(result.stats.inlinedImages, 3, '三处引用都做了内嵌');
});

test('strips lazy image attributes even when the resource cannot be resolved', () => {
  const result = parseEpubBuffer(createLazyImageEpub(LAZY_UNRESOLVED_CHAPTER));
  const tags = result.chapters[0].content.match(/<img\b[^>]*>/gi) || [];

  assert.equal(tags.length, 2);
  // 外链取不到本地资源：保留原 src（阅读器至少还能去试试），但清掉 data-src / srcset
  assert.ok(tags[0].includes('src="https://example.com/remote.jpg"'), `src 保持原样：${tags[0]}`);
  assert.ok(!/data-src\s*=/.test(tags[0]), `data-src 应被清掉：${tags[0]}`);
  assert.ok(!/srcset\s*=/.test(tags[0]), `srcset 应被清掉：${tags[0]}`);
  // data-original 会覆盖 src，取不到它时也必须清掉，否则阅读器会去请求那个地址
  assert.ok(!/data-original\s*=/.test(tags[1]), `data-original 应被清掉：${tags[1]}`);
  assert.ok(tags[1].includes('src="data:image/png;base64,'), `本地图片仍内嵌：${tags[1]}`);
  tags.forEach((tag, index) => assertContentImageTag(tag, `第 ${index + 1} 张`));
});

test('parses epub metadata and spine chapters', () => {
  const result = parseEpubBuffer(createSampleEpub());

  assert.equal(result.title, '测试书籍');
  assert.equal(result.author, '测试作者');
  assert.equal(result.description, '这是一本用于测试的 EPUB');
  assert.equal(result.language, 'zh-CN');
  assert.equal(result.identifier, 'urn:uuid:test-book');
  assert.equal(result.chapters.length, 2);
  assert.equal(result.chapters[0].title, '第一章 出发');
  assert.equal(result.chapters[0].href, 'OEBPS/chapter1.xhtml');
  // 无标题时回退到 NCX 目录标题
  assert.equal(result.chapters[1].title, '第二章 目录标题');
  assert.equal(result.toc.length, 2);
  assert.equal(result.toc[1].title, '第二章 目录标题');
});

test('inlines images as base64 data uris', () => {
  const result = parseEpubBuffer(createSampleEpub());
  const [first] = result.chapters;
  const expectedDataUri = `data:image/png;base64,${PNG_BASE64}`;

  assert.ok(!first.content.includes('src="images/pic.png"'), '原始图片地址应被替换');
  assert.ok(first.content.includes(`src="${expectedDataUri}"`), 'img 应内嵌 base64');
  assert.ok(first.content.includes(`url("${expectedDataUri}")`), 'style 中的背景图应内嵌 base64');
  assert.equal(result.stats.imageCount, 1);
  assert.equal(first.images[0].href, 'OEBPS/images/pic.png');
  assert.equal(first.images[0].bytes, PNG_BUFFER.length);
  // 封面图不会被当作章节插图内嵌
  assert.ok(!JSON.stringify(result.chapters).includes('data:image/jpeg'));
});

test('inlines local stylesheet and strips scripts', () => {
  const result = parseEpubBuffer(createSampleEpub());
  const [first] = result.chapters;

  assert.ok(first.content.includes('<style>'), '应内联本地样式表');
  assert.ok(!first.content.includes('<link'), 'link 标签应被移除');
  assert.ok(!first.content.includes('<script'), '脚本应被剔除');
  assert.ok(!first.content.includes('alert('), '脚本内容应被剔除');
  assert.ok(first.text.includes('正文第一段。'), '应生成纯文本内容');
  assert.ok(!first.text.includes('<'), '纯文本不应含标签');
});

test('cover is returned as metadata plus raw bytes, not inlined base64', () => {
  const result = parseEpubBuffer(createSampleEpub());

  assert.ok(result.cover, '应解析出封面');
  assert.equal(result.cover.mediaType, 'image/jpeg');
  assert.equal(result.cover.href, 'OEBPS/images/cover.jpg');
  assert.equal(result.cover.bytes, COVER_BUFFER.length);
  assert.equal(result.cover.dataUri, undefined, '封面不应再生成 data URI');
  assert.equal(result.cover.from, 'manifest');
  // 封面原始字节通过不可枚举属性提供给调用方写文件/按 URL 提供
  assert.ok(Buffer.isBuffer(result.coverData));
  assert.ok(result.coverData.equals(COVER_BUFFER));
  assert.ok(!JSON.stringify(result).includes('data:image/jpeg'), '封面不参与 JSON 序列化');
});

test('extracts only the cover when chapters are not needed', () => {
  const result = parseEpubBuffer(createSampleEpub(), {
    inlineImages: false,
    inlineStyles: false,
    includeText: false,
    includeChapters: false
  });

  assert.equal(result.chapters.length, 0);
  assert.equal(result.stats.chapterCount, 0);
  assert.ok(result.coverData && result.coverData.equals(COVER_BUFFER));
  assert.ok(result.title === '测试书籍', '元数据仍应解析');
  assert.ok(result.toc.length === 2, '目录仍应解析');
});

test('keeps original urls when inlineImages is disabled', () => {
  const result = parseEpubBuffer(createSampleEpub(), { inlineImages: false, inlineStyles: false, includeText: false });
  const [first] = result.chapters;

  assert.ok(first.content.includes('src="images/pic.png"'));
  assert.ok(!first.content.includes('base64,'));
  assert.equal(result.images.length, 0);
  assert.equal(first.images.length, 0);
  assert.equal('text' in first, false);
});

test('falls back to on demand urls when the inline budget is exhausted', () => {
  const epub = createSampleEpub();
  // 预算 1 字节：两张图都会超，但给了按需地址 → 不内嵌，改用 /epub-image
  const result = parseEpubBuffer(epub, {
    imageUrlBase: '/epub-image?id=7',
    maxInlineImageBytes: 1,
    inlineStyles: false
  });
  const [first] = result.chapters;

  assert.equal(result.stats.imageMode, 'inline', '默认仍是内嵌模式');
  assert.equal(result.stats.inlinedImages, 0);
  assert.equal(result.stats.skippedImages, 2, `超预算张数（实际 ${result.stats.skippedImages}）`);
  assert.equal(result.stats.imageBytes, 0);
  assert.ok(!first.content.includes('base64,'), '没有 base64');
  assert.ok(
    first.content.includes('src="/epub-image?id=7&href=OEBPS%2Fimages%2Fpic.png"'),
    `按需地址（实际片段：${(first.content.match(/src="[^"]*"/) || [])[0]}）`
  );
  assert.equal(first.images.length, 2, 'css 背景图也走按需');
  assert.equal(first.images[0].source, 'url');
  assert.ok(first.images[0].bytes > 0, '仍然报出真实字节数');
});

test('skips oversized images when there is no on demand base', () => {
  const result = parseEpubBuffer(createSampleEpub(), { maxImageBytes: 10, inlineStyles: false });
  const [first] = result.chapters;

  assert.equal(result.stats.inlinedImages, 0);
  assert.equal(result.stats.skippedImages, 2);
  assert.ok(!first.content.includes('base64,'), '不会退化回 base64');
  assert.ok(first.content.includes('src="images/pic.png"'), '保留原始相对地址，标签不丢');
});

test('imageMode url serves every image on demand', () => {
  const result = parseEpubBuffer(createSampleEpub(), { imageMode: 'url', imageUrlBase: '/epub-image?id=3' });
  const [first] = result.chapters;

  assert.equal(result.stats.imageMode, 'url');
  assert.equal(result.stats.inlinedImages, 0);
  assert.equal(result.stats.imageCount, 1, '两张引用同一张图时只记一次');
  assert.ok(!first.content.includes('base64,'));
  assert.ok(first.content.includes('/epub-image?id=3&href=OEBPS%2Fimages%2Fpic.png'));
  assert.equal(result.images[0].source, 'url');
});

test('inlines every image by default even when the book is large', () => {
  // 5 张 6 MB 图片（共 30 MB）：默认不设总量上限，应全部内嵌
  // （旧实现的 24 MB 预算会跳过后面两张）
  const crypto = require('crypto');
  const bigImage = () => crypto.randomBytes(6 * 1024 * 1024);
  const chapter = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1>插图页</h1>
    <img src="images/a.jpg"/><img src="images/b.jpg"/><img src="images/c.jpg"/>
    <img src="images/d.jpg"/><img src="images/e.jpg"/>
  </body>
</html>`;
  const epub = createZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML, compress: true },
    {
      name: 'OEBPS/content.opf',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>大图</dc:title><dc:identifier id="bookid">urn:uuid:big</dc:identifier>
  </metadata>
  <manifest><item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`,
      compress: true
    },
    { name: 'OEBPS/images/a.jpg', data: bigImage() },
    { name: 'OEBPS/images/b.jpg', data: bigImage() },
    { name: 'OEBPS/images/c.jpg', data: bigImage() },
    { name: 'OEBPS/images/d.jpg', data: bigImage() },
    { name: 'OEBPS/images/e.jpg', data: bigImage() },
    { name: 'OEBPS/chapter1.xhtml', data: chapter, compress: true }
  ]);
  const result = parseEpubBuffer(epub);

  assert.equal(result.stats.imageCount, 5);
  assert.equal(result.stats.inlinedImages, 5, `五张图全部 base64（实际 ${result.stats.inlinedImages}）`);
  assert.equal(result.stats.skippedImages, 0);
  assert.ok(result.stats.imageBytes >= 30 * 1024 * 1024, `内嵌字节 ${result.stats.imageBytes}`);
  assert.equal((result.chapters[0].content.match(/data:image\/jpeg;base64,/g) || []).length, 5);
});

test('imageChapterIndex only inlines the requested chapter', () => {
  const result = parseEpubBuffer(createSampleEpub(), { imageChapterIndex: 1 });
  const [first, second] = result.chapters;

  assert.equal(result.stats.inlinedImages, 0, '第 2 章没有图片');
  assert.ok(!first.content.includes('base64,'), '未请求的章节不生成图片数据');
  assert.ok(first.content.includes('src="images/pic.png"'), '未请求的章节保留原始标签（结构不变）');
  assert.ok(first.title.includes('第一章'), '标题与章节结构不受影响');
  assert.equal(result.chapters.length, 2);
  assert.ok(second.content.includes('没有标题的章节'));
});

test('readEpubResource reads a single file and rejects traversal', () => {
  const epub = createSampleEpub();
  const resource = readEpubResource(epub, 'OEBPS/images/pic.png');

  assert.ok(resource);
  assert.equal(resource.mediaType, 'image/png');
  assert.ok(resource.data.equals(PNG_BUFFER));
  assert.equal(readEpubResource(epub, '../../etc/passwd'), null, '不允许路径穿越');
  assert.equal(readEpubResource(epub, 'OEBPS/missing.png'), null);
});

test('resolves relative image paths and svg wrappers', () => {
  const files = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF_XML },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h2>SVG 章节</h2>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100">
  <image xlink:href="../OEBPS/images/pic.png" width="100" height="100"/>
</svg>
</body></html>`,
      compress: true
    },
    {
      name: 'OEBPS/chapter2.xhtml',
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>二</p></body></html>'
    }
  ];
  const result = parseEpubBuffer(createZip(files));

  assert.equal(result.chapters[0].title, 'SVG 章节');
  assert.ok(result.chapters[0].content.includes(`<img src="data:image/png;base64,${PNG_BASE64}"`));
  assert.ok(!result.chapters[0].content.includes('<svg'));
  assertContentImageTag(
    (result.chapters[0].content.match(/<img\b[^>]*>/) || [''])[0],
    '（SVG 里的 image 也要用固定格式）'
  );
});

// 单图 SVG 封面页 + 下一章有正文（章节合并会被触发）
function createSvgCoverEpub() {
  return createZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML, compress: true },
    {
      name: 'OEBPS/content.opf',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>SVG 封面</dc:title>
    <dc:identifier id="bookid">urn:uuid:svgcover</dc:identifier>
  </metadata>
  <manifest>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="images/pic.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="cover"/><itemref idref="ch1"/></spine>
</package>`,
      compress: true
    },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    {
      name: 'OEBPS/cover.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 800" width="100%" height="100%">
  <image width="600" height="800" xlink:href="images/pic.png"/>
</svg>
</body></html>`,
      compress: true
    },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>出发</h1>
<p>正文第一段。</p>
<p><img src="images/pic.png" alt="插图"/></p>
</body></html>`,
      compress: true
    }
  ]);
}

test('keeps the chapter structure identical when only one chapter is inlined', () => {
  const epub = createSvgCoverEpub();
  const full = parseEpubBuffer(epub);
  const gated = parseEpubBuffer(epub, {
    imageChapterIndex: 1,
    imageChapterHref: 'OEBPS/chapter1.xhtml'
  });

  // /bookinfo 用的是整本解析的下标，/content 用 imageChapterIndex 只解析那一章：
  // 两者的章节数量与标题必须一致，否则阅读器点开某章拿到的其实是别的章节（图片也不是 base64）
  assert.equal(gated.chapters.length, full.chapters.length, '按章解析不能改变章节数量');
  assert.deepEqual(gated.chapters.map((chapter) => chapter.title), full.chapters.map((chapter) => chapter.title));
  assert.ok(gated.chapters[1].content.includes(`src="data:image/png;base64,${PNG_BASE64}"`), '目标章节内嵌 base64');
  assert.equal(gated.stats.inlinedImages, 1, '只给目标章节生成图片数据');
  // 未请求的章节不内嵌，但 SVG 封面同样换成统一格式的 <img>（地址保持原样）
  assert.ok(gated.chapters[0].content.includes('src="images/pic.png"'), '未请求章节保留原地址');
  assertContentImageTag((gated.chapters[0].content.match(/<img\b[^>]*>/) || [''])[0], '（SVG 封面）');
});

test('unwraps images from sup/a wrappers so they render inline', () => {
  const files = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF_XML },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h2>注释章节</h2>
<p>正文<sup><a href="chapter1.xhtml#fn1" class="duokan-footnote"><img src="images/pic.png" alt="注1"/></a></sup>继续。</p>
<a href="chapter1.xhtml#note"><img src="images/pic.png"/></a>
<p>脚注：<a href="chapter1.xhtml#fn1">[1]</a> 说明文字</p>
</body></html>`,
      compress: true
    },
    {
      name: 'OEBPS/chapter2.xhtml',
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>二</p></body></html>'
    }
  ];
  const result = parseEpubBuffer(createZip(files));
  const content = result.chapters[0].content;

  assert.ok(!/<sup/i.test(content), 'sup 包裹应被去掉');
  assert.ok(!/<a\b/i.test(content) || !content.includes('duokan-footnote'), '图片上的 a 包裹应被去掉');
  assert.ok(!content.includes('<a href="chapter1.xhtml#note"'), '只包图片的链接应被去掉');
  // data:image 后面紧跟的 img 标签应直接位于正文中（不再被 sup/a 套住）
  const imageIndex = content.indexOf('data:image/png;base64,');
  assert.ok(imageIndex > 0);
  assert.ok(content.slice(Math.max(0, imageIndex - 60), imageIndex).includes('<img '), '图片应直接以 img 内联');
  // 带文字的正常链接必须保留
  assert.ok(content.includes('<a href="chapter1.xhtml#fn1">[1]</a>'), '带文字的链接应保留');
});

test('keeps sup/a wrappers when unwrapImages is disabled', () => {
  const files = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF_XML },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: '<html><body><p>正文<sup><a href="#fn1"><img src="images/pic.png"/></a></sup></p></body></html>',
      compress: true
    },
    {
      name: 'OEBPS/chapter2.xhtml',
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>二</p></body></html>'
    }
  ];
  const result = parseEpubBuffer(createZip(files), { unwrapImages: false });
  const content = result.chapters[0].content;

  assert.ok(content.includes('<sup>'), '关闭后应保留原包裹');
  assert.ok(content.includes('<a href="#fn1">'));
});

test('renders body images as blocks separated by <br/>', () => {
  const files = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF_XML },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>图片章节</h1>
<p>正文里有图<img src="images/pic.png" alt="图1"/>后面还有字。</p>
<p><img src="images/pic.png" style="display:inline;width:100%" alt="图2"/></p>
<p>已带换行<br/><img src="images/pic.png" alt="图3"/><br/>结束</p>
<p><img src="images/pic.png" alt="图4"/><img src="images/pic.png" alt="图5"/></p>
</body></html>`,
      compress: true
    },
    {
      name: 'OEBPS/chapter2.xhtml',
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>二</p></body></html>'
    }
  ];
  const content = parseEpubBuffer(createZip(files)).chapters[0].content;

  assert.ok(content.includes('<br/><img '), '图片前应有 <br/> 且图片直接内联');
  assert.ok(/<img\b[^>]*style="display:block"><br\/>/.test(content), '图片后应有 <br/> 与块级样式');
  // 图片格式固定：原有的 style / alt 等一律被固定写法取代
  const tags = content.match(/<img\b[^>]*>/gi) || [];
  assert.equal(tags.length, 5);
  tags.forEach((tag, index) => assertContentImageTag(tag, `第 ${index + 1} 张`));
  assert.ok(!content.includes('display:inline'));
  // 四周本来就有的 <br/> 不会重复叠加
  assert.ok(!content.includes('<br/><br/>'));
  // 每张图前后都各有一个 <br/>
  assert.equal((content.match(/<br\/>\s*<img\b/g) || []).length, tags.length, '每张图前应有 <br/>');
  assert.equal((content.match(/<img\b[^>]*>\s*<br\/>/g) || []).length, tags.length, '每张图后应有 <br/>');
});

test('keeps images untouched when blockImages is disabled', () => {
  const files = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF_XML },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: '<html><body><p>图<img src="images/pic.png" style="display:inline"/></p></body></html>',
      compress: true
    },
    {
      name: 'OEBPS/chapter2.xhtml',
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>二</p></body></html>'
    }
  ];
  const content = parseEpubBuffer(createZip(files), { blockImages: false }).chapters[0].content;

  // blockImages:false 只影响前后的 <br/>，图片标签本身始终是固定格式
  assert.ok(!content.includes('<br/>'));
  assertContentImageTag((content.match(/<img\b[^>]*>/) || [''])[0]);
  assert.ok(content.includes(`src="data:image/png;base64,${PNG_BASE64}"`));
});

test('collects chapter notes and appends them at the end', () => {
  const files = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF_XML },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>注释章节</h1>
<p>第一段<span class="duokan-footnote-item" id="fn1"><sup><a href="#fn1">1</a></sup></span>正文。</p>
<p>第二段<span class="duokan-footnote-item" id="fn2"><sup><a href="#fn2">2</a></sup></span>正文。</p>
<div class="duokan-footnote-content" id="fn2" style="display:none">
  <p class="duokan-footnote-paragraph"><span class="duokan-footnote-number">2</span><span class="duokan-footnote-text">注释二</span></p>
</div>
<div class="duokan-footnote-content" id="fn1" style="display:none">
  <p class="duokan-footnote-paragraph"><span class="duokan-footnote-number">1</span><span class="duokan-footnote-text">注释一</span></p>
</div>
</body></html>`,
      compress: true
    },
    {
      name: 'OEBPS/chapter2.xhtml',
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>二</p></body></html>'
    }
  ];
  const content = parseEpubBuffer(createZip(files)).chapters[0].content;

  assert.ok(content.includes('【注释】'), '应带注释标题');
  assert.ok(content.includes('[1] 注释一'), '注释一应被编号收集');
  assert.ok(content.includes('[2] 注释二'), '注释二应被编号收集');
  // 编号按正文中标记出现的顺序（fn1 的块在后面，但标记在前）
  assert.ok(content.indexOf('[1] 注释一') < content.indexOf('[2] 注释二'));
  // 注释块从正文原位置移除，且出现在章节末尾
  assert.ok(!content.includes('duokan-footnote-content'), '注释块应被移除');
  assert.ok(!content.includes('duokan-footnote-number'), '注释注号应被清理');
  assert.equal(content.split('注释一').length - 1, 1, '注释内容只应出现一次');
  assert.ok(content.indexOf('【注释】') > content.indexOf('第二段'), '注释应在正文之后');
});

test('collects notes that live in a separate xhtml file', () => {
  const files = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF_XML },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>跨文件注释</h1>
<p>正文<a class="noteref" href="notes.xhtml#n1">1</a>继续。</p>
</body></html>`,
      compress: true
    },
    {
      name: 'OEBPS/notes.xhtml',
      data: '<html><body><div id="n1">跨文件注释内容</div></body></html>',
      compress: true
    },
    {
      name: 'OEBPS/chapter2.xhtml',
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>二</p></body></html>'
    }
  ];
  const content = parseEpubBuffer(createZip(files)).chapters[0].content;

  assert.ok(content.includes('【注释】'));
  assert.ok(content.includes('[1] 跨文件注释内容'));
  assert.equal(content.split('跨文件注释内容').length - 1, 1);
  assert.ok(content.indexOf('【注释】') > content.indexOf('继续'));
});

test('keeps notes in place when notesToEnd is disabled', () => {
  const files = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF_XML },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p>正文。</p>
<div class="duokan-footnote-content" id="fn1" style="display:none"><p>注释一</p></div>
</body></html>`,
      compress: true
    },
    {
      name: 'OEBPS/chapter2.xhtml',
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>二</p></body></html>'
    }
  ];
  const content = parseEpubBuffer(createZip(files), { notesToEnd: false, notesTitle: '【本章注释】' }).chapters[0].content;

  assert.ok(content.includes('duokan-footnote-content'), '关闭后注释块应保留在原位');
  assert.ok(!content.includes('【本章注释】'));
});

test('merges a title-only epub chapter with the next chapter', () => {
  const files = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF_XML },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第十二章</h1></body></html>',
      compress: true
    },
    {
      name: 'OEBPS/chapter2.xhtml',
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>风起云涌</h1><p>少年背着行囊出了门。</p></body></html>',
      compress: true
    }
  ];
  const result = parseEpubBuffer(createZip(files), { rules: getDefaultRules() });

  assert.equal(result.chapters.length, 1);
  assert.equal(result.chapters[0].title, '第十二章 风起云涌');
  assert.ok(result.chapters[0].content.includes('少年背着行囊出了门'));
  assert.ok(result.chapters[0].content.includes('风起云涌'));
  assert.equal(result.chapters[0].index, 1);
  assert.deepEqual(result.chapters[0].sourceHrefs, ['OEBPS/chapter1.xhtml', 'OEBPS/chapter2.xhtml']);
  assert.equal(result.stats.chapterCount, 1);
});

test('keeps epub chapters separate when the next title is complete', () => {
  const files = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF_XML },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>序章</h1></body></html>',
      compress: true
    },
    {
      name: 'OEBPS/chapter2.xhtml',
      // 下一章本身已是完整的“第X章”标题，视为独立章节，不合并
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章 出发</h1><p>正文。</p></body></html>',
      compress: true
    }
  ];
  const result = parseEpubBuffer(createZip(files), { rules: getDefaultRules() });

  assert.equal(result.chapters.length, 2);
  assert.equal(result.chapters[0].title, '序章');
  assert.equal(result.chapters[1].title, '第一章 出发');
  assert.equal(result.chapters[1].index, 2);
});

test('keeps image-only epub chapters out of the merge', () => {
  const files = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/content.opf', data: OPF_XML },
    { name: 'OEBPS/images/pic.png', data: PNG_BUFFER },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><img src="images/pic.png"/></body></html>',
      compress: true
    },
    {
      name: 'OEBPS/chapter2.xhtml',
      data: '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>风起云涌</h1><p>正文。</p></body></html>',
      compress: true
    }
  ];
  const result = parseEpubBuffer(createZip(files), { rules: getDefaultRules() });

  assert.equal(result.chapters.length, 2, '插图页应保留为独立章节');
  assert.ok(result.chapters[0].content.includes('data:image/png;base64,'));
  assert.equal(result.chapters[1].title, '风起云涌');
});

test('throws on a file that is not a zip', () => {
  assert.throws(() => parseEpubBuffer(Buffer.from('not a zip file')), /ZIP/);
});

test('throws when no opf is present', () => {
  const zip = createZip([{ name: 'mimetype', data: 'application/epub+zip' }]);
  assert.throws(() => parseEpubBuffer(zip), /OPF/);
});
