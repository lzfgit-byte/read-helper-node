const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { createDatabase } = require('./db');
const { parseTextToChapters, normalizeDirectoryEntries, loadRules, saveRules, getDefaultRules } = require('./parseRules');
const { parseEpubBuffer } = require('./epubParser');
const { ensureDir, saveBookFile, saveBookBuffer, readHtmlList } = require('./fileService');

const appDataDir = path.join(app.getPath('userData'), 'reader-helper');
const booksDir = path.join(appDataDir, 'books');
const coversDir = path.join(appDataDir, 'epub-covers');
const javaHtmlDir = path.join('d:', 'projects', 'reader-help', 'src', 'main', 'resources', 'templates');
const htmlDir = fs.existsSync(javaHtmlDir) ? javaHtmlDir : path.join(__dirname, 'public', 'html');
const dbPath = path.join(appDataDir, 'reader-helper.db');
const rulesPath = path.join(appDataDir, 'parse-rules.json');
const EPUB_EXTENSION = '.epub';
// 已保存书籍的封面由该接口从 EPUB 文件里实时提取
const BOOK_COVER_PATH = '/book-cover';
// 仅解析（未保存）时，封面先落到缓存目录再通过静态地址提供
const EPUB_COVER_CACHE_PATH = '/epub-covers';
const COVER_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif'
};
let serverInstance = null;
let serverPort = 3000;
let mainWindow;
let database;

function splitDirectoryEntries(directoryEntries) {
  return normalizeDirectoryEntries(directoryEntries);
}

function isEpubBook(book) {
  const fileType = String((book && book.fileType) || '').toLowerCase();
  const storedPath = String((book && book.storedPath) || '').toLowerCase();
  return fileType === 'epub' || storedPath.endsWith(EPUB_EXTENSION);
}

// EPUB 解析结果 -> 前端表单/展示用的书本信息（封面以 URL 形式给出，不内嵌 base64）
function buildEpubSummary(parsed, coverUrl = '') {
  const cover = parsed.cover || null;
  return {
    title: parsed.title || '',
    author: parsed.author || '',
    description: parsed.description || '',
    language: parsed.language || '',
    identifier: parsed.identifier || '',
    publisher: parsed.publisher || '',
    date: parsed.date || '',
    coverImg: cover ? coverUrl : '',
    coverMediaType: cover ? cover.mediaType : '',
    coverBytes: cover ? cover.bytes : 0,
    toc: parsed.toc || [],
    chapterCount: parsed.chapters.length,
    imageCount: parsed.stats ? parsed.stats.imageCount : 0
  };
}

// 章节标题默认作为目录项保存，方便后续检索
function epubDirectoryEntries(parsed) {
  const titles = (parsed.chapters || []).map((chapter) => chapter.title).filter(Boolean);
  return titles.join('\n');
}

// 已保存书籍的封面地址（相对路径，由 /book-cover 从 EPUB 文件里提取）
function epubCoverUrl(bookId) {
  return `${BOOK_COVER_PATH}?id=${bookId}`;
}

// 未保存的 EPUB：封面写入缓存目录，返回可直接访问的静态地址
function cacheEpubCover(parsed, options = {}) {
  if (!parsed || !parsed.cover || !parsed.coverData) {
    return '';
  }
  ensureDir(coversDir);
  const extension = COVER_EXTENSIONS[parsed.cover.mediaType] || path.extname(parsed.cover.href) || '.img';
  const hash = crypto.createHash('sha1').update(parsed.coverData).digest('hex');
  const fileName = `${hash}${extension}`;
  const destPath = path.join(coversDir, fileName);
  if (!fs.existsSync(destPath)) {
    fs.writeFileSync(destPath, parsed.coverData);
  }
  const coverPath = `${EPUB_COVER_CACHE_PATH}/${encodeURIComponent(fileName)}`;
  return options.absolute ? `http://localhost:${serverPort}${coverPath}` : coverPath;
}

// 已保存 EPUB 书籍的封面：解析一次后缓存在内存里
const epubCoverCache = new Map();
const EPUB_COVER_CACHE_LIMIT = 50;

function extractEpubCover(book) {
  if (!book || !book.storedPath || !fs.existsSync(book.storedPath)) {
    return null;
  }
  const stats = fs.statSync(book.storedPath);
  const key = `${book.storedPath}|${stats.mtimeMs}`;
  if (epubCoverCache.has(key)) {
    return epubCoverCache.get(key);
  }
  let cover = null;
  try {
    const parsed = parseEpubBuffer(fs.readFileSync(book.storedPath), {
      inlineImages: false,
      inlineStyles: false,
      includeText: false,
      includeChapters: false
    });
    cover = parsed.cover && parsed.coverData
      ? { mediaType: parsed.cover.mediaType, data: parsed.coverData }
      : null;
  } catch (error) {
    console.warn(`[epub] 封面提取失败 ${book.storedPath}：${error.message}`);
    cover = null;
  }
  epubCoverCache.set(key, cover);
  if (epubCoverCache.size > EPUB_COVER_CACHE_LIMIT) {
    epubCoverCache.delete(epubCoverCache.keys().next().value);
  }
  return cover;
}

// 上传 EPUB 时自动补全书名/作者/简介/目录项，并标记是否包含封面
function enrichBookFromEpub(sourcePath, payload = {}, rules) {
  if (path.extname(String(sourcePath || '')).toLowerCase() !== EPUB_EXTENSION) {
    return payload;
  }
  let parsed = null;
  try {
    parsed = parseEpubBuffer(fs.readFileSync(sourcePath), { includeText: false, rules });
  } catch (error) {
    console.warn(`[epub] 元数据解析失败 ${sourcePath}：${error.message}`);
    return payload;
  }
  const summary = buildEpubSummary(parsed);
  return {
    ...payload,
    title: payload.title || summary.title,
    author: payload.author || summary.author,
    description: payload.description || summary.description,
    directoryEntries: payload.directoryEntries || epubDirectoryEntries(parsed),
    epubCoverAvailable: Boolean(parsed.cover)
  };
}

// EPUB 书籍的封面统一走 /book-cover，无需把 base64 写进数据库
function insertBookWithCover(book) {
  const inserted = database.insertBook(book);
  if (!inserted.coverImg && isEpubBook(inserted) && book.epubCoverAvailable !== false) {
    const coverImg = epubCoverUrl(inserted.id);
    database.updateBookCover(inserted.id, coverImg);
    return { ...inserted, coverImg };
  }
  return inserted;
}

