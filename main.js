const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { createDatabase } = require('./db');
const { parseTextToChapters, normalizeDirectoryEntries, loadRules, saveRules, getDefaultRules } = require('./parseRules');
const { ensureDir, saveBookFile, readHtmlList } = require('./fileService');

const appDataDir = path.join(app.getPath('userData'), 'reader-helper');
const booksDir = path.join(appDataDir, 'books');
const javaHtmlDir = path.join('d:', 'projects', 'reader-help', 'src', 'main', 'resources', 'templates');
const htmlDir = fs.existsSync(javaHtmlDir) ? javaHtmlDir : path.join(__dirname, 'public', 'html');
const dbPath = path.join(appDataDir, 'reader-helper.db');
const rulesPath = path.join(appDataDir, 'parse-rules.json');
let serverInstance = null;
let serverPort = 3000;
let mainWindow;
let database;

function splitDirectoryEntries(directoryEntries) {
  return normalizeDirectoryEntries(directoryEntries);
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

// Returns the book with `coverImg` replaced by the proxied URL and keeps the
// original address in `coverImgSource` so edit forms don't save the proxy back.
function decorateBookCover(book, options) {
  if (!book) {
    return book;
  }
  return {
    ...book,
    coverImg: buildCoverProxyUrl(book.coverImg, options),
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
  const appServer = express();
  appServer.use(express.json());
  appServer.use(express.urlencoded({ extended: true }));

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

  appServer.post('/data-operate/submitForm', upload.single('file'), async (req, res) => {
    const file = req.file;
    const { bookName, desc, authorName, coverImg, directoryEntries } = req.body;
    if (!file || !bookName) {
      return res.status(400).json({ message: '文件或书名不能为空' });
    }
    const storedPath = saveBookFile(file.path, booksDir, bookName);
    fs.unlinkSync(file.path);
    const stats = fs.statSync(storedPath);
    const book = {
      title: bookName,
      author: authorName || '',
      description: desc || '',
      coverImg: coverImg || '',
      sourcePath: file.originalname,
      storedPath,
      fileName: path.basename(storedPath),
      size: `${Math.round(stats.size / 1024)} KB`,
      fileType: path.extname(storedPath).replace('.', ''),
      directoryEntries: splitDirectoryEntries(directoryEntries).join('\n'),
      createdAt: new Date().toISOString()
    };
    database.insertBook(book);
    return res.json({ message: '提交成功', book });
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
      coverImg: coverImg ?? existing.coverImg ?? '',
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
        <button class="btn btn-primary" onclick="showModal()">新增书籍</button>
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
            <div class="field"><label>文件</label><input type="file" name="file" required /></div>
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
    const chapters = parseTextToChapters(
      fs.readFileSync(book.storedPath, 'utf8'),
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
    const chapters = parseTextToChapters(
      fs.readFileSync(book.storedPath, 'utf8'),
      await loadRules(rulesPath),
      splitDirectoryEntries(book.directoryEntries)
    );
    let chapterContent = '';
    chapters.forEach((chapter, index) => {
      const chunkId = crypto.createHash('md5').update(book.id + '-' + index).digest('hex');
      if (chunkId === id) {
        chapterContent = chapter.content.replace(/\n/g, '<br/>');
      }
    });
    if (!chapterContent) {
      return res.status(404).send('章节未找到');
    }
    res.send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>正文</title></head><body><div id="content">${chapterContent}</div></body></html>`);
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
  const storedPath = saveBookFile(filePath, booksDir, title);
  const stats = fs.statSync(storedPath);
  const book = {
    title: title || path.basename(storedPath, path.extname(storedPath)),
    author: author || '',
    description: description || '',
    coverImg: coverImg || '',
    sourcePath: filePath,
    storedPath,
    fileName: path.basename(storedPath),
    size: `${Math.round(stats.size / 1024)} KB`,
    fileType: path.extname(storedPath).replace('.', ''),
    directoryEntries: splitDirectoryEntries(directoryEntries).join('\n'),
    createdAt: new Date().toISOString()
  };
  return database.insertBook(book);
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
    coverImg: coverImg ?? existing.coverImg ?? '',
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
  const fileContent = fs.readFileSync(book.storedPath, 'utf8');
  const rules = await loadRules(rulesPath);
  const directoryEntries = splitDirectoryEntries(book.directoryEntries);
  const chapters = parseTextToChapters(fileContent, rules, directoryEntries);
  return { book: decorateBookCover(book, { absolute: true }), chapters };
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
