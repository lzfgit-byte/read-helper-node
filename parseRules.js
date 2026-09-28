const fs = require('fs');

// 章节序号可用的字符：阿拉伯数字、中文数字、大写中文数字
const TITLE_NUMBER_CHARS = '0-9一二三四五六七八九十百千万零两〇壹贰叁肆伍陆柒捌玖拾佰仟廿卅';

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

const titleMarkerRegexCache = new Map();

// 构建“前缀 + 数字/中文数字 + 关键字”的正则（如 第12章、第一百零八章），
// anchored=true 时要求匹配行首，否则在行内任意位置匹配。
function getTitleMarkerRegex(prefix, keywords, anchored) {
  const validKeywords = keywords.filter(Boolean);
  const cacheKey = `${anchored ? '^' : ''}${prefix}|${validKeywords.join(',')}`;
  if (!titleMarkerRegexCache.has(cacheKey)) {
    const keywordPart = validKeywords.map(escapeRegExp).join('|');
    let regex = null;
    if (prefix && keywordPart) {
      try {
        regex = new RegExp(`${anchored ? '^' : ''}${escapeRegExp(prefix)}[${TITLE_NUMBER_CHARS}]+(?:${keywordPart})`);
      } catch {
        regex = null;
      }
    }
    titleMarkerRegexCache.set(cacheKey, regex);
  }
  return titleMarkerRegexCache.get(cacheKey);
}

// 严格数字模式：要求“前缀 + 数字/中文数字 + 关键字”出现在行首
function matchesStrictTitle(line, prefix, keywords) {
  const regex = getTitleMarkerRegex(prefix, keywords, true);
  // 正则构建失败时退回宽松判断
  return regex ? regex.test(line) : true;
}

