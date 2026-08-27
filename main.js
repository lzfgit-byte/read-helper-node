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
      body{margin:0;font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;background:#f4f7fb;color:#0f172a;}
      .container{max-width:1120px;margin:32px auto;padding:0 20px;}
      .header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:24px;}
      .header-title{margin:0;line-height:1.1;}
      .header-title h1{font-size:32px;margin:0;color:#0f172a;}
      .header-title p{margin:8px 0 0;color:#475569;font-size:15px;}
      .btn{display:inline-flex;align-items:center;justify-content:center;padding:12px 20px;border-radius:14px;border:none;font-weight:600;cursor:pointer;transition:all .2s ease;}
      .btn-primary{background:#2563eb;color:#fff;box-shadow:0 18px 40px rgba(37,99,235,.18);}
      .btn-primary:hover{transform:translateY(-1px);}
      .book-list{list-style:none;margin:0;padding:0;display:grid;gap:16px;}
      .book-item{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:20px 24px;border-radius:24px;background:#fff;box-shadow:0 18px 40px rgba(15,23,42,.08);}
      .book-meta{min-width:0;}
      .book-meta h3{margin:0 0 8px;font-size:20px;color:#0f172a;}
      .book-meta h3 a{color:inherit;text-decoration:none;}
      .book-meta p{margin:0;color:#475569;font-size:14px;line-height:1.6;}
      .book-meta img.cover-img{display:block;margin-top:10px;max-width:140px;border-radius:14px;object-fit:cover;box-shadow:0 16px 40px rgba(15,23,42,.08);}
      .book-actions{display:flex;gap:16px;flex-wrap:wrap;}
      .action-link{color:#2563eb;text-decoration:none;font-weight:600;}
      .action-link:hover{text-decoration:underline;}
      .message{display:none;padding:14px 18px;border-radius:16px;margin-bottom:20px;box-shadow:0 16px 30px rgba(15,23,42,.08);}
      .message.info{background:#eff6ff;color:#0369a1;}
      .message.error{background:#fee2e2;color:#991b1b;}
      .modal{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;z-index:1000;}
      .modal.active{display:flex;}
      .modal-panel{width:100%;max-width:640px;background:#fff;border-radius:28px;overflow:hidden;box-shadow:0 40px 100px rgba(15,23,42,.18);}
      .modal-header{display:flex;justify-content:space-between;align-items:center;padding:24px 28px;border-bottom:1px solid #e2e8f0;}
      .modal-header h2{margin:0;font-size:22px;color:#0f172a;}
      .close-btn{border:none;background:transparent;color:#64748b;font-size:26px;cursor:pointer;line-height:1;}
      .modal-body{padding:24px 28px;}
      .field{margin-bottom:18px;}
      .field label{display:block;margin-bottom:8px;font-size:14px;color:#475569;}
      .field input[type=text],.field textarea,.field input[type=file]{width:100%;padding:14px 16px;border:1px solid #cbd5e1;border-radius:16px;background:#f8fafc;color:#0f172a;font-size:15px;}
      .field textarea{min-height:120px;resize:vertical;}
      .modal-footer{padding:20px 28px 28px;text-align:right;background:#f8fafc;}
      .modal-footer .btn-secondary{margin-right:12px;background:#f8fafc;color:#334155;}
      .hint{font-size:13px;color:#64748b;margin-top:6px;}
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
