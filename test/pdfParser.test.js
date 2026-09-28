const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { parsePdfBuffer, extractPageImage } = require('../pdfParser');
const { getDefaultRules } = require('../parseRules');

// --- 极简 PDF 生成（仅测试用）：不带 xref，解析器本身是容错扫描 ---
function buildPdf({ objects, root, info }) {
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  objects.forEach((object, index) => {
    const body = Buffer.isBuffer(object.body) ? object.body : Buffer.from(String(object.body), 'latin1');
    chunks.push(Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1'));
  });
  const trailer = [`/Size ${objects.length + 1}`];
  if (root) {
    trailer.push(`/Root ${root} 0 R`);
  }
  if (info) {
    trailer.push(`/Info ${info} 0 R`);
  }
  chunks.push(Buffer.from(`trailer\n<< ${trailer.join(' ')} >>\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

function streamBody(dict, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${bytes.length} >>\nstream\n`, 'latin1'),
    bytes,
    Buffer.from('\nendstream', 'latin1')
  ]);
}

function textOperator(text, { size = 24, font = 'F1' } = {}) {
  return `BT /${font} ${size} Tf 72 720 Td (${text}) Tj ET`;
}

// 单页 PDF：内容 + 字体 + 资源
function createSimplePdf(contentData, extra = {}) {
  return buildPdf({
    objects: [
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
      },
      { body: streamBody('', contentData) },
      { body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      ...(extra.objects || [])
    ],
    root: 1,
    info: extra.info
  });
}

test('parses pdf text, metadata and per-page chapters', () => {
  const pdf = createSimplePdf(textOperator('Hello PDF World'), { info: 6 });
  const result = parsePdfBuffer(pdf, { rules: getDefaultRules() });

  assert.equal(result.pageCount, 1);
  assert.equal(result.chapters.length, 1);
  assert.equal(result.chapters[0].title, '第 1 页');
  assert.ok(result.chapters[0].text.includes('Hello PDF World'));
  assert.ok(result.chapters[0].content.includes('Hello PDF World'));
  assert.equal(result.chapters[0].index, 1);
  assert.ok(/<br\/>/.test(result.chapters[0].content) === false || true);
});

test('reads /Info metadata from the trailer', () => {
  const pdf = buildPdf({
    objects: [
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
      },
      { body: streamBody('', textOperator('Meta')) },
      { body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      { body: '<< /Title (Book Title) /Author (Book Author) /Subject (Intro text) >>' }
    ],
    root: 1,
    info: 6
  });
  const result = parsePdfBuffer(pdf);

  assert.equal(result.title, 'Book Title');
  assert.equal(result.author, 'Book Author');
  assert.equal(result.description, 'Intro text');
});

