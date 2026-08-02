const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTextToChapters } = require('../parseRules');

test('uses configured directory entries as chapter titles', () => {
  const text = ['第一章', '正文内容一', '第二章', '正文内容二'].join('\n');
  const rules = {};
  const directoryEntries = ['第一章', '第二章'];

  const chapters = parseTextToChapters(text, rules, directoryEntries);

  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, '第一章');
  assert.equal(chapters[1].title, '第二章');
  assert.equal(chapters[0].content, '正文内容一');
  assert.equal(chapters[1].content, '正文内容二');
});
