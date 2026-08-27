const fs = require('fs');

const TITLE_NUMBER_CHARS = '0-9一二三四五六七八九十百千万零两〇';

function getDefaultRules() {
  return {
    chapterPrefix: '第',
    chapterSuffixes: ['章', '回', '节'],
    chapterKeywords: ['章', '回', '节'],
    titleStarts: ['序章', '楔子', '后记', '番外'],
    titleContains: ['创作手记', '后记', '楔子'],
    minTitleLength: 2,
    maxTitleLength: 20,
    ignorePatterns: ['^\\s*$'],
    strictNumberMode: true,
    useEmptyLineAsTitle: false
  };
}

async function loadRules(rulesPath) {
  const defaultRules = getDefaultRules();
  try {
    const content = fs.readFileSync(rulesPath, 'utf8');
    // Merge with defaults and normalize so older/hand-edited files stay valid.
    return normalizeRules(Object.assign(defaultRules, JSON.parse(content)));
  } catch (error) {
    fs.writeFileSync(rulesPath, JSON.stringify(defaultRules, null, 2), 'utf8');
    return defaultRules;
  }
}

function saveRules(rulesPath, rules) {
  const normalized = normalizeRules(rules);
  fs.writeFileSync(rulesPath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const strictTitleRegexCache = new Map();

// 严格数字模式：要求“前缀 + 数字/中文数字 + 关键字”，如 第12章、第一百零八章
function matchesStrictTitle(line, prefix, keywords) {
  const validKeywords = keywords.filter(Boolean);
  const cacheKey = `${prefix}|${validKeywords.join(',')}`;
  if (!strictTitleRegexCache.has(cacheKey)) {
    const keywordPart = validKeywords.map(escapeRegExp).join('|');
    let regex = null;
    if (prefix && keywordPart) {
      try {
        regex = new RegExp(`^${escapeRegExp(prefix)}[${TITLE_NUMBER_CHARS}]+(?:${keywordPart})`);
      } catch {
        regex = null;
      }
    }
    strictTitleRegexCache.set(cacheKey, regex);
  }
  const regex = strictTitleRegexCache.get(cacheKey);
  // 正则构建失败时退回宽松判断
  return regex ? regex.test(line) : true;
}

// 标题归一化：连续空白（含全角空格）折叠为单个空格，成对书名号去掉
function normalizeTitleText(title) {
  let text = String(title || '').replace(/\s+/g, ' ').trim();
  if (text.startsWith('《') && text.endsWith('》') && text.length > 2) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function compileIgnorePatterns(patterns) {
  return (Array.isArray(patterns) ? patterns : [])
    .map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// 校验并归一化规则，避免非法配置导致解析异常
function normalizeRules(rules) {
  const defaults = getDefaultRules();
  const source = rules && typeof rules === 'object' && !Array.isArray(rules) ? rules : {};
  const toWordList = (value, fallback) => {
    let list = null;
    if (Array.isArray(value)) {
      list = value;
    } else if (typeof value === 'string' && value.trim()) {
      list = value.split(/[,，\n]/);
    }
    if (!list) {
      return fallback.slice();
    }
    const cleaned = list.map((item) => String(item).trim()).filter(Boolean);
    return cleaned.length > 0 ? cleaned : fallback.slice();
  };
  const toPositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const normalized = {
    chapterPrefix: typeof source.chapterPrefix === 'string' && source.chapterPrefix.trim()
      ? source.chapterPrefix.trim()
      : defaults.chapterPrefix,
    chapterSuffixes: toWordList(source.chapterSuffixes, defaults.chapterSuffixes),
    chapterKeywords: toWordList(source.chapterKeywords, defaults.chapterKeywords),
    titleStarts: toWordList(source.titleStarts, defaults.titleStarts),
    titleContains: toWordList(source.titleContains, defaults.titleContains),
    minTitleLength: toPositiveInt(source.minTitleLength, defaults.minTitleLength),
    maxTitleLength: toPositiveInt(source.maxTitleLength, defaults.maxTitleLength),
    ignorePatterns: (Array.isArray(source.ignorePatterns) ? source.ignorePatterns : defaults.ignorePatterns)
      .map((pattern) => String(pattern).trim())
      .filter(Boolean)
      .filter((pattern) => {
        try {
          new RegExp(pattern);
          return true;
        } catch {
          return false;
        }
      }),
    strictNumberMode: source.strictNumberMode === undefined ? defaults.strictNumberMode : !!source.strictNumberMode,
    useEmptyLineAsTitle: !!source.useEmptyLineAsTitle
  };
  if (normalized.minTitleLength >= normalized.maxTitleLength) {
    normalized.minTitleLength = defaults.minTitleLength;
    normalized.maxTitleLength = defaults.maxTitleLength;
  }
  return normalized;
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
  const extraStarts = Array.isArray(rules.titleStarts) ? rules.titleStarts : [];
  const keywords = Array.isArray(rules.chapterKeywords) ? rules.chapterKeywords : ['章', '回', '节'];
  const endsWith = Array.isArray(rules.chapterSuffixes) ? rules.chapterSuffixes : [];
  const containsWords = Array.isArray(rules.titleContains) ? rules.titleContains : ['创作手记', '后记', '楔子'];
  const containsStr = endsWith.concat(containsWords);
  // A line starting with the chapter prefix (e.g. '第') only counts as a title
  // when it also contains one of the configured keywords (e.g. '章', '回', '节').
  // 严格数字模式下，还要求“第”后紧跟数字/中文数字再接关键字，
  // 避免“第二天章鱼出现了”这类正文中含关键字的行被误判为标题。
  let prefixMatch = prefix ? line.startsWith(prefix) : false;
  if (prefixMatch && rules.strictNumberMode !== false) {
    prefixMatch = matchesStrictTitle(line, prefix, keywords);
  }
  const keywordMatch = keywords.some((item) => item && line.includes(item));
  const startsMatch = (prefixMatch && keywordMatch) || extraStarts.some((item) => item && line.startsWith(item));
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
    const suffixes = Array.isArray(rules && rules.chapterSuffixes) ? rules.chapterSuffixes : ['章', '回', '节'];
    const endsWithSuffix = suffixes.some((item) => item && (prevLine.endsWith(item) || newLine.endsWith(item)));
    if (isIsTitle(prevLine, { maxTitleLength: 20 }) && endsWithSuffix && !newLine.endsWith('\n')) {
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
  return normalizeTitleText(finalTitle);
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

function parseTextToChapters(text, rules = {}, directoryEntries = []) {
  const lines = (text == null ? '' : String(text)).split(/\r?\n/);
  const chapters = [];
  let title = '';
  let content = '';
  const enableEmptyLineTitle = !!rules.useEmptyLineAsTitle;
  const normalizedDirectoryEntries = normalizeDirectoryEntries(directoryEntries);
  const ignoreRegexes = compileIgnorePatterns(rules.ignorePatterns);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line || isSeqContent(line)) {
      continue;
    }
    // 命中忽略规则（广告、水印等）的行直接跳过
    if (ignoreRegexes.some((regex) => regex.test(line))) {
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
      title = normalizeTitleText(line);
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