// 编辑书籍时：EPUB 封面留空表示沿用既有地址，避免误删自动封面
function resolveUpdatedCover(book, incomingCoverImg) {
  const value = typeof incomingCoverImg === 'string' ? incomingCoverImg.trim() : '';
  if (value) {
    return value;
  }
  return isEpubBook(book) ? (book.coverImg || '') : '';
}

// 按书籍类型选择解析方式：EPUB 走 epubParser，TXT 走章节规则解析
function loadBookChapters(book, rules, directoryEntries) {
  if (isEpubBook(book)) {
    const parsed = parseEpubBuffer(fs.readFileSync(book.storedPath), {
      inlineImages: true,
      rules,
      directoryEntries
    });
    return {
      chapters: parsed.chapters.map((chapter) => ({ title: chapter.title, content: chapter.content })),
      // 封面以 URL 提供（书籍已保存，走 /book-cover）
      epub: { ...buildEpubSummary(parsed, resolveCoverUrl(book.coverImg)), chapters: parsed.chapters }
    };
  }
  const chapters = parseTextToChapters(fs.readFileSync(book.storedPath, 'utf8'), rules, directoryEntries);
  return { chapters, epub: null };
}

function serializeForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const COVER_PROXY_PATH = '/cover-proxy';
const COVER_PROXY_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function buildCoverProxyUrl(coverImg, options = {}) {
  const value = typeof coverImg === 'string' ? coverImg.trim() : '';
  if (!value || !/^https?:\/\//i.test(value) || value.includes(`${COVER_PROXY_PATH}?url=`)) {
    return value;
  }
  const proxyPath = `${COVER_PROXY_PATH}?url=${encodeURIComponent(value)}`;
  return options.absolute ? `http://localhost:${serverPort}${proxyPath}` : proxyPath;
}

function buildCoverProxyUrl(coverImg, options = {}) {
  const value = typeof coverImg === 'string' ? coverImg.trim() : '';
  if (!value || !/^https?:\/\//i.test(value) || value.includes(`${COVER_PROXY_PATH}?url=`)) {
    return value;
  }
  const proxyPath = `${COVER_PROXY_PATH}?url=${encodeURIComponent(value)}`;
  return options.absolute ? `http://localhost:${serverPort}${proxyPath}` : proxyPath;
}

// 封面地址统一处理：外部 http 地址走代理，本地接口地址按需补全为绝对地址
function resolveCoverUrl(coverImg, options = {}) {
  const value = typeof coverImg === 'string' ? coverImg.trim() : '';
  if (!value) {
    return '';
  }
  if (/^https?:\/\//i.test(value)) {
    return buildCoverProxyUrl(value, options);
  }
  if (value.startsWith('/')) {
    return options.absolute ? `http://localhost:${serverPort}${value}` : value;
  }
  // data: 等其它形式（历史数据）原样返回
  return value;
}

// Returns the book with `coverImg` replaced by the servable URL and keeps the
// original address in `coverImgSource` so edit forms don't save the proxy back.
function decorateBookCover(book, options) {
  if (!book) {
    return book;
  }
  return {
    ...book,
    coverImg: resolveCoverUrl(book.coverImg, options),
    coverImgSource: book.coverImg || ''
  };
}