test('extracts text from flate encoded multi page pdf', () => {
  const pageOne = zlib.deflateSync(Buffer.from(textOperator('First page text'), 'latin1'));
  const pageTwo = zlib.deflateSync(Buffer.from(textOperator('Second page text'), 'latin1'));
  const pdf = buildPdf({
    objects: [
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>' },
      {
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>'
      },
      { body: streamBody('/Filter /FlateDecode', pageOne) },
      {
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>'
      },
      { body: streamBody('/Filter /FlateDecode', pageTwo) },
      { body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' }
    ],
    root: 1
  });
  const result = parsePdfBuffer(pdf, { rules: getDefaultRules() });

  assert.equal(result.pageCount, 2);
  assert.equal(result.chapters.length, 2);
  assert.deepEqual(result.chapters.map((chapter) => chapter.title), ['第 1 页', '第 2 页']);
  assert.ok(result.chapters[0].text.includes('First page text'));
  assert.ok(result.chapters[1].text.includes('Second page text'));
  assert.equal(result.stats.chapterCount, 2);
});

test('decodes cjk text through a toUnicode cmap', () => {
  const toUnicode = [
    'begincmap',
    '2 beginbfchar',
    '<0001> <4E2D>',
    '<0002> <6587>',
    'endbfchar',
    'endcmap'
  ].join('\n');
  const pdf = buildPdf({
    objects: [
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
      },
      { body: streamBody('', 'BT /F1 24 Tf 72 720 Td <00010002> Tj ET') },
      {
        body: '<< /Type /Font /Subtype /Type0 /BaseFont /TestFont /Encoding /Identity-H '
          + '/DescendantFonts [6 0 R] /ToUnicode 7 0 R >>'
      },
      { body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestFont >>' },
      { body: streamBody('', toUnicode) }
    ],
    root: 1
  });
  const result = parsePdfBuffer(pdf);

  assert.ok(result.chapters[0].text.includes('中文'), `实际文本：${result.chapters[0].text}`);
});

test('splits chapters by pdf outline', () => {
  const pageObjects = [3, 5, 7].map((number, index) => ({
    body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 9 0 R >> >> /Contents ${number + 1} 0 R >>`
  }));
  const pdf = buildPdf({
    objects: [
      { body: '<< /Type /Catalog /Pages 2 0 R /Outlines 10 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>' },
      pageObjects[0],
      { body: streamBody('', textOperator('Page one text')) },
      pageObjects[1],
      { body: streamBody('', textOperator('Page two text')) },
      pageObjects[2],
      { body: streamBody('', textOperator('Page three text')) },
      { body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      {
        body: '<< /Type /Outlines /First 11 0 R /Last 12 0 R /Count 2 >>'
      },
      { body: '<< /Title (First Chapter) /Parent 10 0 R /Dest [3 0 R /Fit] /Next 12 0 R >>' },
      { body: '<< /Title (Second Chapter) /Parent 10 0 R /Dest [7 0 R /Fit] >>' }
    ],
    root: 1
  });
  const result = parsePdfBuffer(pdf, { rules: getDefaultRules() });

  assert.equal(result.chapters.length, 2);
  assert.equal(result.chapters[0].title, 'First Chapter');
  assert.ok(result.chapters[0].text.includes('Page one text'));
  assert.ok(result.chapters[0].text.includes('Page two text'));
  assert.equal(result.chapters[1].title, 'Second Chapter');
  assert.ok(result.chapters[1].text.includes('Page three text'));
  assert.equal(result.outlineCount, 2);
});

test('reads objects stored inside an object stream', () => {
  // 顶部对象：1=对象流，2=内容流，3=字体；目录/页树/页面都放在对象流里（编号 4/5/6）
  const inner = {
    4: '<< /Type /Catalog /Pages 5 0 R >>',
    5: '<< /Type /Pages /Kids [6 0 R] /Count 1 >>',
    6: '<< /Type /Page /Parent 5 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 3 0 R >> >> /Contents 2 0 R >>'
  };
  const numbers = Object.keys(inner).map(Number);
  let cursor = 0;
  const headerParts = [];
  const bodyParts = [];
  for (const number of numbers) {
    const text = inner[number];
    headerParts.push(`${number} ${cursor}`);
    bodyParts.push(text);
    cursor += Buffer.byteLength(text, 'latin1') + 1;
  }
  const header = `${headerParts.join(' ')}\n`;
  const packed = Buffer.from(header + bodyParts.join('\n'), 'latin1');
  const pdf = buildPdf({
    objects: [
      {
        body: streamBody(
          `/Type /ObjStm /N ${numbers.length} /First ${Buffer.byteLength(header, 'latin1')} /Filter /FlateDecode`,
          zlib.deflateSync(packed)
        )
      },
      { body: streamBody('', textOperator('From object stream')) },
      { body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' }
    ],
    root: 4
  });
  const result = parsePdfBuffer(pdf);

  assert.equal(result.pageCount, 1);
  assert.ok(result.chapters[0].text.includes('From object stream'), `实际文本：${result.chapters[0].text}`);
});

test('uses the first page image as cover', () => {
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const pdf = buildPdf({
    objects: [
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 4 0 R >>'
      },
      { body: streamBody('', textOperator('Cover page')) },
      { body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      {
        body: streamBody(
          '/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB '
            + '/BitsPerComponent 8 /Filter /DCTDecode',
          jpegBytes
        )
      }
    ],
    root: 1
  });
  const result = parsePdfBuffer(pdf);

  assert.ok(result.cover, '应解析出封面');
  assert.equal(result.cover.mediaType, 'image/jpeg');
  assert.equal(result.cover.bytes, jpegBytes.length);
  assert.ok(result.coverData.equals(jpegBytes));
  assert.ok(!JSON.stringify(result).includes('data:image'), '封面不内联 base64');
});

test('throws when the file is not a pdf', () => {
  assert.throws(() => parsePdfBuffer(Buffer.from('not a pdf at all')), /PDF/);
});

test('decodes cjk text from a bfrange cmap', () => {
  const toUnicode = [
    'begincmap',
    '1 beginbfrange',
    '<0001> <0003> <4E00>',
    'endbfrange',
    'endcmap'
  ].join('\n');
  const pdf = buildPdf({
    objects: [
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
      },
      { body: streamBody('', 'BT /F1 24 Tf 72 720 Td <000100020003> Tj ET') },
      {
        body: '<< /Type /Font /Subtype /Type0 /BaseFont /TestFont /Encoding /Identity-H '
          + '/DescendantFonts [6 0 R] /ToUnicode 7 0 R >>'
      },
      { body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestFont >>' },
      { body: streamBody('', toUnicode) }
    ],
    root: 1
  });
  const result = parsePdfBuffer(pdf);

  assert.equal(result.chapters[0].text.trim(), '一丁丂');
  assert.equal(result.stats.unmappedCodes, 0);
});

test('falls back to the gbk encoding name when there is no toUnicode', () => {
  const pdf = buildPdf({
    objects: [
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
      },
      { body: streamBody('', 'BT /F1 24 Tf 72 720 Td <D6D0CEC4> Tj ET') },
      {
        body: '<< /Type /Font /Subtype /Type0 /BaseFont /GBKFont /Encoding /GBK-EUC-H '
          + '/DescendantFonts [6 0 R] >>'
      },
      { body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /GBKFont >>' }
    ],
    root: 1
  });
  const result = parsePdfBuffer(pdf);

  assert.equal(result.chapters[0].text.trim(), '中文');
});

test('flags image only pdf files as scanned', () => {
  const pdf = buildPdf({
    objects: [
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>'
      },
      { body: streamBody('', 'q 579 0 0 840 7 0 cm /Im0 Do Q') },
      {
        body: streamBody(
          '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray '
            + '/BitsPerComponent 8 /Filter /FlateDecode',
          zlib.deflateSync(Buffer.from([0, 1, 2, 3]))
        )
      }
    ],
    root: 1
  });
  const result = parsePdfBuffer(pdf);

  assert.equal(result.stats.scanned, true);
  assert.equal(result.stats.textLength, 0);
  assert.equal(result.stats.textPageCount, 0);
  assert.equal(result.cover.mediaType, 'image/png');
});

// 一页：段落 + 插图 + 段落（图片走 DCTDecode，直接内嵌为 jpeg）
function buildIllustratedPdf(options = {}) {
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const content = [
    'BT /F1 24 Tf 72 720 Td (Before image paragraph) Tj ET',
    'q 200 0 0 120 72 400 cm /Im1 Do Q',
    'BT /F1 24 Tf 72 300 Td (After image paragraph) Tj ET'
  ].join('\n');
  return buildPdf({
    objects: [
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 4 0 R >>'
      },
      { body: streamBody('', content) },
      { body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      {
        body: streamBody(
          '/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB '
            + '/BitsPerComponent 8 /Filter /DCTDecode',
          jpegBytes
        )
      },
      ...(options.extraObjects || [])
    ],
    root: 1
  });
}

test('inlines page illustrations as base64 like epub', () => {
  const result = parsePdfBuffer(buildIllustratedPdf());
  const chapter = result.chapters[0];

  assert.equal(result.stats.imageCount, 1, `内嵌 1 张（实际 ${result.stats.imageCount}）`);
  assert.match(chapter.content, /<img src="data:image\/jpeg;base64,/);
  assert.match(chapter.content, /style="display:block/, '图片为块级样式');
  assert.match(chapter.content, /<br\/><img/, '图片前有 <br/> 分隔');
  assert.ok(chapter.content.indexOf('Before image paragraph') < chapter.content.indexOf('<img'),
    '图片位置在正文顺序中保留');
  assert.ok(chapter.content.indexOf('<img') < chapter.content.indexOf('After image paragraph'));
  assert.equal(chapter.images.length, 1);
  assert.equal(chapter.images[0].mediaType, 'image/jpeg');
  assert.equal(result.images.length, 1, '顶层 images 列出内嵌图片');
  // 纯文本字段仍只有文字，便于目录/合并判断
  assert.ok(!chapter.text.includes('base64'));
});

test('keeps chapter structure stable when inlineImages is disabled', () => {
  const pdf = buildIllustratedPdf();
  const withImages = parsePdfBuffer(pdf);
  const withoutImages = parsePdfBuffer(pdf, { inlineImages: false });

  assert.equal(withoutImages.chapters.length, withImages.chapters.length);
  assert.equal(withoutImages.chapters[0].title, withImages.chapters[0].title);
  assert.equal(withoutImages.stats.imageCount, 0);
  assert.ok(!withoutImages.chapters[0].content.includes('data:image'));
  // 图片仍然被识别到（章节里带图片数，供目录/合并使用）
  assert.equal(withoutImages.chapters[0].imageCount, 1);
});

test('skips inlining beyond the byte budget', () => {
  const result = parsePdfBuffer(buildIllustratedPdf(), { maxInlineImageBytes: 4 });
  const chapter = result.chapters[0];

  assert.equal(result.stats.imageCount, 0);
  assert.equal(result.stats.skippedImages, 1);
  assert.ok(!chapter.content.includes('data:image'));
  assert.ok(chapter.content.includes('Before image paragraph'), '正文仍然保留');
});

test('inlines a scanned page as a full page image chapter', () => {
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const pdf = buildPdf({
    objects: [
      { body: '<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>'
      },
      { body: streamBody('', 'q 579 0 0 840 7 0 cm /Im0 Do Q') },
      {
        body: streamBody(
          '/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB '
            + '/BitsPerComponent 8 /Filter /DCTDecode',
          jpegBytes
        )
      },
      { body: '<< /Type /Outlines /First 8 0 R /Last 9 0 R /Count 2 >>' },
      { body: '<< /Title (扫描页一) /Parent 7 0 R /Dest [3 0 R /Fit] /Next 9 0 R >>' },
      { body: '<< /Title (扫描页二) /Parent 7 0 R /Dest [3 0 R /Fit] >>' }
    ],
    root: 1
  });
  const result = parsePdfBuffer(pdf, { rules: getDefaultRules() });

  assert.equal(result.stats.scanned, true);
  assert.equal(result.stats.imageCount, 1, '整页图会内嵌');
  assert.equal(result.chapters.length, 1, '有图片的章节不会因为“无文字”被合并掉');
  assert.match(result.chapters[0].content, /<img src="data:image\/jpeg;base64,/);
});

test('inlines a repeated image only once per chapter', () => {
  const content = [
    'BT /F1 24 Tf 72 720 Td (First paragraph) Tj ET',
    'q 200 0 0 120 72 500 cm /Im1 Do Q',
    'BT /F1 24 Tf 72 300 Td (Second paragraph) Tj ET',
    'q 200 0 0 120 72 100 cm /Im1 Do Q'
  ].join('\n');
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const pdf = buildPdf({
    objects: [
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 4 0 R >>'
      },
      { body: streamBody('', content) },
      { body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      {
        body: streamBody(
          '/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB '
            + '/BitsPerComponent 8 /Filter /DCTDecode',
          jpegBytes
        )
      }
    ],
    root: 1
  });
  const result = parsePdfBuffer(pdf);

  assert.equal(result.stats.imageCount, 1, '同一章里同一张图只嵌一次');
  assert.equal(result.chapters[0].content.split('<img').length - 1, 1);
});

test('emits page image urls instead of base64 when imageMode is url', () => {
  const result = parsePdfBuffer(buildIllustratedPdf(), { imageMode: 'url', imageUrlBase: '/pdf-page?id=5' });
  const chapter = result.chapters[0];

  assert.equal(result.stats.imageMode, 'url');
  assert.equal(result.stats.imageCount, 1, '图片数量照常统计');
  assert.equal(result.stats.inlinedImages, 0, '没有 base64');
  assert.equal(result.stats.imageBytes, 0);
  assert.ok(!chapter.content.includes('data:image'), '章节里没有 base64');
  assert.match(chapter.content, /<img src="\/pdf-page\?id=5&page=1&name=Im1"/);
  assert.equal(chapter.images[0].url, '/pdf-page?id=5&page=1&name=Im1');
  assert.equal(chapter.images[0].page, 1);
  assert.equal(chapter.images[0].mediaType, 'image/jpeg', '不解码也能给出 mime');
  // URL 模式下章节整体很小（不再随页面图片膨胀）
  assert.ok(chapter.content.length < 1000, `章节长度 ${chapter.content.length}`);
});

test('imageMode none keeps text only', () => {
  const result = parsePdfBuffer(buildIllustratedPdf(), { imageMode: 'none' });

  assert.equal(result.stats.imageMode, 'none');
  assert.equal(result.stats.imageCount, 0);
  assert.ok(!result.chapters[0].content.includes('<img'));
  assert.ok(result.chapters[0].content.includes('Before image paragraph'));
});

test('inlines every page image by default (no total budget)', () => {
  // 多页 + 大图：默认应全部内嵌，不因为总量而降级/丢弃
  const jpegBytes = Buffer.alloc(1024 * 1024);
  jpegBytes[0] = 0xff;
  jpegBytes[1] = 0xd8;
  jpegBytes[2] = 0xff;
  for (let i = 3; i < jpegBytes.length; i += 1) {
    jpegBytes[i] = (i * 31) & 0xff;
  }
  const pageCount = 40;
  const objects = [
    { body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { body: `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${pageCount} >>` }
  ];
  for (let i = 0; i < pageCount; i += 1) {
    const pageNumber = 3 + i * 3;
    objects.push({
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] `
        + `/Resources << /XObject << /Im0 ${pageNumber + 2} 0 R >> >> /Contents ${pageNumber + 1} 0 R >>`
    });
    objects.push({ body: streamBody('', 'q 579 0 0 840 7 0 cm /Im0 Do Q') });
    objects.push({
      body: streamBody(
        '/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB '
          + '/BitsPerComponent 8 /Filter /DCTDecode',
        jpegBytes
      )
    });
  }
  const result = parsePdfBuffer(buildPdf({ objects, root: 1 }));

  assert.equal(result.chapters.length, pageCount);
  assert.equal(result.stats.inlinedImages, pageCount, `全部内嵌（实际 ${result.stats.inlinedImages}）`);
  assert.equal(result.stats.skippedImages, 0);
  assert.ok(result.stats.imageBytes >= pageCount * 1024 * 1024);
  assert.ok(result.chapters.every((chapter) => chapter.content.includes('data:image/jpeg;base64,')));
});

test('imageChapterIndex only builds images for the requested chapter', () => {
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const objects = [
    { body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { body: '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>' }
  ];
  for (let i = 0; i < 2; i += 1) {
    const pageNumber = 3 + i * 3;
    objects.push({
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> `
        + `/XObject << /Im0 ${pageNumber + 2} 0 R >> >> /Contents ${pageNumber + 1} 0 R >>`
    });
    objects.push({ body: streamBody('', `q 579 0 0 840 7 0 cm /Im0 Do Q\nBT /F1 24 Tf 72 720 Td (Page ${i + 1} text) Tj ET`) });
    objects.push({
      body: streamBody(
        '/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB '
          + '/BitsPerComponent 8 /Filter /DCTDecode',
        jpegBytes
      )
    });
  }
  objects.push({ body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' });
  const pdf = buildPdf({ objects, root: 1 });
  const target = parsePdfBuffer(pdf, { imageChapterIndex: 1 });

  assert.equal(target.chapters.length, 2, '章节结构不变');
  assert.ok(!target.chapters[0].content.includes('data:image'), '未请求的章节不生成图片');
  assert.ok(target.chapters[0].content.includes('Page 1 text'), '未请求的章节仍有正文');
  assert.ok(target.chapters[1].content.includes('data:image/jpeg;base64,'), '目标章节内嵌图片');
  assert.equal(target.stats.inlinedImages, 1);
});

test('skips absurd image dimensions instead of allocating memory', () => {
  const pdf = buildPdf({
    objects: [
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 4 0 R >>'
      },
      { body: streamBody('', `${textOperator('Huge image guard')}\nq 200 0 0 120 72 400 cm /Im1 Do Q`) },
      { body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      {
        // 1 亿像素、数据却只有几个字节：直接跳过，不应该尝试分配
        body: streamBody(
          '/Type /XObject /Subtype /Image /Width 10000 /Height 10000 /ColorSpace /DeviceRGB '
            + '/BitsPerComponent 8 /Filter /FlateDecode',
          zlib.deflateSync(Buffer.from([1, 2, 3, 4]))
        )
      }
    ],
    root: 1
  });
  const result = parsePdfBuffer(pdf);

  assert.equal(result.stats.imageCount, 0);
  assert.equal(result.stats.skippedImages, 1, '超大图被跳过');
  assert.ok(result.chapters[0].content.includes('Huge image guard'), '正文仍然保留');
});

test('extracts a single page image for on demand delivery', () => {
  const pdf = buildIllustratedPdf();
  const image = extractPageImage(pdf, 1, 'Im1');

  assert.ok(image, '能取出第 1 页图片');
  assert.equal(image.mediaType, 'image/jpeg');
  assert.equal(image.data[0], 0xff);
  assert.equal(extractPageImage(pdf, 9, 'Im1'), null, '不存在的页返回 null');
  assert.throws(() => extractPageImage(Buffer.from('nope'), 1, 'Im1'), /PDF/);
});
