// 临时：找 legado 阅读页图片链路里跟尺寸/大小有关的上限与截断
const fs = require('fs');
const path = require('path');

const root = 'd:\\projects\\legado';
const skipDirs = new Set(['node_modules', '.git', 'build', '.gradle']);
const filePatterns = /ReaderImageResolver\.kt$|ImageBytesCache\.kt$|ImageBitmapLoader\.kt$|ReaderImageCache|SimpleChapterLayout\.kt$|PageContentCanvas\.kt$|BookContent\.kt$/;
const linePatterns = /SAMPLE_MAX_DIM|maxBytes|maxSize|maxWidth|maxHeight|MAX_|LIMIT|limit|coerceAtMost|inSampleSize|subsampl|length >|size >|> 1024|imageCount/;

const files = [];
const walk = (dir, depth) => {
  if (depth > 14 || files.length > 40) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(full, depth + 1);
      continue;
    }
    if (filePatterns.test(entry.name)) files.push(full);
  }
};
walk(root, 0);
files.forEach((file) => {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const hits = [];
  lines.forEach((line, index) => {
    if (linePatterns.test(line)) hits.push(`${index + 1}: ${line.trim().slice(0, 170)}`);
  });
  if (hits.length) {
    console.log(`\n=== ${path.relative(root, file).replace(/\\/g, '/')} (${hits.length}) ===`);
    hits.slice(0, 40).forEach((hit) => console.log(`  ${hit}`));
  }
});