// 行内是否出现“第X章/回/节”这样的章节标记
function hasTitleMarker(line, prefix, keywords) {
  const regex = getTitleMarkerRegex(prefix, keywords, false);
  return regex ? regex.test(line) : false;
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

// 行尾出现这些符号视为句子/段落结束，需要换行
const LINE_BREAK_ENDINGS = ['。', '！', '？', '；', '：', '”', '"', '…', '」', '』', '】'];

function canAppend(line, idx, lines, rules) {
  const nextLine = lines[idx + 1];
  const nextIsEmpty = typeof nextLine === 'string' && nextLine.trim() === '';
  const endsSentence = LINE_BREAK_ENDINGS.some((mark) => line.endsWith(mark)) ||
    (line.startsWith('…') && line.endsWith('…')) ||
    (line.startsWith('“') && line.endsWith('”')) ||
    (line.startsWith('"') && line.endsWith('"'));
  // 原文里的空行表示该行独立成行（诗句、签文、对白等），必须保留换行，
  // 否则连续的多行会首尾黏连成一段。
  if (endsSentence || nextIsEmpty) {
    return line + '<br/>\n';
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
  // 以章节后缀结尾的行还必须带有“第X章/回/节”标记：
  // “回、节、章”本身也是常用字，否则“唤尽东风总不回”这类句子会被误判为标题。
  const endsMatch = endsWith.some((item) => item && line.endsWith(item)) && hasTitleMarker(line, prefix, endsWith);
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

// 目录项匹配时忽略空白（含全角空格）差异
function normalizeForMatch(value) {
  return String(value == null ? '' : value).replace(/[\s\u3000]+/g, '');
}

const DIRECTORY_MIN_OVERLAP = 4;
const DIRECTORY_MIN_OVERLAP_RATIO = 0.5;

// 正文行与目录项的匹配：允许两侧有空白/截断差异，但子串重叠必须足够长，
// 否则“戒石铭”这类正文词会命中“第十二回 … 言告状却送戒石铭”这样的长回目。
function matchesDirectoryEntry(line, directoryEntries) {
  const normalizedLine = normalizeForMatch(line);
  if (!normalizedLine) {
    return false;
  }
  return directoryEntries.some((entry) => {
    const normalizedEntry = normalizeForMatch(entry);
    if (!normalizedEntry) {
      return false;
    }
    if (normalizedEntry === normalizedLine) {
      return true;
    }
    const [shorter, longer] = normalizedEntry.length <= normalizedLine.length
      ? [normalizedEntry, normalizedLine]
      : [normalizedLine, normalizedEntry];
    if (!longer.includes(shorter)) {
      return false;
    }
    return shorter.length >= Math.max(DIRECTORY_MIN_OVERLAP, Math.ceil(longer.length * DIRECTORY_MIN_OVERLAP_RATIO));
  });
}

// 标题是否带“第X章/回/节”这类章节标记（不依赖 chapterPrefix 是否配置）
function containsChapterMarker(line, rules) {
  const prefix = (rules.chapterPrefix || '').trim() || '第';
  const keywords = Array.isArray(rules.chapterKeywords) ? rules.chapterKeywords : [];
  const regex = getTitleMarkerRegex(prefix, keywords, true);
  return regex ? regex.test(String(line || '')) : false;
}

// 无正文的目录：内容为空，或解析时用标题充当的占位正文
function isTitleOnlyChapter(chapter) {
  const content = String(chapter.content || '').trim();
  if (!content) {
    return true;
  }
  return content === String(chapter.title || '').trim();
}

// 句中标点：出现这些符号的通常是被误判成标题的正文句子，不参与合并
const SENTENCE_PUNCTUATION_PATTERN = /[。！？；，、]/;

// 合并后的标题：优先与已配置的目录项写法一致，其次取仍符合标题规则的写法
function buildMergedTitle(title1, title2, rules, directoryEntries) {
  const candidates = [`${title1} ${title2}`, `${title1}${title2}`]
    .map((candidate) => normalizeTitleText(candidate))
    .filter(Boolean);
  // 任一截都不是标题样子（含句子标点）时直接不合并
  if (candidates.some((candidate) => SENTENCE_PUNCTUATION_PATTERN.test(candidate))) {
    return '';
  }
  const exactEntry = candidates.find((candidate) =>
    directoryEntries.some((entry) => normalizeForMatch(entry) === normalizeForMatch(candidate)));
  if (exactEntry) {
    return exactEntry;
  }
  // 合并后的标题必须仍符合标题规则，否则不合并
  return candidates.find((candidate) => isIsTitle(candidate, rules)) || '';
}

/**
 * 判断两个目录（标题）能否合并成一个，用于标题被拆行/拆文件的场景。
 * 返回合并后的标题；不能合并时返回空字符串。
 */
function mergeChapterTitles(title1, title2, rules, directoryEntries = []) {
  if (!title1 || !title2) {
    return '';
  }
  // 下一个标题本身就是完整的“第X章”标题时，说明它是独立章节，不合并
  if (containsChapterMarker(title2, rules)) {
    return '';
  }
  return buildMergedTitle(title1, title2, rules, directoryEntries);
}

// 标题被拆成多行时（如“第十二章”+“风起云涌”），把无正文的目录与下一个有正文的目录合并，
// 正文跟在这个目录之后；合并后的标题仍需符合标题规则。
function mergeTitleOnlyChapters(chapters, rules, directoryEntries) {
  const merged = [];
  for (const chapter of chapters) {
    let current = chapter;
    while (merged.length > 0) {
      const previous = merged[merged.length - 1];
      // 只处理“上一个目录没有正文 + 当前目录有正文”的情况
      if (!isTitleOnlyChapter(previous) || isTitleOnlyChapter(current)) {
        break;
      }
      const mergedTitle = mergeChapterTitles(previous.title, current.title, rules, directoryEntries);
      if (!mergedTitle) {
        break;
      }
      merged.pop();
      current = { title: mergedTitle, content: current.content };
    }
    merged.push(current);
  }
  return merged;
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

    const isDirectoryEntry = matchesDirectoryEntry(line, normalizedDirectoryEntries);
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
  return mergeTitleOnlyChapters(chapters, rules, normalizedDirectoryEntries);
}

module.exports = { getDefaultRules, loadRules, saveRules, parseTextToChapters, normalizeDirectoryEntries, matchesDirectoryEntry, mergeChapterTitles };
