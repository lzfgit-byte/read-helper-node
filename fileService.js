const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function saveBookFile(sourcePath, booksDir, title) {
  ensureDir(booksDir);
  const suffix = path.extname(sourcePath) || '.txt';
  const destName = `${title || path.basename(sourcePath, suffix)}${suffix}`;
  const destPath = path.join(booksDir, destName);
  fs.copyFileSync(sourcePath, destPath);
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

module.exports = { ensureDir, saveBookFile, readHtmlList };
