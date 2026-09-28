const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { parseEpubBuffer } = require('../epubParser');

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
  assert.ok(result.chapters[0].content.includes('width="100"'));
});

test('throws on a file that is not a zip', () => {
  assert.throws(() => parseEpubBuffer(Buffer.from('not a zip file')), /ZIP/);
});

test('throws when no opf is present', () => {
  const zip = createZip([{ name: 'mimetype', data: 'application/epub+zip' }]);
  assert.throws(() => parseEpubBuffer(zip), /OPF/);
});
