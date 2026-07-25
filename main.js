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
      <tr>
        <td><a href="/detail?id=${book.id}">${book.title}</a></td>
        <td>${book.size}</td>
        <td>${book.coverImg}</td>
        <td>
          <a href="#" onclick="deleteBook(${book.id});return false;">删除</a>
          &nbsp;|&nbsp;
          <a href="#" onclick="openFolder(${book.id});return false;">打开文件夹</a>
        </td>
      </tr>
    `).join('');
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>列表</title><script>
      function deleteBook(id){
        if(confirm('删除？')){
          fetch('/data-operate/delete?id='+encodeURIComponent(id)).then((response)=>{
            if(response.ok){
              location.reload();
            } else {
              response.text().then(text => alert('删除失败: '+text));
            }
          });
        }
      }
      function openFolder(id){
        fetch('/open-folder?id='+encodeURIComponent(id)).then((response)=>{
          if(response.ok){
            alert('已打开书籍所在文件夹');
          } else {
            response.text().then(text=>alert('打开失败: '+text));
          }
        }).catch((err)=>alert('打开失败: '+err.message));
      }
    </script></head><body><button onclick="document.getElementById('upload-form').style.display='block'">新增</button><div id="upload-form" style="display:none"><form id="uploadForm" method="post" action="/data-operate/submitForm" enctype="multipart/form-data"><div><label>文件:</label><input type="file" name="file"/></div><div><label>书名:</label><input name="bookName"/></div><div><label>作者:</label><input name="authorName"/></div><div><label>描述:</label><textarea name="desc"></textarea></div><div><label>封面:</label><input name="coverImg"/></div><button type="submit">提交</button></form></div><table border="1" cellpadding="8"><thead><tr><th>书名</th><th>大小</th><th>封面</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
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
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>目录页面</title></head><body><h1>${book.title} 目录</h1><ul>${items}</ul></body></html>`;
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