function sniffImageContentType(buffer, fallback) {
  const ascii = (start, end) => buffer.subarray(start, end).toString('ascii');
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 3 && ascii(0, 3) === 'GIF') {
    return 'image/gif';
  }
  if (buffer.length >= 4 && buffer[0] === 0x89 && ascii(1, 4) === 'PNG') {
    return 'image/png';
  }
  if (buffer.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return fallback;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 840,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startStaticServer(openBrowser = false) {
  if (serverInstance) {
    return { url: `http://localhost:${serverPort}/`, running: true };
  }
  ensureDir(htmlDir);
  ensureDir(coversDir);
  const appServer = express();
  appServer.use(express.json());
  appServer.use(express.urlencoded({ extended: true }));

  // 仅解析（尚未保存）的 EPUB 封面缓存目录
  appServer.use(EPUB_COVER_CACHE_PATH, express.static(coversDir, { index: false, maxAge: '7d' }));

  // 已保存 EPUB 书籍的封面：从 EPUB 文件中提取后按 URL 返回（不内嵌 base64）
  appServer.get(BOOK_COVER_PATH, async (req, res) => {
    const bookId = Number(req.query.id);
    if (!Number.isFinite(bookId)) {
      return res.status(400).send('id 不能为空');
    }
    const book = database.getBookById(bookId);
    if (!book) {
      return res.status(404).send('书籍未找到');
    }
    if (isEpubBook(book)) {
      const cover = extractEpubCover(book);
      if (!cover) {
        return res.status(404).send('该 EPUB 未包含封面');
      }
      res.set('Content-Type', cover.mediaType || 'application/octet-stream');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(cover.data);
    }
    if (/^https?:\/\//i.test(String(book.coverImg || ''))) {
      return res.redirect(`${COVER_PROXY_PATH}?url=${encodeURIComponent(book.coverImg)}`);
    }
    return res.status(404).send('封面未找到');
  });

  // 封面图片代理：由后台请求外部封面地址再返回给前端，规避防盗链导致的封面无法显示。
  // 注册在日志中间件之前，避免把图片二进制写入 API 日志。
  appServer.get(COVER_PROXY_PATH, async (req, res) => {
    const targetUrl = String(req.query.url || '');
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      return res.status(400).send('无效的封面 URL');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return res.status(400).send('仅支持 http/https 封面地址');
    }
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), 15000);
    try {
      const upstream = await fetch(parsedUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': COVER_PROXY_USER_AGENT,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        }
      });
      if (!upstream.ok) {
        return res.status(502).send(`封面请求失败：HTTP ${upstream.status}`);
      }
      const upstreamType = (upstream.headers.get('content-type') || '').toLowerCase();
      if (upstreamType.includes('text/html') || upstreamType.includes('json')) {
        return res.status(502).send('封面来源拒绝访问（可能存在防盗链限制）');
      }
      const buffer = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstreamType.startsWith('image/')
        ? upstreamType
        : sniffImageContentType(buffer, upstreamType || 'image/jpeg');
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buffer);
    } catch (error) {
      const reason = error && error.name === 'AbortError' ? '请求超时' : (error && error.message) || '未知错误';
      console.warn(`[cover-proxy] ${parsedUrl.href} ${reason}`);
      return res.status(502).send(`封面请求失败：${reason}`);
    } finally {
      clearTimeout(timeoutTimer);
    }
  });

  const upload = multer({ dest: path.join(appDataDir, 'temp') });

  // EPUB 直接在内存中解析，避免临时文件清理问题
  const epubUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 300 * 1024 * 1024 }
  });

  function readEpubOptions(body = {}) {
    return {
      inlineImages: body.inlineImages !== 'false' && body.inlineImages !== false,
      inlineStyles: body.inlineStyles !== 'false' && body.inlineStyles !== false,
      unwrapImages: body.unwrapImages !== 'false' && body.unwrapImages !== false,
      blockImages: body.blockImages !== 'false' && body.blockImages !== false,
      notesToEnd: body.notesToEnd !== 'false' && body.notesToEnd !== false,
      notesTitle: typeof body.notesTitle === 'string' ? body.notesTitle : undefined
    };
  }

  // 上传并解析 EPUB，返回章节内容（章节图片已内嵌 base64；封面以 URL 返回）
  appServer.post('/data-operate/epub/parse', epubUpload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file || !file.buffer || file.buffer.length === 0) {
      return res.status(400).json({ message: 'EPUB 文件不能为空' });
    }
    try {
      const parsed = parseEpubBuffer(file.buffer, { ...readEpubOptions(req.body), rules: await loadRules(rulesPath) });
      return res.json({
        message: '解析成功',
        fileName: file.originalname,
        size: `${Math.round(file.buffer.length / 1024)} KB`,
        // 用相对地址返回，客户端（如阅读 App/书源）会按请求域名补全，避免写成 localhost
        book: buildEpubSummary(parsed, cacheEpubCover(parsed)),
        toc: parsed.toc,
        chapters: parsed.chapters,
        images: parsed.images,
        stats: parsed.stats
      });
    } catch (error) {
      console.warn(`[epub] 解析失败 ${file.originalname}：${error.message}`);
      return res.status(400).json({ message: `EPUB 解析失败：${error.message}` });
    }
  });

  // 上传 EPUB、解析元数据并保存为书籍（封面保存为 /book-cover 地址）
  appServer.post('/data-operate/epub/upload', epubUpload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file || !file.buffer || file.buffer.length === 0) {
      return res.status(400).json({ message: 'EPUB 文件不能为空' });
    }
    let parsed = null;
    const epubRules = await loadRules(rulesPath);
    try {
      parsed = parseEpubBuffer(file.buffer, { ...readEpubOptions(req.body), rules: epubRules });
    } catch (error) {
      console.warn(`[epub] 解析失败 ${file.originalname}：${error.message}`);
    }
    const fallbackTitle = path.basename(file.originalname || 'book', path.extname(file.originalname || ''));
    const title = (req.body.bookName || (parsed && parsed.title) || fallbackTitle).trim();
    const storedPath = saveBookBuffer(file.buffer, booksDir, title, EPUB_EXTENSION);
    const stats = fs.statSync(storedPath);
    const book = {
      title,
      author: (req.body.authorName || (parsed && parsed.author) || '').trim(),
      description: (req.body.desc || (parsed && parsed.description) || '').trim(),
      coverImg: '',
      sourcePath: file.originalname,
      storedPath,
      fileName: path.basename(storedPath),
      size: `${Math.round(stats.size / 1024)} KB`,
      fileType: 'epub',
      directoryEntries: parsed ? epubDirectoryEntries(parsed) : splitDirectoryEntries(req.body.directoryEntries || '').join('\n'),
      createdAt: new Date().toISOString(),
      epubCoverAvailable: Boolean(parsed && parsed.cover)
    };
    const inserted = insertBookWithCover(book);
    return res.json({
      message: 'EPUB 上传成功',
      book: decorateBookCover(inserted),
      parsed: parsed
        ? {
          meta: buildEpubSummary(parsed, resolveCoverUrl(inserted.coverImg)),
          chapters: parsed.chapters,
          images: parsed.images,
          stats: parsed.stats
        }
        : null
    });
  });

  appServer.post('/data-operate/submitForm', upload.single('file'), async (req, res) => {
    const file = req.file;
    const { bookName, desc, authorName, coverImg, directoryEntries } = req.body;
    if (!file) {
      return res.status(400).json({ message: '文件不能为空' });
    }
    // EPUB 会先解析出元数据补全表单里留空的字段
    const enriched = enrichBookFromEpub(file.path, {
      title: bookName,
      author: authorName,
      description: desc,
      coverImg,
      directoryEntries
    }, await loadRules(rulesPath));
    const extension = path.extname(file.originalname || '');
    const fallbackTitle = path.basename(file.originalname || 'book', extension);
    const title = (enriched.title || fallbackTitle).trim();
    const isEpub = extension.toLowerCase() === EPUB_EXTENSION;
    if (!title) {
      fs.unlinkSync(file.path);
      return res.status(400).json({ message: '书名不能为空' });
    }
    const storedPath = saveBookFile(file.path, booksDir, title, extension);
    fs.unlinkSync(file.path);
    const stats = fs.statSync(storedPath);
    const book = {
      title,
      author: enriched.author || '',
      description: enriched.description || '',
      // EPUB 的封面由 /book-cover 提供，这里不再内嵌 base64
      coverImg: isEpub ? '' : (enriched.coverImg || ''),
      sourcePath: file.originalname,
      storedPath,
      fileName: path.basename(storedPath),
      size: `${Math.round(stats.size / 1024)} KB`,
      fileType: path.extname(storedPath).replace('.', ''),
      directoryEntries: splitDirectoryEntries(enriched.directoryEntries).join('\n'),
      createdAt: new Date().toISOString(),
      epubCoverAvailable: isEpub ? enriched.epubCoverAvailable !== false : undefined
    };
    const inserted = insertBookWithCover(book);
    return res.json({ message: '提交成功', book: decorateBookCover(inserted) });
  });

  appServer.get('/data-operate/delete', async (req, res) => {
    const bookId = req.query.id;
    if (!bookId) {
      return res.status(400).json({ message: 'id 不能为空' });
    }
    const book = database.getBookById(Number(bookId));
    if (!book) {
      return res.status(404).json({ message: '书籍未找到' });
    }
    database.deleteBook(book.id);
    if (book.storedPath && fs.existsSync(book.storedPath)) {
      fs.unlinkSync(book.storedPath);
    }
    return res.json({ message: '删除成功' });
  });

  appServer.post('/data-operate/update', async (req, res) => {
    const { id, title, author, description, coverImg, directoryEntries } = req.body || {};
    if (!id) {
      return res.status(400).json({ message: 'id 不能为空' });
    }
    const existing = database.getBookById(Number(id));
    if (!existing) {
      return res.status(404).json({ message: '书籍未找到' });
    }
    database.updateBook({
      id: Number(id),
      title: title ?? existing.title,
      author: author ?? existing.author ?? '',
      description: description ?? existing.description ?? '',
      coverImg: coverImg === undefined
        ? (existing.coverImg || '')
        : resolveUpdatedCover(existing, coverImg),
      directoryEntries: directoryEntries === undefined
        ? existing.directoryEntries || ''
        : splitDirectoryEntries(directoryEntries).join('\n')
    });
    return res.json({ message: '更新成功' });
  });

  appServer.get('/open-folder', async (req, res) => {
    const bookId = req.query.id;
    if (!bookId) {
      return res.status(400).send('id 不能为空');
    }
    const book = database.getBookById(Number(bookId));
    if (!book) {
      return res.status(404).send('书籍未找到');
    }
    if (!book.storedPath) {
      return res.status(404).send('书籍路径未找到');
    }
    const dir = path.dirname(book.storedPath);
    try {
      await shell.openPath(dir);
      return res.send('ok');
    } catch (error) {
      return res.status(500).send(error.message);
    }
  });

  appServer.get('/', async (req, res) => {
    const books = database.listBooks().map((book) => decorateBookCover(book));
    const rows = books.map((book) => `
      <li class="book-item">
        <div class="book-meta">
          <h3><a href="/detail?id=${book.id}">${book.title}</a></h3>
          <p>大小：${book.size}</p>
          ${book.coverImg ? `<img class="cover-img" src="${book.coverImg}" alt="封面" />` : '<p>封面：—</p>'}
        </div>
        <div class="book-actions">
          <button class="action-link" type="button" onclick="editBookById(${book.id});">编辑</button>
          <button class="action-link" type="button" onclick="deleteBook(${book.id});">删除</button>
          <button class="action-link" type="button" onclick="openFolder(${book.id});">打开文件夹</button>
        </div>
      </li>
    `).join('');
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>书籍管理</title><style>
      *{box-sizing:border-box;}
      body{margin:0;font-family:'Segoe UI','Helvetica Neue','PingFang SC','Microsoft YaHei',Arial,sans-serif;background:#f4f7fb;color:#0f172a;min-height:100vh;}
      ::selection{background:#bfdbfe;}
      ::-webkit-scrollbar{width:10px;}
      ::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:6px;border:2px solid #f4f7fb;}
      ::-webkit-scrollbar-thumb:hover{background:#94a3b8;}
      .container{max-width:1120px;margin:0 auto;padding:36px 20px 56px;}
      .header{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:26px;}
      .header-title{margin:0;line-height:1.15;}
      .header-title h1{font-size:28px;margin:0;color:#0f172a;letter-spacing:.3px;}
      .header-title p{margin:8px 0 0;color:#64748b;font-size:14px;}
      .btn{display:inline-flex;align-items:center;justify-content:center;padding:11px 20px;border-radius:12px;border:none;font-weight:600;font-size:14px;cursor:pointer;transition:all .18s ease;}
      .btn-primary{background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;box-shadow:0 10px 24px rgba(37,99,235,.25);}
      .btn-primary:hover{transform:translateY(-1px);box-shadow:0 14px 30px rgba(37,99,235,.32);}
      .btn-primary:active{transform:translateY(0);box-shadow:0 6px 16px rgba(37,99,235,.25);}
      button:focus-visible{outline:2px solid #93c5fd;outline-offset:2px;}
      .book-list{list-style:none;margin:0;padding:0;display:grid;gap:14px;}
      .book-item{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:16px 20px;border-radius:16px;background:#fff;border:1px solid #e8edf3;box-shadow:0 3px 14px rgba(15,23,42,.05);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;}
      .book-item:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(15,23,42,.09);border-color:#dbe7f5;}
      .book-meta{min-width:0;display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:18px;}
      .book-meta:not(:has(.cover-img)){display:block;}
      .book-meta h3{grid-column:2;align-self:end;margin:0 0 3px;font-size:19px;color:#0f172a;line-height:1.35;}
      .book-meta h3 a{color:inherit;text-decoration:none;transition:color .15s ease;}
      .book-meta h3 a:hover{color:#2563eb;}
      .book-meta p{grid-column:2;align-self:start;margin:0;color:#64748b;font-size:13px;line-height:1.6;}
      .book-meta img.cover-img{grid-column:1;grid-row:1 / span 3;display:block;height:104px;width:72px;object-fit:cover;border-radius:8px;border:1px solid #eef2f7;box-shadow:0 8px 20px rgba(15,23,42,.10);}
      .book-list:empty::after{content:'暂无书籍，点击右上角「新增书籍」上传。';display:block;padding:48px 20px;text-align:center;color:#94a3b8;font-size:14px;background:#fff;border:1px dashed #e2e8f0;border-radius:16px;grid-column:1 / -1;}
      .book-actions{display:flex;gap:10px;flex-wrap:wrap;}
      .action-link{padding:8px 16px;border-radius:10px;border:1px solid #bfdbfe;background:#fff;color:#2563eb;text-decoration:none;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit;transition:all .16s ease;}
      .action-link:hover{background:#2563eb;border-color:#2563eb;color:#fff;text-decoration:none;transform:translateY(-1px);box-shadow:0 6px 14px rgba(37,99,235,.25);}
      .book-actions .action-link:nth-child(2){border-color:#fecaca;color:#dc2626;}
      .book-actions .action-link:nth-child(2):hover{background:#dc2626;border-color:#dc2626;color:#fff;box-shadow:0 6px 14px rgba(220,38,38,.25);}
      .message{display:none;padding:13px 18px;border-radius:12px;margin-bottom:18px;font-size:14px;border:1px solid transparent;}
      .message.info{background:#eff6ff;border-color:#bfdbfe;color:#075985;}
      .message.error{background:#fef2f2;border-color:#fecaca;color:#991b1b;}
      .modal{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;z-index:1000;}
      .modal.active{display:flex;}
      .modal-panel{width:100%;max-width:640px;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 32px 80px rgba(15,23,42,.25);animation:panelIn .18s ease;}
      @keyframes panelIn{from{opacity:0;transform:translateY(12px) scale(.98);}to{opacity:1;transform:none;}}
      .modal-header{display:flex;justify-content:space-between;align-items:center;padding:20px 26px;border-bottom:1px solid #e2e8f0;}
      .modal-header h2{margin:0;font-size:19px;color:#0f172a;}
      .close-btn{border:none;background:transparent;color:#64748b;font-size:24px;cursor:pointer;line-height:1;width:34px;height:34px;border-radius:8px;transition:all .15s ease;}
      .close-btn:hover{background:#f1f5f9;color:#0f172a;}
      .modal-body{padding:22px 26px;}
      .field{margin-bottom:16px;}
      .field label{display:block;margin-bottom:7px;font-size:13px;font-weight:600;color:#475569;}
      .field input[type=text],.field textarea,.field input[type=file]{width:100%;padding:12px 14px;border:1px solid #d1d5db;border-radius:10px;background:#f8fafc;color:#0f172a;font-size:14px;font-family:inherit;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease;}
      .field input[type=text]:focus,.field textarea:focus{outline:none;background:#fff;border-color:#93c5fd;box-shadow:0 0 0 3px rgba(37,99,235,.12);}
      .field textarea{min-height:110px;resize:vertical;}
      .modal-footer{padding:16px 26px 22px;text-align:right;background:#f8fafc;border-top:1px solid #e2e8f0;}
      .modal-footer .btn-secondary{margin-right:10px;background:#fff;color:#334155;border:1px solid #e2e8f0;box-shadow:none;}
      .modal-footer .btn-secondary:hover{background:#f1f5f9;border-color:#cbd5e1;transform:none;}
      .hint{font-size:12px;color:#94a3b8;margin-top:6px;}
      @media (max-width:640px){
        .book-item{flex-direction:column;align-items:flex-start;}
        .book-actions{width:100%;justify-content:flex-end;}
      }
    </style></head><body>
    <div class="container">
      <div class="header">
        <div class="header-title">
          <h1>书籍管理</h1>
          <p>通过此页面管理已上传的书籍，并可以打开本地文件夹查看内容。</p>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <a class="btn btn-primary" href="/epub" style="text-decoration:none;">EPUB 解析</a>
          <button class="btn btn-primary" onclick="showModal()">新增书籍</button>
        </div>
      </div>
      <div id="message" class="message info"></div>
      <ul id="books" class="book-list">${rows}</ul>
    </div>
    <div id="bookModal" class="modal">
      <div class="modal-panel">
        <div class="modal-header">
          <h2>新增书籍</h2>
          <button class="close-btn" onclick="hideModal()">×</button>
        </div>
        <form id="uploadForm" method="post" enctype="multipart/form-data" onsubmit="submitForm(event)">
          <div class="modal-body">
            <div class="field"><label>文件</label><input type="file" name="file" accept=".txt,.md,.epub" required /></div>
            <div class="field"><label>书名</label><input type="text" name="bookName" required /></div>
            <div class="field"><label>作者</label><input type="text" name="authorName" /></div>
            <div class="field"><label>描述</label><textarea name="desc"></textarea></div>
            <div class="field"><label>封面</label><input type="text" name="coverImg" placeholder="封面 URL，可选" /></div>
            <div class="field"><label>目录项</label><textarea name="directoryEntries" rows="5" placeholder="每行一条，换行分隔"></textarea></div>
            <div class="hint">提交后书籍会保存至本地目录，目录内容会按行 trim 后用于匹配。</div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="hideModal()">取消</button>
            <button type="submit" class="btn btn-primary">提交</button>
          </div>
        </form>
      </div>
    </div>
    <div id="editModal" class="modal">
      <div class="modal-panel">
        <div class="modal-header">
          <h2>编辑书籍</h2>
          <button class="close-btn" onclick="hideEditModal()">×</button>
        </div>
        <div class="modal-body">
          <input id="editBookId" type="hidden" />
          <div class="field"><label>书名</label><input id="editBookTitle" type="text" /></div>
          <div class="field"><label>作者</label><input id="editBookAuthor" type="text" /></div>
          <div class="field"><label>描述</label><textarea id="editBookDescription"></textarea></div>
          <div class="field"><label>封面</label><input id="editBookCover" type="text" /></div>
          <div class="field"><label>目录项</label><textarea id="editBookDirectory" rows="5" placeholder="每行一条"></textarea></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" onclick="hideEditModal()">取消</button>
          <button type="button" class="btn btn-primary" onclick="saveEditBook()">保存</button>
        </div>
      </div>
    </div>
    <script>
      let editingBook = null;
      const initialBooks = ${serializeForScript(books)};
      const booksById = new Map(initialBooks.map((book) => [String(book.id), book]));
      function showModal(){document.getElementById('bookModal').classList.add('active');}
      function hideModal(){document.getElementById('bookModal').classList.remove('active');}
      function showEditModal(book){
        editingBook = book;
        document.getElementById('editBookId').value = book.id;
        document.getElementById('editBookTitle').value = book.title || '';
        document.getElementById('editBookAuthor').value = book.author || '';
        document.getElementById('editBookDescription').value = book.description || '';
        document.getElementById('editBookCover').value = book.coverImgSource ?? book.coverImg ?? '';
        document.getElementById('editBookDirectory').value = book.directoryEntries || '';
        document.getElementById('editModal').classList.add('active');
      }
      function hideEditModal(){document.getElementById('editModal').classList.remove('active'); editingBook = null;}
      function editBookById(bookId){
        const book = booksById.get(String(bookId));
        if (!book) {
          showMessage('找不到书籍信息', 'error');
          return;
        }
        showEditModal(book);
      }
      async function saveEditBook(){
        if (!editingBook) return;
        const body = {
          id: Number(document.getElementById('editBookId').value),
          title: document.getElementById('editBookTitle').value,
          author: document.getElementById('editBookAuthor').value,
          description: document.getElementById('editBookDescription').value,
          coverImg: document.getElementById('editBookCover').value,
          directoryEntries: document.getElementById('editBookDirectory').value
        };
        try {
          const response = await fetch('/data-operate/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          if (!response.ok) {
            const text = await response.text();
            throw new Error(text || '保存失败');
          }
          hideEditModal();
          showMessage('保存成功');
          setTimeout(()=>location.reload(), 400);
        } catch (error) {
          showMessage(error.message || '保存失败', 'error');
        }
      }
      function showMessage(text,type='info'){
        const msg=document.getElementById('message');
        msg.textContent=text;
        msg.className='message '+(type==='error'?'error':'info');
        msg.style.display='block';
        clearTimeout(window._msgTimer);
        window._msgTimer=setTimeout(()=>{msg.style.display='none';},4500);
      }
      async function submitForm(event){
        event.preventDefault();
        const form = event.currentTarget;
        const formData = new FormData(form);
        try {
          const response = await fetch('/data-operate/submitForm', {
            method: 'POST',
            body: formData
          });
          if (!response.ok) {
            const text = await response.text();
            throw new Error(text || '提交失败');
          }
          const result = await response.json();
          showMessage('提交成功');
          hideModal();
          form.reset();
          setTimeout(()=>location.reload(),500);
        } catch (error) {
          showMessage(error.message || '提交失败','error');
        }
      }
      function deleteBook(id){
        if(!confirm('确认删除该书籍？')){return;}
        fetch('/data-operate/delete?id='+encodeURIComponent(id)).then((response)=>{
          if(response.ok){showMessage('删除成功');setTimeout(()=>location.reload(),500);}else{response.text().then(text=>showMessage('删除失败: '+text,'error'));}
        }).catch((err)=>showMessage('删除失败: '+err.message,'error'));
      }
      function openFolder(id){
        fetch('/open-folder?id='+encodeURIComponent(id)).then((response)=>{
          if(response.ok){showMessage('已打开书籍所在文件夹');}else{response.text().then(text=>showMessage('打开失败: '+text,'error'));}
        }).catch((err)=>showMessage('打开失败: '+err.message,'error'));
      }
    </script>
  </body></html>`;
    res.send(html);
  });

  appServer.get('/detail', async (req, res) => {
    const bookId = req.query.id;
    if (!bookId) {
      return res.status(400).send('id 不能为空');
    }
    const storedBook = database.getBookById(Number(bookId));
    if (!storedBook) {
      return res.status(404).send('书籍未找到');
    }
    const book = decorateBookCover(storedBook);
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>详情</title></head><body><a id="path" href="/bookinfo?id=${book.id}">${book.title}</a><img id="cover" src="${book.coverImg || ''}" style="max-width:200px;display:block;margin:16px 0;"/><div id="intro">${book.description}</div><div id="author">${book.author}</div></body></html>`;
    res.send(html);
  });

  appServer.get('/bookinfo', async (req, res) => {
    const bookId = req.query.id;
    if (!bookId) {
      return res.status(400).send('id 不能为空');
    }
    const book = database.getBookById(Number(bookId));
    if (!book) {
      return res.status(404).send('书籍未找到');
    }
    const { chapters } = loadBookChapters(
      book,
      await loadRules(rulesPath),
      splitDirectoryEntries(book.directoryEntries)
    );
    const items = chapters.map((chapter, index) => `<li><a href="/content?id=${encodeURIComponent(crypto.createHash('md5').update(book.id + '-' + index).digest('hex'))}&bookId=${book.id}">${chapter.title}</a></li>`).join('');
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>目录页面</title><style>
      body{margin:0;font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;background:#f4f7fb;color:#0f172a;}
      .page{max-width:900px;margin:32px auto;padding:0 20px;}
      h1{font-size:28px;margin-bottom:18px;color:#111827;}
      #chapter{background:#fff;border-radius:24px;padding:24px 28px;box-shadow:0 20px 50px rgba(15,23,42,.08);}
      #books{list-style:none;margin:0;padding:0;}
      #books li{padding:16px 18px;border-bottom:1px solid #e2e8f0;}
      #books li:last-child{border-bottom:none;}
      #books li a{color:#2563eb;text-decoration:none;font-size:16px;font-weight:500;}
      #books li a:hover{text-decoration:underline;}
    </style></head><body><div class="page"><h1>${book.title} 目录</h1><div id="chapter"><ul id="books">${items}</ul></div></div></body></html>`;
    res.send(html);
  });

  appServer.get('/content', async (req, res) => {
    const id = req.query.id;
    const bookId = req.query.bookId;
    if (!id || !bookId) {
      return res.status(400).send('id 和 bookId 不能为空');
    }
    const book = database.getBookById(Number(bookId));
    if (!book) {
      return res.status(404).send('书籍未找到');
    }
    const isEpub = isEpubBook(book);
    const { chapters } = loadBookChapters(
      book,
      await loadRules(rulesPath),
      splitDirectoryEntries(book.directoryEntries)
    );
    let chapterContent = '';
    chapters.forEach((chapter, index) => {
      const chunkId = crypto.createHash('md5').update(book.id + '-' + index).digest('hex');
      if (chunkId === id) {
        // EPUB 章节已是包含 base64 图片的 HTML，直接输出
        chapterContent = isEpub ? chapter.content : chapter.content.replace(/\n/g, '<br/>');
      }
    });
    if (!chapterContent) {
      return res.status(404).send('章节未找到');
    }
    res.send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>正文</title></head><body><div id="content">${chapterContent}</div></body></html>`);
  });

  // 浏览器端 EPUB 上传页：上传后解析并以内嵌 base64 图片的方式展示章节
  appServer.get('/epub', (req, res) => {
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>EPUB 上传解析</title><style>
      *{box-sizing:border-box;}
      body{margin:0;font-family:'Segoe UI','Helvetica Neue','PingFang SC','Microsoft YaHei',Arial,sans-serif;background:#f4f7fb;color:#0f172a;}
      .container{max-width:1000px;margin:0 auto;padding:32px 20px 64px;}
      h1{font-size:26px;margin:0 0 6px;}
      .sub{color:#64748b;font-size:14px;margin:0 0 22px;}
      .card{background:#fff;border:1px solid #e8edf3;border-radius:16px;padding:20px 22px;box-shadow:0 6px 20px rgba(15,23,42,.05);margin-bottom:20px;}
      .row{display:flex;gap:12px;flex-wrap:wrap;align-items:center;}
      .field{margin-bottom:14px;}
      .field label{display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:6px;}
      input[type=text],input[type=file]{width:100%;padding:11px 13px;border:1px solid #d1d5db;border-radius:10px;background:#f8fafc;font-size:14px;font-family:inherit;}
      button{padding:11px 20px;border:none;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font-weight:600;font-size:14px;cursor:pointer;}
      button.ghost{background:#fff;color:#334155;border:1px solid #e2e8f0;}
      button:disabled{opacity:.6;cursor:not-allowed;}
      .hint{font-size:12px;color:#94a3b8;margin-top:8px;}
      .msg{display:none;padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:14px;}
      .msg.info{background:#eff6ff;color:#075985;border:1px solid #bfdbfe;}
      .msg.error{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;}
      .meta{display:flex;gap:18px;align-items:flex-start;}
      .meta img{width:110px;border-radius:10px;border:1px solid #eef2f7;box-shadow:0 8px 20px rgba(15,23,42,.10);}
      .meta h2{margin:0 0 6px;font-size:20px;}
      .meta p{margin:0 0 6px;font-size:13px;color:#64748b;line-height:1.7;}
      .chapter{border:1px solid #e5e7eb;border-radius:10px;margin-bottom:10px;overflow:hidden;}
      .chapter-head{display:flex;gap:10px;align-items:center;padding:12px 14px;cursor:pointer;user-select:none;}
      .chapter-head:hover{background:#f8fafc;}
      .chapter-no{min-width:28px;height:22px;padding:0 6px;border-radius:999px;background:#eff6ff;color:#2563eb;font-size:12px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;}
      .chapter-title{flex:1;min-width:0;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .chapter-toggle{font-size:12px;color:#2563eb;}
      .chapter-body{display:none;padding:14px 18px;border-top:1px solid #e5e7eb;font-size:14px;line-height:1.9;color:#374151;max-height:520px;overflow:auto;}
      .chapter-body img{max-width:100%;height:auto;}
      .chapter.open .chapter-body{display:block;}
    </style></head><body><div class="container">
      <h1>EPUB 上传解析</h1>
      <p class="sub">上传 EPUB 文件后即可解析章节，章节内的图片会以 base64 data URI 内嵌在返回的 HTML 中，封面则通过 URL 提供。</p>
      <div id="message" class="msg info"></div>
      <div class="card">
        <div class="field"><label>EPUB 文件</label><input id="file" type="file" accept=".epub,application/epub+zip" /></div>
        <div class="row">
          <div class="field" style="flex:1;min-width:220px;margin-bottom:0;"><label>书名（留空自动读取）</label><input id="bookName" type="text" /></div>
          <div class="field" style="flex:1;min-width:220px;margin-bottom:0;"><label>作者（留空自动读取）</label><input id="authorName" type="text" /></div>
        </div>
        <div class="row" style="margin-top:16px;">
          <button id="parseBtn">上传并解析</button>
          <button id="saveBtn" class="ghost">保存为书籍</button>
        </div>
        <div class="hint">章节图片已是 base64，封面则通过封面 URL 加载。</div>
      </div>
      <div id="result"></div>
    </div>
    <script>
      const message = document.getElementById('message');
      const fileInput = document.getElementById('file');
      const result = document.getElementById('result');
      let currentFile = null;
      let lastParsed = null;
      function showMessage(text, type = 'info') {
        message.textContent = text;
        message.className = 'msg ' + (type === 'error' ? 'error' : 'info');
        message.style.display = 'block';
      }
      function escapeHtml(value) {
        return String(value == null ? '' : value)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }
      function renderParsed(payload) {
        const book = payload.book || {};
        const chapters = payload.chapters || [];
        const stats = payload.stats || {};
        const parts = ['<div class="card"><div class="meta">'];
        if (book.coverImg) {
          parts.push('<img src="' + book.coverImg + '" alt="封面" />');
        }
        parts.push('<div><h2>' + escapeHtml(book.title || payload.fileName || '未命名') + '</h2>');
        parts.push('<p>作者：' + escapeHtml(book.author || '未知') + '　语言：' + escapeHtml(book.language || '-') + '</p>');
        parts.push('<p>章节：' + chapters.length + '　内嵌图片：' + (stats.imageCount || 0) + '　文件大小：' + escapeHtml(payload.size || '-') + '</p>');
        if (book.description) {
          parts.push('<p>' + escapeHtml(book.description) + '</p>');
        }
        parts.push('</div></div></div>');
        parts.push('<div class="card"><h2 style="margin:0 0 14px;font-size:17px;">章节目录</h2>');
        chapters.forEach((chapter, index) => {
          parts.push('<div class="chapter" data-index="' + index + '"><div class="chapter-head"><span class="chapter-no">' + (index + 1) + '</span><span class="chapter-title">' + escapeHtml(chapter.title) + '</span><span class="chapter-toggle">展开</span></div><div class="chapter-body"></div></div>');
        });
        parts.push('</div>');
        result.innerHTML = parts.join('');
        const chapterList = chapters;
        result.querySelectorAll('.chapter').forEach((element) => {
          const head = element.querySelector('.chapter-head');
          const body = element.querySelector('.chapter-body');
          head.addEventListener('click', () => {
            const open = element.classList.toggle('open');
            head.querySelector('.chapter-toggle').textContent = open ? '收起' : '展开';
            if (open && !body.dataset.loaded) {
              body.innerHTML = chapterList[Number(element.dataset.index)].content;
              body.dataset.loaded = '1';
            }
          });
        });
      }
      function buildFormData() {
        const formData = new FormData();
        formData.append('file', currentFile);
        formData.append('bookName', document.getElementById('bookName').value.trim());
        formData.append('authorName', document.getElementById('authorName').value.trim());
        return formData;
      }
      document.getElementById('parseBtn').onclick = async () => {
        currentFile = fileInput.files && fileInput.files[0];
        if (!currentFile) {
          showMessage('请先选择 EPUB 文件', 'error');
          return;
        }
        showMessage('正在解析……');
        try {
          const response = await fetch('/data-operate/epub/parse', { method: 'POST', body: buildFormData() });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.message || '解析失败');
          }
          lastParsed = payload;
          if (!document.getElementById('bookName').value.trim()) {
            document.getElementById('bookName').value = (payload.book && payload.book.title) || '';
          }
          renderParsed(payload);
          showMessage('解析成功：共 ' + (payload.chapters || []).length + ' 章，章节图片已内嵌为 base64，封面以 URL 返回');
        } catch (error) {
          showMessage(error.message || '解析失败', 'error');
        }
      };
      document.getElementById('saveBtn').onclick = async () => {
        currentFile = fileInput.files && fileInput.files[0];
        if (!currentFile) {
          showMessage('请先选择 EPUB 文件', 'error');
          return;
        }
        showMessage('正在保存……');
        try {
          const response = await fetch('/data-operate/epub/upload', { method: 'POST', body: buildFormData() });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.message || '保存失败');
          }
          if (payload.parsed) {
            renderParsed({ book: payload.parsed.meta, chapters: payload.parsed.chapters, stats: payload.parsed.stats, fileName: currentFile.name });
          }
          showMessage('已保存书籍：' + (payload.book && payload.book.title));
        } catch (error) {
          showMessage(error.message || '保存失败', 'error');
        }
      };
    </script>
  </body></html>`;
    res.send(html);
  });

  appServer.use('/html', express.static(htmlDir, { index: false }));
  appServer.get('/status', (_, res) => res.json({ running: true, htmlFolder: htmlDir }));
  serverInstance = appServer.listen(serverPort, () => {
    console.log(`HTML server started: http://localhost:${serverPort}/`);
    if (openBrowser) {
      shell.openExternal(`http://localhost:${serverPort}/`);
    }
  });
  serverInstance.on('error', (error) => {
    console.error('HTTP server error', error);
    serverInstance = null;
  });
  return { url: `http://localhost:${serverPort}/`, running: true };
}

app.whenReady().then(async () => {
  ensureDir(appDataDir);
  ensureDir(booksDir);
  ensureDir(coversDir);
  database = await createDatabase(dbPath);
  loadRules(rulesPath).catch(() => saveRules(rulesPath, getDefaultRules()));
  createWindow();
  startStaticServer();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('select-txt-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: '书籍文件（txt/md/epub）', extensions: ['txt', 'md', 'epub'] },
      { name: 'EPUB 电子书', extensions: ['epub'] },
      { name: '文本文件', extensions: ['txt', 'md'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('upload-book', async (_, payload) => {
  const { filePath, title, author, description, coverImg, directoryEntries } = payload;
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('未找到上传文件');
  }
  // EPUB 会先解析出元数据补全留空的字段
  const enriched = enrichBookFromEpub(filePath, {
    title,
    author,
    description,
    coverImg,
    directoryEntries
  }, await loadRules(rulesPath));
  const storedPath = saveBookFile(filePath, booksDir, enriched.title, path.extname(filePath));
  const stats = fs.statSync(storedPath);
  const isEpub = path.extname(storedPath).toLowerCase() === EPUB_EXTENSION;
  const book = {
    title: enriched.title || path.basename(storedPath, path.extname(storedPath)),
    author: enriched.author || '',
    description: enriched.description || '',
    // EPUB 的封面由 /book-cover 提供，不内嵌 base64
    coverImg: isEpub ? '' : (enriched.coverImg || ''),
    sourcePath: filePath,
    storedPath,
    fileName: path.basename(storedPath),
    size: `${Math.round(stats.size / 1024)} KB`,
    fileType: path.extname(storedPath).replace('.', ''),
    directoryEntries: splitDirectoryEntries(enriched.directoryEntries).join('\n'),
    createdAt: new Date().toISOString(),
    epubCoverAvailable: isEpub ? enriched.epubCoverAvailable !== false : undefined
  };
  return insertBookWithCover(book);
});

ipcMain.handle('parse-epub-file', async (_, payload = {}) => {
  const { filePath, inlineImages, inlineStyles, includeText, unwrapImages, blockImages, notesToEnd, notesTitle, maxChapters } = payload;
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('未找到 EPUB 文件');
  }
  const buffer = fs.readFileSync(filePath);
  const parsed = parseEpubBuffer(buffer, {
    inlineImages,
    inlineStyles,
    includeText,
    unwrapImages,
    blockImages,
    notesToEnd,
    notesTitle,
    maxChapters,
    rules: await loadRules(rulesPath)
  });
  return {
    ...parsed,
    fileName: path.basename(filePath),
    size: `${Math.round(buffer.length / 1024)} KB`,
    // 封面以 URL 返回（暂存到封面缓存目录），章节图片仍为 base64
    book: buildEpubSummary(parsed, cacheEpubCover(parsed, { absolute: true }))
  };
});

ipcMain.handle('upload-epub-book', async (_, payload = {}) => {
  const { filePath, title, author, description, coverImg, directoryEntries } = payload;
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('未找到 EPUB 文件');
  }
  const buffer = fs.readFileSync(filePath);
  let parsed = null;
  try {
    // 仅取元数据与章节目录，不需要内嵌图片，避免大文件反复转 base64
    parsed = parseEpubBuffer(buffer, { includeText: false, rules: await loadRules(rulesPath) });
  } catch (error) {
    console.warn(`[epub] 元数据解析失败 ${filePath}：${error.message}`);
  }
  const fallbackTitle = path.basename(filePath, path.extname(filePath));
  const finalTitle = (title || (parsed && parsed.title) || fallbackTitle).trim();
  const storedPath = saveBookBuffer(buffer, booksDir, finalTitle, EPUB_EXTENSION);
  const stats = fs.statSync(storedPath);
  const book = {
    title: finalTitle,
    author: author || (parsed && parsed.author) || '',
    description: description || (parsed && parsed.description) || '',
    // 封面默认由 /book-cover 提供；调用方显式传入地址时优先使用
    coverImg: typeof coverImg === 'string' ? coverImg.trim() : '',
    sourcePath: filePath,
    storedPath,
    fileName: path.basename(storedPath),
    size: `${Math.round(stats.size / 1024)} KB`,
    fileType: 'epub',
    directoryEntries: directoryEntries === undefined || directoryEntries === ''
      ? (parsed ? epubDirectoryEntries(parsed) : '')
      : splitDirectoryEntries(directoryEntries).join('\n'),
    createdAt: new Date().toISOString(),
    epubCoverAvailable: Boolean(parsed && parsed.cover)
  };
  return decorateBookCover(insertBookWithCover(book), { absolute: true });
});

ipcMain.handle('get-books', async () => {
  return database.listBooks().map((book) => decorateBookCover(book, { absolute: true }));
});

ipcMain.handle('update-book', async (_, payload) => {
  const { id, title, author, description, coverImg, directoryEntries } = payload;
  const existing = database.getBookById(id);
  if (!existing) {
    throw new Error('找不到书籍信息');
  }
  return database.updateBook({
    id,
    title: title ?? existing.title,
    author: author ?? existing.author ?? '',
    description: description ?? existing.description ?? '',
    coverImg: coverImg === undefined
      ? (existing.coverImg || '')
      : resolveUpdatedCover(existing, coverImg),
    directoryEntries: directoryEntries === undefined
      ? existing.directoryEntries || ''
      : splitDirectoryEntries(directoryEntries).join('\n')
  });
});

ipcMain.handle('open-book-folder', async (_, bookId) => {
  const book = database.getBookById(bookId);
  if (!book) {
    throw new Error('找不到书籍信息');
  }
  if (!book.storedPath || !fs.existsSync(book.storedPath)) {
    throw new Error('书籍文件不存在');
  }
  const folder = path.dirname(book.storedPath);
  const errorMessage = await shell.openPath(folder);
  if (errorMessage) {
    throw new Error(`打开文件夹失败：${errorMessage}`);
  }
  return folder;
});

ipcMain.handle('parse-book', async (_, { bookId }) => {
  const book = database.getBookById(bookId);
  if (!book) {
    throw new Error('找不到书籍信息');
  }
  const rules = await loadRules(rulesPath);
  const directoryEntries = splitDirectoryEntries(book.directoryEntries);
  const { chapters, epub } = loadBookChapters(book, rules, directoryEntries);
  return { book: decorateBookCover(book, { absolute: true }), chapters, epub };
});

ipcMain.handle('get-rules', async () => {
  return loadRules(rulesPath);
});

ipcMain.handle('save-rules', async (_, rules) => {
  return saveRules(rulesPath, rules);
});

ipcMain.handle('start-server', async () => {
  return startStaticServer();
});

ipcMain.handle('read-html-files', async () => {
  return readHtmlList(htmlDir);
});

ipcMain.handle('open-url', async (_, url) => {
  if (url) {
    shell.openExternal(url);
  }
});
