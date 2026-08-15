const fs = require('fs');

function getDefaultRules() {
  return {
    chapterPrefix: '第',
    chapterSuffixes: ['章', '回', '节'],
    minTitleLength: 2,
    maxTitleLength: 20,
    ignorePatterns: ['^\\s*$'],
    useEmptyLineAsTitle: false,
    titleStarts: ['序章']
  };
}

async function loadRules(rulesPath) {
  try {
    const content = fs.readFileSync(rulesPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    const defaultRules = getDefaultRules();
    fs.writeFileSync(rulesPath, JSON.stringify(defaultRules, null, 2), 'utf8');
    return defaultRules;
  }
}

function saveRules(rulesPath, rules) {
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf8');
  return rules;
}

function isSeqContent(line) {
  return line.startsWith('-') && line.endsWith('-') && line.length < 5;
}

function canAppend(line, idx, lines, rules) {
  const afterEmpty = rules.useEmptyLineAsTitle && idx > 0 && idx < lines.length - 2 && lines[idx + 1].trim() === '' && lines[idx + 2].trim() === '';
  const a = line.endsWith('。') ||
    (line.startsWith('“') && line.endsWith('”')) ||
    (line.startsWith('"') && line.endsWith('"')) ||
    (line.startsWith('…') && line.endsWith('…')) ||
    line.endsWith('。”') ||
    afterEmpty;
  if (a) {
    return line + '<br/>\n';
  }
  if (idx > 1) {
    const prev = lines[idx - 1];
    const next = lines[idx + 1];
    if (line.length < 20 && prev?.trim() === '' && next?.trim() === '') {
      return line + '  ';
    }
  }
  return line;
}

function isIsTitle(line, rules) {
  const prefix = (rules.chapterPrefix || '').trim();
  const startsWith = prefix ? [prefix] : [];
  const extraStarts = Array.isArray(rules.titleStarts) ? rules.titleStarts : [];
  const starts = startsWith.concat(extraStarts);
  const endsWith = Array.isArray(rules.chapterSuffixes) ? rules.chapterSuffixes : [];
  const containsStr = endsWith.concat(['创作手记', '后记', '楔子']);
  const startsMatch = starts.some((item) => item && line.startsWith(item));
  const endsMatch = endsWith.some((item) => item && line.endsWith(item));
  const containsMatch = containsStr.some((item) => item && line.includes(item));
  const shortSeq = (line.includes('卷') && line.indexOf('卷') < 5) || (line.includes('序') && line.length < 15);
  // If the line starts with a configured start (like '序章'), accept it as a title even
  // if it doesn't strictly end with a chapter suffix. Otherwise require contains/short checks.
  const isTitleContent = (line === '序' || startsMatch || endsMatch) && (startsMatch || containsMatch || shortSeq);
  const validLength = line.length >= (rules.minTitleLength || 1) && line.length < rules.maxTitleLength;
  // Accept literal '序章...' lines as titles even if `rules.titleStarts` isn't provided
  if (!isTitleContent && line.startsWith('序章')) {
    return validLength || line === '序';
  }
  return isTitleContent && (validLength || line === '序');
}

function preEmpty(idx, lines) {
  if (idx > 1) {
    return lines[idx - 1].trim() === '' && lines[idx - 2].trim() === '';
  }
  return false;
}

function afterEmpty(idx, lines) {
  if (idx < lines.length - 2) {
    return lines[idx + 1].trim() === '' && lines[idx + 2].trim() === '';
  }
  return false;
}

function isMaybeTitle(line, idx, lines, rules) {
  if (idx > 0) {
    const prevLine = lines[idx - 1];
    const newLine = canAppend(line, idx, lines, rules);
    if (isIsTitle(prevLine, { maxTitleLength: 20 }) && (prevLine.endsWith('章') || newLine.endsWith('回') || newLine.endsWith('节')) && !newLine.endsWith('\n')) {
      return true;
    }
  }
  const chineseMarks = ['【', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
  return preEmpty(idx, lines) && afterEmpty(idx, lines) && line.length < 30 && chineseMarks.every((mark) => !line.startsWith(mark));
}

function wrapperNewLine(line, idx, lines, rules) {
  if (isMaybeTitle(line, idx, lines, rules)) {
    return line + '<br/>\n';
  }
  return canAppend(line, idx, lines, rules);
}

function buildChapterTitle(title, content, chapters) {
  let finalTitle = title;
  if (!finalTitle) {
    const split = content.split('<br/>\n');
    if (split.length > 0 && split[0].length < 30) {
      finalTitle = split[0];
    } else {
      finalTitle = `第${chapters.length + 1}章[自动]`;
    }
  }
  return finalTitle;
}

function flushChapter(chapters, title, content) {
  if (!content) {
    return;
  }
  const trimmedContent = content.trim();
  if (!trimmedContent) {
    return;
  }
  const realTitle = buildChapterTitle(title, trimmedContent, chapters);
  chapters.push({
    title: realTitle,
    content: trimmedContent
  });
}

function normalizeDirectoryEntries(directoryEntries) {
  const entries = Array.isArray(directoryEntries)
    ? directoryEntries
    : String(directoryEntries ?? '').split(/\r?\n/);
  return entries.map((entry) => String(entry).trim()).filter(Boolean);
}

function parseTextToChapters(text, rules, directoryEntries = []) {
  const lines = (text == null ? '' : String(text)).split(/\r?\n/);
  const chapters = [];
  let title = '';
  let content = '';
  const enableEmptyLineTitle = !!rules.useEmptyLineAsTitle;
  const normalizedDirectoryEntries = normalizeDirectoryEntries(directoryEntries);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line || isSeqContent(line)) {
      continue;
    }

    const isDirectoryEntry = normalizedDirectoryEntries.some(item => item.includes(line));
    const isTitle = isDirectoryEntry || isIsTitle(line, rules);
    const isEmptyLineTitle = enableEmptyLineTitle && isMaybeTitle(line, i, lines, rules);
    if (isTitle || isEmptyLineTitle) {
      if (content) {
        flushChapter(chapters, title, content);
      } else if (title) {
        flushChapter(chapters, title, title);
      }
      title = line;
      content = '';
      continue;
    }
    content += wrapperNewLine(line, i, lines, rules);
  }

  if (content || title) {
    flushChapter(chapters, title, content);
  }
  return chapters;
}

module.exports = { getDefaultRules, loadRules, saveRules, parseTextToChapters, normalizeDirectoryEntries };
