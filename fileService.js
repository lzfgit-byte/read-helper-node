const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

// extension 用于 multer 临时文件（无扩展名）时显式指定保存后缀
function saveBookFile(sourcePath, booksDir, title, extension) {
  ensureDir(booksDir);
  const suffix = extension || path.extname(sourcePath) || '.txt';
  const destName = `${title || path.basename(sourcePath, suffix)}${suffix}`;
  const destPath = path.join(booksDir, destName);
  fs.copyFileSync(sourcePath, destPath);
  return destPath;
}

// 去掉文件名中的非法字符，避免书名里的 / : * 等导致写入失败
function sanitizeFileName(name, fallback = 'book') {
  const cleaned = String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[.\s]+$/, '')
    .trim();
  return cleaned || fallback;
}

// 直接写入内存中的文件内容（上传的 EPUB 等以 Buffer 形式拿到）
function saveBookBuffer(buffer, booksDir, title, extension = '.epub') {
  ensureDir(booksDir);
  const suffix = String(extension || '.bin').startsWith('.') ? extension : `.${extension}`;
  const destPath = path.join(booksDir, `${sanitizeFileName(title, 'book')}${suffix}`);
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

function readHtmlList(htmlDir) {
  ensureDir(htmlDir);
  const files = fs.readdirSync(htmlDir).filter((name) => name.endsWith('.html'));
  return files.map((file) => ({
    name: file,
    url: `http://localhost:3000/html/${encodeURIComponent(file)}`
  }));
}

module.exports = { ensureDir, saveBookFile, saveBookBuffer, sanitizeFileName, readHtmlList };
