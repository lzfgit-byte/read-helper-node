const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { createDatabase } = require('./db');
const { parseTextToChapters, loadRules, saveRules, getDefaultRules } = require('./parseRules');
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
const apiLogs = [];

function addApiLog(entry) {
  if (apiLogs.length >= 200) {
    apiLogs.shift();
  }
  apiLogs.push(entry);
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

function startStaticServer() {
  if (serverInstance) {
    return { url: `http://localhost:${serverPort}/html`, running: true };
  }
  ensureDir(htmlDir);
  const appServer = express();
  appServer.use(express.json());
  appServer.use(express.urlencoded({ extended: true }));

  appServer.use((req, res, next) => {
    const startTime = Date.now();
    const requestBody = req.method === 'GET' ? req.query : req.body;
    const formatBody = (body) => {
      if (body === undefined || body === null) {
        return '';
      }
      if (typeof body === 'string') {
        return body.length > 500 ? `${body.slice(0, 500)}...` : body;
      }
      try {
        const text = JSON.stringify(body);
        return text.length > 500 ? `${text.slice(0, 500)}...` : text;
      } catch {
        return String(body);
      }
    };
    const originalSend = res.send.bind(res);
    res.send = function (body) {
      const duration = Date.now() - startTime;
      const responsePayload = formatBody(body);
      const statusCode = res.statusCode || 200;
      console.log(`[API] ${req.method} ${req.originalUrl} ${statusCode} ${duration}ms response=${responsePayload}`);
      addApiLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        timestamp: new Date().toISOString(),
        method: req.method,
        url: req.originalUrl,
        statusCode,
        duration,
        requestBody: formatBody(requestBody),
        responseBody: responsePayload
      });
      return originalSend(body);
    };
    const requestPayload = formatBody(requestBody);
    console.log(`[API] request ${req.method} ${req.originalUrl} body=${requestPayload}`);
    next();
  });

  const upload = multer({ dest: path.join(appDataDir, 'temp') });

  appServer.post('/data-operate/submitForm', upload.single('file'), async (req, res) => {
    const file = req.file;
    const { bookName, desc, authorName, coverImg } = req.body;
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
    const books = database.listBooks();
    const rows = books.map((book) => `
      <li class="book-item">
        <div class="book-meta">
          <h3><a href="/detail?id=${book.id}">${book.title}</a></h3>
          <p>大小：${book.size}</p>
          ${book.coverImg ? `<img class="cover-img" src="${book.coverImg}" alt="封面" />` : '<p>封面：—</p>'}
        </div>
        <div class="book-actions">
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
      .book-actions{display:flex;gap:16px;}
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
            <div class="hint">提交后书籍会保存至本地目录，删除操作会从数据库中移除记录。</div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="hideModal()">取消</button>
            <button type="submit" class="btn btn-primary">提交</button>
          </div>
        </form>
      </div>
    </div>
    <script>
      function showModal(){document.getElementById('bookModal').classList.add('active');}
      function hideModal(){document.getElementById('bookModal').classList.remove('active');}
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
    const book = database.getBookById(Number(bookId));
    if (!book) {
      return res.status(404).send('书籍未找到');
    }
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
    const chapters = parseTextToChapters(fs.readFileSync(book.storedPath, 'utf8'), await loadRules(rulesPath));
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
    const chapters = parseTextToChapters(fs.readFileSync(book.storedPath, 'utf8'), await loadRules(rulesPath));
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
    shell.openExternal(`http://localhost:${serverPort}/`);
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
  const { filePath, title, author, description, coverImg } = payload;
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
    createdAt: new Date().toISOString()
  };
  return database.insertBook(book);
});

ipcMain.handle('get-books', async () => {
  return database.listBooks();
});

ipcMain.handle('parse-book', async (_, { bookId }) => {
  const book = database.getBookById(bookId);
  if (!book) {
    throw new Error('找不到书籍信息');
  }
  const fileContent = fs.readFileSync(book.storedPath, 'utf8');
  const rules = await loadRules(rulesPath);
  const chapters = parseTextToChapters(fileContent, rules);
  return { book, chapters };
});

ipcMain.handle('get-rules', async () => {
  return loadRules(rulesPath);
});

ipcMain.handle('save-rules', async (_, rules) => {
  return saveRules(rulesPath, rules);
});

ipcMain.handle('get-api-logs', async () => {
  return apiLogs.slice().reverse();
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
