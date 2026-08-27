const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTextToChapters, getDefaultRules } = require('../parseRules');

test('uses configured directory entries as chapter titles', () => {
  const text = ['第一章', '正文内容一', '第二章', '正文内容二'].join('\n');
  const rules = getDefaultRules();
  const directoryEntries = ['第一章', '第二章'];

  const chapters = parseTextToChapters(text, rules, directoryEntries);

  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, '第一章');
  assert.equal(chapters[1].title, '第二章');
  assert.equal(chapters[0].content, '正文内容一');
  assert.equal(chapters[1].content, '正文内容二');
});

test('recognizes "序章 大荒" as chapter title', () => {
  const text = ['序章 大荒', '夜已深，漆黑一片，景物不可见。'].join('\n');
  const rules = getDefaultRules();
  const directoryEntries = [];

  const chapters = parseTextToChapters(text, rules, directoryEntries);

  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, '序章 大荒');
  assert.ok(chapters[0].content.includes('夜已深'));
});

test('lines starting with prefix but missing keywords are not titles', () => {
  const text = ['第一章 出发', '第二天，天刚蒙蒙亮。', '他起床出了门。', '第二章 抵达', '旅途开始了。'].join('\n');
  const rules = getDefaultRules();
  const directoryEntries = [];

  const chapters = parseTextToChapters(text, rules, directoryEntries);

  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, '第一章 出发');
  assert.ok(chapters[0].content.includes('第二天'));
  assert.equal(chapters[1].title, '第二章 抵达');
  assert.ok(chapters[1].content.includes('旅途'));
});

test('prefix titles require one of the configured chapter keywords', () => {
  const text = ['第一卷 风起', '正文内容。', '第二卷 云涌', '更多正文。'].join('\n');
  const rules = getDefaultRules();
  const directoryEntries = [];

  const withoutKeyword = parseTextToChapters(text, rules, directoryEntries);
  assert.equal(withoutKeyword.length, 1);

  rules.chapterKeywords = ['卷'];
  const withKeyword = parseTextToChapters(text, rules, directoryEntries);
  assert.equal(withKeyword.length, 2);
  assert.equal(withKeyword[0].title, '第一卷 风起');
  assert.equal(withKeyword[1].title, '第二卷 云涌');
});
