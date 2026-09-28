// 临时：HtmlFormatter.formatKeepImg 的实现与调用点（网络书正文化处理）
const fs = require('fs');
const path = require('path');

const root = 'd:\\projects\\legado';
const skipDirs = new Set(['node_modules', '.git', 'build', '.gradle']);
const hits = [];
const walk = (dir, depth) => {
  if (depth > 14 || hits.length > 120) return;
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
    if (!/\.kt$/.test(entry.name)) continue;
    let text = '';
    try {
      if (fs.statSync(full).size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (/formatKeepImg|HtmlFormatter/.test(text)) {
      text.split(/\r?\n/).forEach((line, index) => {
        if (/formatKeepImg|object HtmlFormatter|fun format/.test(line)) {
          hits.push(`${path.relative(root, full).replace(/\\/g, '/')}:${index + 1}: ${line.trim().slice(0, 160)}`);
        }
      });
    }
  }
};
walk(root, 0);
hits.forEach((hit) => console.log(hit));

// 打印 HtmlFormatter 实现
const candidates = [];
const walk2 = (dir, depth) => {
  if (depth > 14) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk2(full, depth + 1);
      continue;
    }
    if (entry.name === 'HtmlFormatter.kt') candidates.push(full);
  }
};
walk2(root, 0);
candidates.forEach((file) => {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  console.log(`\n=== ${file} ===`);
  lines.forEach((line, index) => console.log(`${String(index + 1).padStart(4)}: ${line}`));
});
