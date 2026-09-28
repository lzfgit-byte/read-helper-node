const fs = require('fs');
const zlib = require('zlib');
const { getDefaultRules, mergeChapterTitles } = require('./parseRules');

// ---------------------------------------------------------------------------
// PDF 解析（零依赖）：容错扫描对象 + 对象流 + Flate 解压 + 正文文本抽取 + 分章
// 与 epubParser 返回结构保持一致，便于主进程按同一条链路处理。
// ---------------------------------------------------------------------------

const PDF_WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const PDF_DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
// 段落结束标点：上一行以此结尾时不再与下一行合并
const PARAGRAPH_END_PATTERN = /[。！？；：…—”"'）】》」』〕）\]\)．.!?;]$/;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

// Electron 26 内置 Node 18 没有 zlib.crc32，这里自带实现
function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

// 8bit 灰度（colorType 0）/ RGB（colorType 2）像素 → PNG
function encodePng(width, height, colorType, pixels) {
  const channels = colorType === 0 ? 1 : 3;
  const rowLength = width * channels;
  const raw = Buffer.alloc((rowLength + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const target = y * (rowLength + 1);
    raw[target] = 0; // filter: none
    pixels.copy(raw, target + 1, y * rowLength, (y + 1) * rowLength);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// PDF 语法解析
// ---------------------------------------------------------------------------

function isWhiteByte(byte) {
  return PDF_WHITESPACE.has(byte);
}

function isDelimiterByte(byte) {
  return PDF_DELIMITERS.has(byte);
}

// 极简 PDF 值解析器（dict / array / name / string / number / ref / bool / null）
function createPdfSyntax(buffer) {
  let pos = 0;

  function skipWhitespace() {
    while (pos < buffer.length) {
      const byte = buffer[pos];
      if (isWhiteByte(byte)) {
        pos += 1;
        continue;
      }
      if (byte === 0x25) { // % 注释
        while (pos < buffer.length && buffer[pos] !== 0x0a && buffer[pos] !== 0x0d) {
          pos += 1;
        }
        continue;
      }
      break;
    }
  }

  function peek() {
    return buffer[pos];
  }

  function readName() {
    pos += 1; // '/'
    let name = '';
    while (pos < buffer.length) {
      const byte = buffer[pos];
      if (isWhiteByte(byte) || isDelimiterByte(byte)) {
        break;
      }
      if (byte === 0x23 && pos + 2 < buffer.length) { // #xx 转义
        const hex = buffer.toString('latin1', pos + 1, pos + 3);
        if (/^[0-9a-f]{2}$/i.test(hex)) {
          name += String.fromCharCode(parseInt(hex, 16));
          pos += 3;
          continue;
        }
      }
      name += String.fromCharCode(byte);
      pos += 1;
    }
    return { type: 'name', value: name };
  }

  function readLiteralString() {
    pos += 1; // '('
    const bytes = [];
    let depth = 1;
    while (pos < buffer.length) {
      const byte = buffer[pos];
      if (byte === 0x5c) { // 反斜杠转义
        pos += 1;
        const next = buffer[pos];
        const simple = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c };
        if (next === undefined) {
          break;
        }
        if (simple[next] !== undefined) {
          bytes.push(simple[next]);
          pos += 1;
          continue;
        }
        if (next >= 0x30 && next <= 0x37) { // 八进制
          let octal = '';
          while (octal.length < 3 && buffer[pos] >= 0x30 && buffer[pos] <= 0x37) {
            octal += String.fromCharCode(buffer[pos]);
            pos += 1;
          }
          bytes.push(parseInt(octal, 8) & 0xff);
          continue;
        }
        if (next === 0x0a) { // 续行
          pos += 1;
          continue;
        }
        bytes.push(next);
        pos += 1;
        continue;
      }
      if (byte === 0x28) {
        depth += 1;
      } else if (byte === 0x29) {
        depth -= 1;
        if (depth === 0) {
          pos += 1;
          break;
        }
      }
      bytes.push(byte);
      pos += 1;
    }
    return { type: 'string', bytes: Buffer.from(bytes) };
  }

  function readHexString() {
    pos += 1; // '<'
    let hex = '';
    while (pos < buffer.length && buffer[pos] !== 0x3e) {
      const char = buffer.toString('latin1', pos, pos + 1);
      if (/[0-9a-f]/i.test(char)) {
        hex += char;
      }
      pos += 1;
    }
    pos += 1; // '>'
    if (hex.length % 2 === 1) {
      hex += '0';
    }
    return { type: 'string', bytes: Buffer.from(hex, 'hex') };
  }

  function readNumber() {
    const start = pos;
    while (pos < buffer.length) {
      const byte = buffer[pos];
      if ((byte >= 0x30 && byte <= 0x39) || byte === 0x2b || byte === 0x2d || byte === 0x2e) {
        pos += 1;
        continue;
      }
      break;
    }
    const text = buffer.toString('latin1', start, pos);
    const value = Number.parseFloat(text);
    return Number.isFinite(value) ? value : 0;
  }

  function readKeyword() {
    const start = pos;
    while (pos < buffer.length && !isWhiteByte(buffer[pos]) && !isDelimiterByte(buffer[pos])) {
      pos += 1;
    }
    return buffer.toString('latin1', start, pos);
  }

  function parseValue(depth = 0) {
    if (depth > 32) {
      return null;
    }
    skipWhitespace();
    const byte = peek();
    if (byte === undefined) {
      return null;
    }
    if (byte === 0x2f) {
      return readName();
    }
    if (byte === 0x28) {
      return readLiteralString();
    }
    if (byte === 0x3c) {
      if (buffer[pos + 1] === 0x3c) {
        pos += 2;
        const dict = {};
        while (true) {
          skipWhitespace();
          if (peek() === 0x3e && buffer[pos + 1] === 0x3e) {
            pos += 2;
            break;
          }
          if (peek() === undefined) {
            break;
          }
          const key = parseValue(depth + 1);
          if (!key || key.type !== 'name') {
            // 键不是名字时跳过该 token，避免死循环
            if (!key) {
              pos += 1;
            }
            continue;
          }
          dict[key.value] = parseValue(depth + 1);
        }
        return dict;
      }
      return readHexString();
    }
    if (byte === 0x5b) {
      pos += 1;
      const array = [];
      while (true) {
        skipWhitespace();
        if (peek() === 0x5d) {
          pos += 1;
          break;
        }
        if (peek() === undefined) {
          break;
        }
        array.push(parseValue(depth + 1));
      }
      return array;
    }
    if ((byte >= 0x30 && byte <= 0x39) || byte === 0x2b || byte === 0x2d || byte === 0x2e) {
      const start = pos;
      const value = readNumber();
      // 可能是间接引用：数字 数字 R
      const saved = pos;
      skipWhitespace();
      const secondByte = peek();
      if (secondByte !== undefined && secondByte >= 0x30 && secondByte <= 0x39) {
        const second = readNumber();
        skipWhitespace();
        if (!Number.isInteger(value) || !Number.isInteger(second)) {
          pos = saved;
          return value;
        }
        if (peek() === 0x52 && (isWhiteByte(buffer[pos + 1]) || isDelimiterByte(buffer[pos + 1]) || buffer[pos + 1] === undefined)) {
          pos += 1;
          return { ref: value, gen: second };
        }
        pos = saved;
        return value;
      }
      pos = start === pos ? pos : saved;
      return value;
    }
    const keyword = readKeyword();
    if (keyword === 'true') {
      return true;
    }
    if (keyword === 'false') {
      return false;
    }
    if (keyword === 'null') {
      return null;
    }
    return { type: 'keyword', value: keyword };
  }

  return {
    parseValue,
    skipWhitespace,
    readKeyword,
    peek,
    offset: () => pos,
    seek: (next) => { pos = next; }
  };
}

function nameValue(value) {
  if (value && value.type === 'name') {
    return value.value;
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

function isStream(value) {
  return Boolean(value && typeof value === 'object' && value.stream === true);
}

function toArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------
// 对象扫描（含对象流 /ObjStm）
// ---------------------------------------------------------------------------

function scanPdfObjects(buffer) {
  const objects = new Map();
  const latin = buffer.toString('latin1');
  const objectRegex = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  let match;
  while ((match = objectRegex.exec(latin))) {
    const objectNumber = Number(match[1]);
    const syntax = createPdfSyntax(buffer);
    syntax.seek(match.index + match[0].length);
    const value = syntax.parseValue();
    syntax.skipWhitespace();
    let streamData = null;
    let afterStream = syntax.offset();
    if (latin.startsWith('stream', afterStream)) {
      let dataStart = afterStream + 'stream'.length;
      if (buffer[dataStart] === 0x0d) {
        dataStart += 1;
      }
      if (buffer[dataStart] === 0x0a) {
        dataStart += 1;
      }
      const lengthValue = value && typeof value === 'object' && !Array.isArray(value) ? value.Length : null;
      if (typeof lengthValue === 'number' && lengthValue >= 0 && dataStart + lengthValue <= buffer.length) {
        streamData = buffer.subarray(dataStart, dataStart + lengthValue);
        afterStream = dataStart + lengthValue;
      } else {
        const endIndex = latin.indexOf('endstream', dataStart);
        const stop = endIndex < 0 ? buffer.length : endIndex;
        let trimmed = stop;
        while (trimmed > dataStart && (buffer[trimmed - 1] === 0x0a || buffer[trimmed - 1] === 0x0d)) {
          trimmed -= 1;
        }
        streamData = buffer.subarray(dataStart, trimmed);
        afterStream = stop;
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      objects.set(objectNumber, streamData ? { ...value, stream: true, raw: streamData } : value);
    }
    // 从流数据之后继续扫描，避免把流里的二进制当成对象头
    objectRegex.lastIndex = Math.max(objectRegex.lastIndex, afterStream);
  }

  // 对象流：里面装的是压缩后的对象
  for (const value of [...objects.values()]) {
    if (!isStream(value) || nameValue(value.Type) !== 'ObjStm') {
      continue;
    }
    const data = decodeStream(value, objects);
    if (!data) {
      continue;
    }
    const count = Number(value.N) || 0;
    const first = Number(value.First) || 0;
    const header = data.toString('latin1', 0, first).trim().split(/\s+/).filter(Boolean).map(Number);
    for (let i = 0; i < count; i += 1) {
      const objectNumber = header[i * 2];
      const offset = header[i * 2 + 1];
      if (!Number.isFinite(objectNumber) || !Number.isFinite(offset)) {
        continue;
      }
      const syntax = createPdfSyntax(data);
      syntax.seek(first + offset);
      const parsed = syntax.parseValue();
      if (parsed !== undefined && parsed !== null) {
        objects.set(objectNumber, parsed);
      }
    }
  }
  return objects;
}

function resolveRef(objects, value) {
  if (value && typeof value === 'object' && typeof value.ref === 'number') {
    return objects.get(value.ref);
  }
  return value;
}

function resolveDict(objects, value) {
  const resolved = resolveRef(objects, value);
  if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
    return resolved;
  }
  return {};
}

// ---------------------------------------------------------------------------
// 流解码
// ---------------------------------------------------------------------------

function applyPngPredictor(data, predictor, colors, bitsPerComponent, columns) {
  if (!predictor || predictor < 2) {
    return data;
  }
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
  const rowLength = Math.ceil((colors * bitsPerComponent * columns) / 8);
  if (predictor === 2) {
    // TIFF predictor（每行按通道做水平差分），仅处理 8bit
    if (bitsPerComponent === 8) {
      const out = Buffer.from(data);
      for (let row = 0; row + rowLength <= out.length; row += rowLength) {
        for (let i = bytesPerPixel; i < rowLength; i += 1) {
          out[row + i] = (out[row + i] + out[row + i - bytesPerPixel]) & 0xff;
        }
      }
      return out;
    }
    return data;
  }
  // PNG predictor：每行首字节是过滤器类型
  const out = Buffer.alloc(Math.max(0, (rowLength + 1) * Math.floor(data.length / (rowLength + 1))));
  let readPos = 0;
  let writePos = 0;
  const previous = Buffer.alloc(rowLength);
  while (readPos + rowLength + 1 <= data.length) {
    const filter = data[readPos];
    readPos += 1;
    const row = Buffer.from(data.subarray(readPos, readPos + rowLength));
    readPos += rowLength;
    for (let i = 0; i < rowLength; i += 1) {
      const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
      const up = previous[i];
      const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
      if (filter === 1) {
        row[i] = (row[i] + left) & 0xff;
      } else if (filter === 2) {
        row[i] = (row[i] + up) & 0xff;
      } else if (filter === 3) {
        row[i] = (row[i] + ((left + up) >> 1)) & 0xff;
      } else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const paeth = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
        row[i] = (row[i] + paeth) & 0xff;
      }
    }
    row.copy(out, writePos);
    writePos += rowLength;
    row.copy(previous);
  }
  return out.subarray(0, writePos);
}

function decodeAsciiHex(data) {
  const text = data.toString('latin1');
  const hex = text.split('>')[0].replace(/[^0-9a-f]/gi, '');
  return Buffer.from(hex.length % 2 === 1 ? `${hex}0` : hex, 'hex');
}

function decodeAscii85(data) {
  const text = data.toString('latin1').replace(/\s/g, '');
  const output = [];
  let tuple = 0;
  let count = 0;
  const endIndex = text.indexOf('~>');
  const body = endIndex < 0 ? text : text.slice(0, endIndex);
  for (const char of body) {
    if (char === 'z' && count === 0) {
      output.push(0, 0, 0, 0);
      continue;
    }
    const code = char.charCodeAt(0) - 33;
    if (code < 0 || code > 84) {
      continue;
    }
    tuple = tuple * 85 + code;
    count += 1;
    if (count === 5) {
      output.push((tuple >> 24) & 0xff, (tuple >> 16) & 0xff, (tuple >> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i += 1) {
      tuple = tuple * 85 + 84;
    }
    const bytes = [(tuple >> 24) & 0xff, (tuple >> 16) & 0xff, (tuple >> 8) & 0xff, tuple & 0xff];
    output.push(...bytes.slice(0, count - 1));
  }
  return Buffer.from(output);
}

// 返回 { data, imageMediaType }；不支持的解码返回 null
function decodeStreamInfo(streamObject, objects, limits = IMAGE_LIMITS) {
  const raw = streamObject.raw || Buffer.alloc(0);
  const dict = streamObject;
  let data = Buffer.from(raw);
  const filters = toArray(resolveRef(objects, dict.Filter)).map(nameValue).filter(Boolean);
  const parameters = toArray(resolveRef(objects, dict.DecodeParms));
  for (let index = 0; index < filters.length; index += 1) {
    const filter = filters[index];
    const parms = resolveDict(objects, parameters[index]);
    if (filter === 'FlateDecode' || filter === 'Fl') {
      // maxOutputLength 防止解压炸弹把堆拉爆（异常时直接放弃这张图）
      try {
        data = zlib.inflateSync(data, { maxOutputLength: limits.maxInflatedBytes });
      } catch {
        try {
          data = zlib.inflateRawSync(data, { maxOutputLength: limits.maxInflatedBytes });
        } catch {
          return null;
        }
      }
      data = applyPngPredictor(
        data,
        Number(parms.Predictor) || 1,
        Number(parms.Colors) || 1,
        Number(parms.BitsPerComponent) || 8,
        Number(parms.Columns) || Number(dict.Width) || 1
      );
    } else if (filter === 'ASCIIHexDecode' || filter === 'AHx') {
      data = decodeAsciiHex(data);
    } else if (filter === 'ASCII85Decode' || filter === 'A85') {
      data = decodeAscii85(data);
    } else if (filter === 'DCTDecode' || filter === 'DCT') {
      return { data, imageMediaType: 'image/jpeg' };
    } else if (filter === 'JPXDecode') {
      return { data, imageMediaType: 'image/jp2' };
    } else {
      // CCITTFax / JBIG2 / LZW 等暂不支持
      return null;
    }
  }
  return { data };
}

function decodeStream(streamObject, objects, limits) {
  const info = decodeStreamInfo(streamObject, objects, limits);
  return info ? info.data : null;
}

// ---------------------------------------------------------------------------
// 字体解码（ToUnicode CMap 优先，其次按编码名推断）
// ---------------------------------------------------------------------------

function utf16BeToString(bytes) {
  let text = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    text += String.fromCharCode(bytes.readUInt16BE(i));
  }
  return text;
}

function decodePdfString(value) {
  if (!value || !value.bytes) {
    return '';
  }
  const bytes = value.bytes;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return utf16BeToString(bytes.subarray(2));
  }
  return bytes.toString('latin1');
}

const WIN_ANSI_HIGH = {
  0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02c6', 0x89: '\u2030', 0x8a: '\u0160',
  0x8b: '\u2039', 0x8c: '\u0152', 0x8e: '\u017d', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201c', 0x94: '\u201d', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02dc', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a', 0x9c: '\u0153',
  0x9e: '\u017e', 0x9f: '\u0178'
};

// 解析 ToUnicode CMap：bfchar / bfrange
function parseToUnicodeCMap(data) {
  const text = data.toString('latin1');
  const map = new Map();
  const bfcharRegex = /beginbfchar([\s\S]*?)endbfchar/g;
  let match;
  while ((match = bfcharRegex.exec(text))) {
    const pairs = match[1].match(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi) || [];
    for (const pair of pairs) {
      const [source, target] = pair.match(/<([0-9a-f]+)>/gi).map((item) => item.slice(1, -1));
      map.set(parseInt(source, 16), utf16BeToString(Buffer.from(target, 'hex')));
    }
  }
  const bfrangeRegex = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((match = bfrangeRegex.exec(text))) {
    const body = match[1];
    const rangeRegex = /<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<([0-9a-f]*)>|\[([\s\S]*?)\])/gi;
    let rangeMatch;
    while ((rangeMatch = rangeRegex.exec(body))) {
      const start = parseInt(rangeMatch[1], 16);
      const end = parseInt(rangeMatch[2], 16);
      if (rangeMatch[4] !== undefined) {
        const base = Buffer.from(rangeMatch[4], 'hex');
        // UTF-16BE 码元；自增从最后一个码元开始，进位向前传播
        const aligned = base.length % 2 === 0;
        for (let code = start; code <= end; code += 1) {
          const current = Buffer.from(base);
          if (aligned) {
            let carry = code - start;
            for (let i = current.length - 2; i >= 0 && carry > 0; i -= 2) {
              const value = current.readUInt16BE(i) + carry;
              current.writeUInt16BE(value & 0xffff, i);
              carry = Math.floor(value / 0x10000);
            }
          }
          map.set(code, utf16BeToString(current));
        }
      } else if (rangeMatch[5] !== undefined) {
        const items = rangeMatch[5].match(/<([0-9a-f]*)>/gi) || [];
        items.forEach((item, index) => {
          map.set(start + index, utf16BeToString(Buffer.from(item.slice(1, -1), 'hex')));
        });
      }
    }
  }
  return map;
}

// 按编码名推断多字节编码（无 ToUnicode 时的兜底）
function decodeByEncodingName(encodingName, bytes) {
  const name = String(encodingName || '').toUpperCase();
  if (name.includes('UCS2') || name.includes('UTF16')) {
    return utf16BeToString(bytes);
  }
  if (name.includes('GBK') || name.includes('GB-EUC') || name.includes('GBPC')) {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return '';
    }
  }
  if (name.includes('ETEN') || name.includes('BIG5')) {
    try {
      return new TextDecoder('big5').decode(bytes);
    } catch {
      return '';
    }
  }
  return '';
}

// 返回 { decode(bytes) -> { text, unmapped }, multiByte }
function createFontDecoder(fontObject, objects) {
  const font = resolveDict(objects, fontObject);
  const subtype = nameValue(font.Subtype);
  const toUnicodeRef = resolveRef(objects, font.ToUnicode);
  const encodingDict = resolveDict(objects, font.Encoding);
  const encodingName = nameValue(font.Encoding) || nameValue(encodingDict.BaseEncoding);

  let cmap = null;
  if (isStream(toUnicodeRef)) {
    const data = decodeStream(toUnicodeRef, objects);
    if (data) {
      cmap = parseToUnicodeCMap(data);
    }
  }

  const isComposite = subtype === 'Type0';
  const descendant = isComposite ? resolveDict(objects, toArray(resolveRef(objects, font.DescendantFonts))[0]) : {};

  return {
    multiByte: isComposite,
    decode(bytes) {
      if (isComposite) {
        // 复合字体：编码名以 UCS2/UTF16 结尾时，两字节码本身就是 Unicode
        const direct = decodeByEncodingName(encodingName, bytes);
        if (direct) {
          return { text: direct, unmapped: 0 };
        }
        let text = '';
        let unmapped = 0;
        for (let i = 0; i + 1 < bytes.length; i += 2) {
          const code = bytes.readUInt16BE(i);
          if (cmap && cmap.has(code)) {
            text += cmap.get(code);
          } else {
            unmapped += 1;
          }
        }
        if (bytes.length % 2 === 1) {
          unmapped += 1;
        }
        return { text, unmapped };
      }
      if (cmap && cmap.size > 0) {
        let text = '';
        let unmapped = 0;
        for (const byte of bytes) {
          if (cmap.has(byte)) {
            text += cmap.get(byte);
          } else {
            unmapped += 1;
          }
        }
        return { text, unmapped };
      }
      // 简单字体：WinAnsi / Latin1 兜底
      let text = '';
      for (const byte of bytes) {
        text += WIN_ANSI_HIGH[byte] || String.fromCharCode(byte);
      }
      return { text, unmapped: 0 };
    },
    // 供文本提取时判断每字符码长
    get codeBytes() {
      return isComposite ? 2 : 1;
    },
    get fontName() {
      return nameValue(font.BaseFont) || nameValue(descendant.BaseFont) || '';
    }
  };
}

// ---------------------------------------------------------------------------
// 内容流文本抽取
// ---------------------------------------------------------------------------

function isDigitByte(byte) {
  return byte >= 0x30 && byte <= 0x39;
}

function createContentTokens(buffer) {
  const syntax = createPdfSyntax(buffer);
  const tokens = [];
  while (true) {
    syntax.skipWhitespace();
    const byte = syntax.peek();
    if (byte === undefined) {
      break;
    }
    if (byte === 0x2f) {
      tokens.push(syntax.parseValue());
      continue;
    }
    if (byte === 0x5b) {
      tokens.push(syntax.parseValue());
      continue;
    }
    if (byte === 0x28) {
      tokens.push(syntax.parseValue());
      continue;
    }
    if (byte === 0x3c) {
      if (buffer[syntax.offset() + 1] === 0x3c) {
        // '<<' 字典（BDC 属性等）：整段跳过
        syntax.parseValue();
        continue;
      }
      tokens.push(syntax.parseValue());
      continue;
    }
    if (isDigitByte(byte) || byte === 0x2b || byte === 0x2d || byte === 0x2e) {
      tokens.push(syntax.parseValue());
      continue;
    }
    const keyword = syntax.readKeyword();
    if (!keyword) {
      // 防止死循环
      syntax.seek(syntax.offset() + 1);
      continue;
    }
    tokens.push({ type: 'operator', value: keyword });
  }
  return tokens;
}

function extractTextFromContent(contentBuffer, resources, context, depth = 0) {
  if (!contentBuffer || contentBuffer.length === 0 || depth > 6) {
    return { lines: [], blocks: [], nested: false, unmapped: 0 };
  }
  const tokens = createContentTokens(contentBuffer);
  const lines = [];
  // 内容流中文本行与图片的先后顺序（用于把插图插到正文相应位置）
  const blocks = [];
  let nested = false;
  let line = '';
  let currentY = null;
  let fontSize = 12;
  let leading = 0;
  let decoder = null;
  let unmapped = 0;
  const operands = [];

  function flushLine() {
    const text = line.replace(/\s+/g, ' ').trim();
    if (text) {
      lines.push(text);
      blocks.push({ kind: 'text', text, y: currentY });
    }
    line = '';
  }

  function showString(bytes) {
    if (!decoder || !bytes) {
      return;
    }
    const result = decoder.decode(bytes);
    line += result.text;
    unmapped += result.unmapped;
  }

  for (const token of tokens) {
    if (token && token.type === 'operator') {
      const operator = token.value;
      if (operator === 'BT') {
        currentY = null;
      } else if (operator === 'Tf') {
        const fontName = nameValue(operands[operands.length - 2]);
        const size = Number(operands[operands.length - 1]);
        fontSize = Number.isFinite(size) && size > 0 ? size : fontSize;
        const fonts = resolveDict(context.objects, resources ? resources.Font : null);
        const fontEntry = fonts[fontName];
        decoder = fontEntry
          ? createFontDecoder(fontEntry, context.objects)
          : null;
      } else if (operator === 'TL') {
        const value = Number(operands[operands.length - 1]);
        if (Number.isFinite(value)) {
          leading = value;
        }
      } else if (operator === 'Td' || operator === 'TD') {
        const dx = Number(operands[operands.length - 2]) || 0;
        const dy = Number(operands[operands.length - 1]) || 0;
        if (operator === 'TD') {
          leading = -dy;
        }
        if (currentY === null) {
          currentY = dy;
        } else if (Math.abs(dy) > 0.5) {
          flushLine();
          currentY += dy;
        } else if (dx > fontSize * 0.25) {
          if (line && !line.endsWith(' ')) {
            line += ' ';
          }
        }
      } else if (operator === 'T*') {
        flushLine();
        currentY = (currentY === null ? 0 : currentY) - (leading || fontSize);
      } else if (operator === 'Tm') {
        const f = Number(operands[operands.length - 1]);
        if (Number.isFinite(f)) {
          if (currentY === null || Math.abs(f - currentY) > 0.5) {
            flushLine();
          }
          currentY = f;
        }
      } else if (operator === 'Tj') {
        const last = operands[operands.length - 1];
        showString(last && last.bytes);
      } else if (operator === "'") {
        flushLine();
        const last = operands[operands.length - 1];
        showString(last && last.bytes);
      } else if (operator === '"') {
        flushLine();
        const last = operands[operands.length - 1];
        showString(last && last.bytes);
      } else if (operator === 'TJ') {
        const array = operands[operands.length - 1];
        if (Array.isArray(array)) {
          for (const item of array) {
            if (item && item.bytes) {
              showString(item.bytes);
            } else if (typeof item === 'number' && item <= -200) {
              if (line && !line.endsWith(' ')) {
                line += ' ';
              }
            }
          }
        }
      } else if (operator === 'Do') {
        const name = nameValue(operands[operands.length - 1]);
        const xobjects = resolveDict(context.objects, resources ? resources.XObject : null);
        const xobject = resolveDict(context.objects, xobjects[name]);
        if (nameValue(xobject.Subtype) === 'Image') {
          flushLine();
          blocks.push({ kind: 'image', name });
        } else if (nameValue(xobject.Subtype) === 'Form' && isStream(xobject)) {
          const data = decodeStream(xobject, context.objects);
          const nestedResources = resolveDict(context.objects, xobject.Resources) || resources;
          const inner = extractTextFromContent(data, nestedResources, context, depth + 1);
          flushLine();
          lines.push(...inner.lines);
          blocks.push(...inner.blocks);
          unmapped += inner.unmapped;
          // 嵌套表单的坐标不经过 CTM 无法与父级比较，此时不再按 y 排序
          nested = true;
        }
      }
      operands.length = 0;
      continue;
    }
    operands.push(token);
    if (operands.length > 32) {
      operands.shift();
    }
  }
  flushLine();
  return { lines, blocks, nested, unmapped };
}

// 行合并成段落：上一行未以结束标点收尾时与下一行相接
function mergeParagraphLines(lines) {
  const paragraphs = [];
  for (const rawLine of lines) {
    const text = String(rawLine || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      continue;
    }
    const previous = paragraphs[paragraphs.length - 1];
    if (previous && !PARAGRAPH_END_PATTERN.test(previous) && previous.length >= 8) {
      paragraphs[paragraphs.length - 1] = `${previous}${text}`;
    } else {
      paragraphs.push(text);
    }
  }
  return paragraphs;
}

// ---------------------------------------------------------------------------
// 页面 / 目录 / 封面
// ---------------------------------------------------------------------------

function collectPages(objects) {
  const pages = [];
  let catalog = null;
  for (const value of objects.values()) {
    if (!isStream(value) && value && typeof value === 'object' && nameValue(value.Type) === 'Catalog') {
      catalog = value;
      break;
    }
  }
  const seen = new Set();

  function walk(nodeRef, inherited) {
    const node = resolveDict(objects, nodeRef);
    const type = nameValue(node.Type);
    const nextInherited = {
      Resources: node.Resources !== undefined ? node.Resources : inherited.Resources,
      MediaBox: node.MediaBox !== undefined ? node.MediaBox : inherited.MediaBox
    };
    if (type === 'Page') {
      pages.push({
        number: nodeRef && typeof nodeRef.ref === 'number' ? nodeRef.ref : null,
        object: node,
        resources: resolveDict(objects, nextInherited.Resources),
        mediaBox: resolveRef(objects, nextInherited.MediaBox)
      });
      return;
    }
    const kids = toArray(resolveRef(objects, node.Kids));
    for (const kid of kids) {
      if (kid && typeof kid.ref === 'number') {
        if (seen.has(kid.ref)) {
          continue;
        }
        seen.add(kid.ref);
        walk(kid, nextInherited);
      } else if (kid && typeof kid === 'object') {
        walk(kid, nextInherited);
      }
    }
  }

  if (catalog && catalog.Pages !== undefined) {
    walk(catalog.Pages, {});
  }
  if (pages.length === 0) {
    // 兜底：直接按对象号收集所有页面
    for (const [number, value] of objects) {
      if (value && typeof value === 'object' && !Array.isArray(value) && nameValue(value.Type) === 'Page') {
        pages.push({
          number,
          object: value,
          resources: resolveDict(objects, value.Resources),
          mediaBox: resolveRef(objects, value.MediaBox)
        });
      }
    }
    pages.sort((a, b) => (a.number || 0) - (b.number || 0));
  }
  return pages;
}

function readPageText(page, context) {
  const contents = toArray(resolveRef(context.objects, page.object.Contents));
  const lines = [];
  const blocks = [];
  let nested = false;
  let unmapped = 0;
  for (const contentRef of contents) {
    const stream = resolveRef(context.objects, contentRef);
    if (!isStream(stream)) {
      continue;
    }
    const data = decodeStream(stream, context.objects);
    const result = extractTextFromContent(data, page.resources, context);
    lines.push(...result.lines);
    blocks.push(...result.blocks);
    unmapped += result.unmapped;
    nested = nested || result.nested;
  }
  return { lines, blocks: orderPageBlocks(blocks, nested), unmapped };
}

// 页面内文本与图片的先后顺序：坐标可比时按 y 从大到小（PDF 原点在左下角），否则保持内容流顺序
function orderPageBlocks(blocks, nested) {
  if (nested || blocks.length < 2) {
    return blocks;
  }
  const sortable = blocks.every((block) => Number.isFinite(block.y));
  if (!sortable) {
    return blocks;
  }
  return [...blocks].sort((a, b) => b.y - a.y);
}

// 页面引用的图片名（去重，仅判断「该页有没有图」，与是否内嵌无关）
function pageImageNames(blocks) {
  const names = [];
  for (const block of blocks) {
    if (block.kind === 'image' && !names.includes(block.name)) {
      names.push(block.name);
    }
  }
  return names;
}

// 解析书签（/Outlines）
function readOutlines(objects) {
  const entries = [];
  let root = null;
  for (const value of objects.values()) {
    if (!isStream(value) && value && typeof value === 'object' && nameValue(value.Type) === 'Outlines') {
      root = value;
      break;
    }
  }
  if (!root) {
    return entries;
  }

  function destinationPage(dest) {
    const target = resolveRef(objects, dest);
    if (Array.isArray(target) && target.length > 0) {
      const pageRef = target[0];
      return pageRef && typeof pageRef.ref === 'number' ? pageRef.ref : null;
    }
    return null;
  }

  // 顺着 First（子级）/Next（兄弟）递归
  function walkNode(ref, depth) {
    let currentRef = ref;
    const guard = new Set();
    while (currentRef) {
      const key = currentRef && typeof currentRef.ref === 'number' ? currentRef.ref : null;
      if (key !== null) {
        if (guard.has(key)) {
          break;
        }
        guard.add(key);
      }
      const node = resolveDict(objects, currentRef);
      if (!node || Object.keys(node).length === 0) {
        break;
      }
      const title = decodePdfString(node.Title).trim();
      const action = resolveDict(objects, node.A);
      const pageRef = destinationPage(node.Dest !== undefined ? node.Dest : action.D);
      if (title) {
        entries.push({ title, pageObjectNumber: pageRef, level: depth });
      }
      if (node.First !== undefined) {
        walkNode(node.First, depth + 1);
      }
      currentRef = node.Next;
    }
  }

  if (root.First !== undefined) {
    walkNode(root.First, 0);
  }
  return entries;
}

// 单张图片/单个流的安全上限：避免异常尺寸或解压炸弹把内存拉爆
const IMAGE_LIMITS = {
  // 单个流解压后的最大字节数
  maxInflatedBytes: 64 * 1024 * 1024,
  // 单张图片的像素数（宽 × 高）上限
  maxPixels: 32 * 1024 * 1024,
  // 单张图片的原始字节上限
  maxBytes: 8 * 1024 * 1024
};

// 图片 XObject → { mediaType, data }：DCT/JPX 原样输出，其余像素重新编码为 PNG
function decodeImageObject(xobject, objects, limits = IMAGE_LIMITS) {
  if (!isStream(xobject) || nameValue(xobject.Subtype) !== 'Image') {
    return null;
  }
  const width = Number(xobject.Width) || 0;
  const height = Number(xobject.Height) || 0;
  if (width <= 0 || height <= 0 || width * height > limits.maxPixels) {
    return null;
  }
  const decoded = decodeStreamInfo(xobject, objects, limits);
  if (!decoded) {
    return null;
  }
  if (decoded.data.length > limits.maxBytes) {
    return null;
  }
  if (decoded.imageMediaType) {
    return { mediaType: decoded.imageMediaType, data: decoded.data };
  }
  const bitsPerComponent = Number(xobject.BitsPerComponent) || 8;
  if (bitsPerComponent !== 8) {
    return null;
  }
  const colorSpace = nameValue(xobject.ColorSpace) ||
    nameValue(toArray(resolveRef(objects, xobject.ColorSpace))[0]);
  const pixels = decoded.data;
  try {
    if (colorSpace === 'DeviceRGB' || colorSpace === 'CalRGB') {
      if (pixels.length < width * height * 3 || width * height * 3 > limits.maxBytes) {
        return null;
      }
      return { mediaType: 'image/png', data: encodePng(width, height, 2, pixels) };
    }
    if (colorSpace === 'DeviceGray' || colorSpace === 'CalGray') {
      if (pixels.length < width * height || width * height > limits.maxBytes) {
        return null;
      }
      return { mediaType: 'image/png', data: encodePng(width, height, 0, pixels) };
    }
    if (colorSpace === 'DeviceCMYK') {
      if (pixels.length < width * height * 4 || width * height * 3 > limits.maxBytes) {
        return null;
      }
      const rgb = Buffer.alloc(width * height * 3);
      for (let i = 0, j = 0; i + 3 < pixels.length; i += 4, j += 3) {
        const c = pixels[i] / 255;
        const m = pixels[i + 1] / 255;
        const y = pixels[i + 2] / 255;
        const k = pixels[i + 3] / 255;
        rgb[j] = Math.round(255 * (1 - c) * (1 - k));
        rgb[j + 1] = Math.round(255 * (1 - m) * (1 - k));
        rgb[j + 2] = Math.round(255 * (1 - y) * (1 - k));
      }
      return { mediaType: 'image/png', data: encodePng(width, height, 2, rgb) };
    }
  } catch {
    return null;
  }
  return null;
}

// 不解码，只根据 Filter 推断 mime（按需出图时用作 content-type）
function imageFilterMediaType(xobject, objects) {
  const filter = nameValue(xobject.Filter) || nameValue(toArray(resolveRef(objects, xobject.Filter))[0]);
  if (filter === 'DCTDecode' || filter === 'DCT') {
    return 'image/jpeg';
  }
  if (filter === 'JPXDecode') {
    return 'image/jp2';
  }
  if (filter === 'FlateDecode' || filter === 'Fl') {
    return 'image/png';
  }
  return 'application/octet-stream';
}

// 正文图片按 EPUB 的样式输出：块级 + 前后 <br/> 分隔
function toInlineImageHtml(image) {
  return `<br/><img src="data:${image.mediaType};base64,${image.data.toString('base64')}"`
    + ' style="display:block;max-width:100%;height:auto;" /><br/>';
}

// 按需出图：正文只放一个地址，图片由 /pdf-page 逐页提供（扫描版不会撑爆内存）
function buildPageImageUrl(base, pageNumber, name) {
  // base 来自调用方，做一次转义防护，避免拼出越界的 HTML 属性
  const safeBase = String(base || '').replace(/["<>]/g, '');
  const separator = safeBase.includes('?') ? '&' : '?';
  return `${safeBase}${separator}page=${pageNumber}&name=${encodeURIComponent(name)}`;
}

function toUrlImageHtml(url) {
  return `<br/><img src="${url}" style="display:block;max-width:100%;height:auto;" /><br/>`;
}

// 首页图片作为封面（DCT → jpeg，Flate → PNG）
function extractCoverImage(pages, objects) {
  for (const page of pages) {
    const xobjects = resolveDict(objects, page.resources ? page.resources.XObject : null);
    let best = null;
    for (const key of Object.keys(xobjects)) {
      const xobject = resolveRef(objects, xobjects[key]);
      if (!isStream(xobject) || nameValue(xobject.Subtype) !== 'Image') {
        continue;
      }
      const width = Number(xobject.Width) || 0;
      const height = Number(xobject.Height) || 0;
      if (!best || width * height > best.width * best.height) {
        best = { xobject, width, height };
      }
    }
    if (!best) {
      continue;
    }
    const image = decodeImageObject(best.xobject, objects);
    if (image) {
      return image;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function parsePdfBuffer(input, options = {}) {
  const settings = {
    includeText: options.includeText !== false,
    includeChapters: options.includeChapters !== false,
    paragraphMerge: options.paragraphMerge !== false,
    // 正文图片：inline=base64 内嵌 / url=按需地址 / none=不出图
    // 默认：传了 imageUrlBase 就用 url（扫描版几百页不会把堆撑爆），否则内嵌
    imageMode: ['inline', 'url', 'none'].includes(options.imageMode)
      ? options.imageMode
      : (options.imageUrlBase ? 'url' : (options.inlineImages === false ? 'none' : 'inline')),
    imageUrlBase: typeof options.imageUrlBase === 'string' ? options.imageUrlBase : '',
    // 整本内嵌图片的原始字节上限（默认 24 MB，防止一次性生成几十 MB 的 base64）
    maxInlineImageBytes: Number.isFinite(options.maxInlineImageBytes) && options.maxInlineImageBytes >= 0
      ? options.maxInlineImageBytes
      : 24 * 1024 * 1024,
    maxImageBytes: Number.isFinite(options.maxImageBytes) && options.maxImageBytes > 0
      ? options.maxImageBytes
      : IMAGE_LIMITS.maxBytes,
    // 分章方式：auto（有书签用书签，否则按页）/ page（强制按页）
    chapterMode: options.chapterMode === 'page' ? 'page' : 'auto',
    maxPages: Number.isFinite(options.maxPages) && options.maxPages > 0 ? options.maxPages : Infinity,
    coverImage: options.coverImage !== false,
    rules: options.rules && typeof options.rules === 'object' ? options.rules : getDefaultRules(),
    directoryEntries: Array.isArray(options.directoryEntries) ? options.directoryEntries : []
  };
  const imageLimits = {
    maxInflatedBytes: IMAGE_LIMITS.maxInflatedBytes,
    maxPixels: IMAGE_LIMITS.maxPixels,
    maxBytes: settings.maxImageBytes
  };
  const imageMode = settings.imageMode;
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!buffer.toString('latin1', 0, 1024).includes('%PDF-')) {
    throw new Error('不是有效的 PDF 文件');
  }
  const objects = scanPdfObjects(buffer);
  const info = (() => {
    const latin = buffer.toString('latin1');
    const last = latin.lastIndexOf('trailer');
    if (last < 0) {
      return {};
    }
    const syntax = createPdfSyntax(buffer);
    syntax.seek(last + 'trailer'.length);
    return resolveDict(objects, syntax.parseValue());
  })();
  const infoDict = resolveDict(objects, info.Info);

  const pageObjects = collectPages(objects).slice(0, settings.maxPages);
  const pageIndexByObjectNumber = new Map();
  const pages = pageObjects.map((page, index) => {
    const text = readPageText(page, { objects });
    const paragraphs = settings.paragraphMerge ? mergeParagraphLines(text.lines) : text.lines;
    if (page.number !== null) {
      pageIndexByObjectNumber.set(page.number, index);
    }
    return {
      index,
      object: page,
      blocks: text.blocks,
      imageNames: pageImageNames(text.blocks),
      lines: text.lines,
      paragraphs,
      text: paragraphs.join('\n'),
      unmapped: text.unmapped,
      paragraphCount: paragraphs.length
    };
  });

  // 图片统计：emitted=正文里出现的图片数（不管 base64 还是 URL），count=实际内嵌张数，bytes=内嵌字节量
  const imageState = { bytes: 0, skipped: 0, count: 0, emitted: 0 };
  const inlineImages = new Map();

  function renderPages(pageList) {
    const rendered = [];
    const chapterImages = [];
    const seenInline = new Set();
    for (const item of pageList) {
      const page = pages[item];
      if (page.imageNames.length === 0 || imageMode === 'none') {
        rendered.push(textToHtml(page.text));
        continue;
      }
      const xobjects = resolveDict(objects, page.object.resources ? page.object.resources.XObject : null);
      const parts = [];
      const buffer = [];
      const flushText = () => {
        if (buffer.length === 0) {
          return;
        }
        const merged = settings.paragraphMerge ? mergeParagraphLines(buffer) : [...buffer];
        buffer.length = 0;
        const html = textToHtml(merged.join('\n'));
        if (html) {
          parts.push(html);
        }
      };
      for (const block of page.blocks) {
        if (block.kind === 'text') {
          buffer.push(block.text);
          continue;
        }
        flushText();
        if (imageMode === 'url') {
          const url = buildPageImageUrl(settings.imageUrlBase, page.index + 1, block.name);
          const xobject = resolveDict(objects, xobjects[block.name]);
          imageState.emitted += 1;
          chapterImages.push({
            page: page.index + 1,
            name: block.name,
            url,
            mediaType: isStream(xobject) ? imageFilterMediaType(xobject, objects) : ''
          });
          parts.push(toUrlImageHtml(url));
          continue;
        }
        // 内嵌模式：同一章里重复引用的同一张图只嵌一次
        if (seenInline.has(block.name)) {
          continue;
        }
        seenInline.add(block.name);
        const image = decodeImageObject(resolveRef(objects, xobjects[block.name]), objects, imageLimits);
        if (!image) {
          imageState.skipped += 1;
          continue;
        }
        if (imageState.bytes + image.data.length > settings.maxInlineImageBytes) {
          imageState.skipped += 1;
          continue;
        }
        imageState.bytes += image.data.length;
        imageState.count += 1;
        imageState.emitted += 1;
        const meta = { page: page.index + 1, name: block.name, mediaType: image.mediaType, bytes: image.data.length };
        chapterImages.push(meta);
        if (!inlineImages.has(block.name)) {
          inlineImages.set(block.name, meta);
        }
        parts.push(toInlineImageHtml(image));
      }
      flushText();
      rendered.push(parts.join('<br/>'));
    }
    return { html: rendered.filter(Boolean).join('<br/>'), images: chapterImages };
  }

  const outlines = settings.chapterMode === 'page' ? [] : readOutlines(objects);

  // 分章
  const chapters = [];
  if (outlines.length > 0) {
    const resolved = outlines
      .map((entry) => ({
        title: entry.title,
        pageIndex: entry.pageObjectNumber !== null && pageIndexByObjectNumber.has(entry.pageObjectNumber)
          ? pageIndexByObjectNumber.get(entry.pageObjectNumber)
          : null
      }))
      .filter((entry) => entry.pageIndex !== null);
    resolved.forEach((entry, index) => {
      const nextIndex = index + 1 < resolved.length ? resolved[index + 1].pageIndex : pages.length;
      const start = entry.pageIndex;
      const end = Math.max(start + 1, nextIndex);
      const pageIndexes = [];
      for (let i = start; i < end; i += 1) {
        pageIndexes.push(i);
      }
      const rendered = renderPages(pageIndexes);
      const contentPages = pages.slice(start, end);
      chapters.push({
        title: entry.title,
        href: `page:${start + 1}`,
        pages: [start + 1, end],
        text: contentPages.map((page) => page.text).join('\n\n').trim(),
        content: rendered.html,
        images: rendered.images,
        imageCount: contentPages.reduce((total, page) => total + page.imageNames.length, 0)
      });
    });
  }
  if (chapters.length === 0) {
    for (const page of pages) {
      const rendered = renderPages([page.index]);
      chapters.push({
        title: `第 ${page.index + 1} 页`,
        href: `page:${page.index + 1}`,
        pages: [page.index + 1, page.index + 1],
        text: page.text,
        content: rendered.html,
        images: rendered.images,
        imageCount: page.imageNames.length
      });
    }
  }

  // 与 EPUB 相同：无正文的目录与下一个有正文的目录合并（标题拆行/书签重复指向同一页时很常见）。
  // 注意：只要页面里有图片就算有正文，因此章节结构不受 inlineImages 开关影响。
  const normalizedChapters = [];
  for (const chapter of chapters) {
    let current = chapter;
    while (normalizedChapters.length > 0) {
      const previous = normalizedChapters[normalizedChapters.length - 1];
      const previousText = String(previous.text || '').trim();
      const currentText = String(current.text || '').trim();
      const previousHasImages = (previous.imageCount || 0) > 0;
      const currentHasImages = (current.imageCount || 0) > 0;
      const previousTitleOnly = (!previousText && !previousHasImages) || previousText === String(previous.title || '').trim();
      const currentHasBody = (Boolean(currentText) || currentHasImages) && currentText !== String(current.title || '').trim();
      if (!previousTitleOnly || !currentHasBody) {
        break;
      }
      const mergedTitle = mergeChapterTitles(previous.title, current.title, settings.rules, settings.directoryEntries);
      if (!mergedTitle) {
        break;
      }
      normalizedChapters.pop();
      current = {
        ...current,
        title: mergedTitle,
        sourcePages: [previous.pages, current.pages],
        content: [previous.content, current.content].filter(Boolean).join('<br/>'),
        images: [...(previous.images || []), ...(current.images || [])],
        imageCount: (previous.imageCount || 0) + (current.imageCount || 0)
      };
    }
    normalizedChapters.push(current);
  }

  const withContent = normalizedChapters.map((chapter, index) => {
    const text = String(chapter.text || '');
    const content = chapter.content !== undefined && chapter.content !== ''
      ? chapter.content
      : textToHtml(text);
    const result = {
      index: index + 1,
      id: chapter.href,
      href: chapter.href,
      title: chapter.title,
      pages: chapter.pages,
      mediaType: 'text/html',
      content,
      // 页面里检测到的图片数（与是否内嵌无关）与已内嵌的图片元信息
      imageCount: chapter.imageCount || 0,
      images: chapter.images || []
    };
    if (settings.includeText) {
      result.text = text;
    }
    if (chapter.sourcePages) {
      result.sourcePages = chapter.sourcePages;
    }
    return result;
  });

  const cover = settings.coverImage ? extractCoverImage(pageObjects, objects) : null;
  const coverMeta = cover
    ? { href: 'page:1/image', mediaType: cover.mediaType, bytes: cover.data.length, from: 'page-image' }
    : null;
  const textPageCount = pages.filter((page) => (page.text || '').trim().length > 0).length;

  const result = {
    title: infoDict.Title ? decodePdfString(infoDict.Title).trim() : '',
    author: infoDict.Author ? decodePdfString(infoDict.Author).trim() : '',
    description: infoDict.Subject ? decodePdfString(infoDict.Subject).trim() : '',
    keywords: infoDict.Keywords ? decodePdfString(infoDict.Keywords).trim() : '',
    producer: infoDict.Producer ? decodePdfString(infoDict.Producer).trim() : '',
    creator: infoDict.Creator ? decodePdfString(infoDict.Creator).trim() : '',
    pageCount: pages.length,
    outlineCount: outlines.length,
    cover: coverMeta,
    toc: outlines.map((entry) => ({ title: entry.title, href: '', level: entry.level || 0 })),
    chapters: settings.includeChapters ? withContent : [],
    images: [...inlineImages.values()],
    stats: {
      pageCount: pages.length,
      chapterCount: settings.includeChapters ? withContent.length : 0,
      textLength: withContent.reduce((total, chapter) => total + (chapter.text || '').length, 0),
      textPageCount,
      // 整本都没有文本层（每页只有图片）：多半是扫描版
      scanned: pages.length > 0 && textPageCount === 0,
      // 已内嵌 base64 的图片张数与原始字节数
      imageMode,
      imageCount: imageState.emitted,
      inlinedImages: imageState.count,
      imageBytes: imageState.bytes,
      skippedImages: imageState.skipped,
      unmappedCodes: pages.reduce((total, page) => total + page.unmapped, 0),
      outlineCount: outlines.length,
      coverImage: cover ? cover.mediaType : ''
    }
  };
  // 封面原始字节仅供调用方写缓存或按 URL 提供，不参与 JSON 序列化
  Object.defineProperty(result, 'coverData', { value: cover ? cover.data : null, enumerable: false });
  return result;
}

function escapeHtmlText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function textToHtml(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return '';
  }
  return normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => escapeHtmlText(line))
    .join('<br/>\n');
}

function parsePdfFile(filePath, options = {}) {
  return parsePdfBuffer(fs.readFileSync(filePath), options);
}

// 按页提取单张图片（供 /pdf-page 按需提供正文图片；limits 可比内嵌时宽松）
function extractPageImage(input, pageNumber, name, options = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!buffer.toString('latin1', 0, 1024).includes('%PDF-')) {
    throw new Error('不是有效的 PDF 文件');
  }
  const limitPage = Number(pageNumber) || 0;
  if (limitPage < 1) {
    return null;
  }
  const objects = scanPdfObjects(buffer);
  const page = collectPages(objects)[limitPage - 1];
  if (!page) {
    return null;
  }
  const xobjects = resolveDict(objects, page.resources ? page.resources.XObject : null);
  const keys = Object.keys(xobjects);
  const key = typeof name === 'string' && name && xobjects[name] !== undefined ? name : keys[0];
  if (!key) {
    return null;
  }
  const limits = {
    maxInflatedBytes: Number.isFinite(options.maxInflatedBytes) && options.maxInflatedBytes > 0
      ? options.maxInflatedBytes
      : 192 * 1024 * 1024,
    maxPixels: Number.isFinite(options.maxPixels) && options.maxPixels > 0
      ? options.maxPixels
      : 64 * 1024 * 1024,
    maxBytes: Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes
      : 32 * 1024 * 1024
  };
  return decodeImageObject(resolveRef(objects, xobjects[key]), objects, limits);
}

module.exports = {
  parsePdfBuffer,
  parsePdfFile,
  extractPageImage,
  encodePng,
  crc32
};
