# Reader Helper Electron

Electron 应用，支持：

- 上传 TXT 文件
- 按章节解析 TXT 内容
- 标题被拆成多行时自动合并（如「第十二章」+「风起云涌」→「第十二章 风起云涌」，正文跟在合并后的目录后）
- 上传 EPUB 文件并解析章节（图片以 base64 内嵌返回，注释统一移到章节末尾）
- 书籍列表支持解析、编辑、删除（删除会同时删除本地文件）与打开文件夹
- 配置章节解析规则
- SQLite 存储书籍信息
- 启动 HTTP 服务返回已有 HTML 文件

## 运行

1. 在 `d:\projects\read-helper-node` 目录下运行
   ```bash
   npm install
   npm start
   ```

2. 启动后，使用界面上传 TXT/EPUB 书籍、保存解析规则、启动 HTML 服务。

## TXT 章节解析

按「章节规则 + 目录项」识别标题；标题被拆成多行（源文件里目录与标题名分行）时会自动合并：

- 条件：**当前目录没有正文**（正文为空，或解析时用标题充当了占位正文）、**下一个目录有正文**、
  且**两个标题合起来仍符合章节规则**（或与已配置的目录项完全一致）
- 结果：合并为一个目录，标题形如 `第一章 风起云涌`（也支持无空格写法，取决于哪个仍符合规则），正文跟在合并后的目录之后
- 不合并的情况：下一标题本身就是完整的「第X章」标题（如「序章」+「第一章 出发」）、合并后超出标题长度限制、
  或标题里带句子标点（`。！？；，、`，通常是被误判成标题的正文）

## EPUB 解析

「EPUB 上传解析」页（Electron 界面）或浏览器页面 `http://localhost:3000/epub` 支持：

- 选择 `.epub` 文件后上传，自动读取书名、作者、简介与封面
- 按 `spine` 顺序输出章节，章节标题优先取 `<h1>~<h6>`，其次取 NCX/Nav 目录标题
- **标题被拆到不同 xhtml 时自动合并**：某章没有正文（空内容或只有标题）、下一章有正文，且两个标题合起来仍符合章节规则时，合并为一个目录（如「第十二章」+「风起云涌」→「第十二章 风起云涌」，正文跟在合并后的目录后）。判断逻辑与 TXT 章节解析完全共用（`parseRules.js` 的 `mergeChapterTitles`），服务端会把当前章节规则传进来；插图页（只含 `<img>`）和下一章本身是完整「第X章」标题的情况不合并，合并后的章节会带 `sourceHrefs` 便于排查
- 章节内的图片（`<img>`、SVG `<image>`、CSS `url(...)`）转换为 `data:<mime>;base64,...` 内嵌在返回的 HTML 中，前端无需再请求图片接口
- **正文图片直接内联展示**：多看书系等 EPUB 会把插图/注号图包成 `<sup><a href="..."><img/></a></sup>`，解析时会把这类「只包图片」的 `sup`/`sub`/`a` 包裹层去掉，只保留 `<img>` 本身（带文字的正常链接不动）；可用 `unwrapImages: false` 关闭
- **封面不内嵌 base64，一律以 URL 形式提供**：
  - 仅解析（未保存）时封面写入缓存目录，返回 `http://localhost:3000/epub-covers/<sha1>.<ext>`
  - 保存为书籍后 `coverImg` 为 `/book-cover?id=<书籍id>`，由接口从 EPUB 文件中实时提取（内存缓存，取图无需重复解析）
  - 书籍编辑时封面留空会沿用自动封面地址，不会被清空
- **正文图片统一块级展示**：每个 `<img>` 都会合并为 `style="display:block"`（保留原有其它样式声明），并在前后补 `<br/>` 分隔；图片旁已有的 `<br/>` 不会重复叠加，可用 `blockImages: false` 关闭
- **章节注释统一挪到章节末尾**：本章内的注释块（多看/掌阅风格的隐藏 `div`、EPUB3 `aside`/`epub:type="footnote"`）与指向其它 xhtml 的注释链接（`<a href="notes.xhtml#fn1">`）都会被收集，从正文原位移除后追加到章节末尾，编号按注释标记在正文中的出现顺序排列：

  ```
  【注释】
  [1] 第一条注释内容
  [2] 第二条注释内容
  ```
  注号（`duokan-footnote-number`）、注释包裹 `span`、段落标签会被清理，注释内的图片同样会内嵌 base64；可用 `notesToEnd: false` 关闭，用 `notesTitle` 自定义标题（默认 `【注释】`）
- `head` 中的本地样式表会内联进章节内容，脚本与内联事件会被剔除
- 可「保存为书籍」，解析出的目录项会保存为章节标题

解析结果结构（IPC `parse-epub-file` 与 HTTP `POST /data-operate/epub/parse` 一致）：

```json
{
  "title": "书名",
  "author": "作者",
  "description": "简介",
  "cover": { "href": "OEBPS/images/cover.jpg", "mediaType": "image/jpeg", "bytes": 12345, "from": "manifest" },
  "toc": [{ "title": "第一章", "href": "OEBPS/chapter1.xhtml", "level": 0 }],
  "chapters": [
    { "index": 1, "title": "第一章", "href": "OEBPS/chapter1.xhtml", "content": "<h1>第一章</h1><img src=\"data:image/png;base64,...\"/>", "text": "第一章\n..." }
  ],
  "images": [{ "href": "OEBPS/images/pic.png", "mediaType": "image/png", "bytes": 1234 }],
  "book": { "title": "书名", "author": "作者", "coverImg": "http://localhost:3000/epub-covers/....png" }
}
```

封面原始字节通过不参与 JSON 序列化的 `coverData`（Buffer）提供给主进程，用于写缓存文件或按 URL 返回。

接口一览：

- `POST /data-operate/epub/parse`：上传并解析 EPUB，返回章节内容（章节图片为 base64）与封面 URL，不落库
- `POST /data-operate/epub/upload`：上传 EPUB，解析元数据并保存为书籍
- `GET /book-cover?id=<bookId>`：按书籍 id 返回 EPUB 提取出的封面图片
- `GET /epub-covers/<sha1>.<ext>`：未保存 EPUB 的封面缓存
- IPC：`parseEpubFile({ filePath, inlineImages, inlineStyles, includeText, unwrapImages, blockImages, notesToEnd, notesTitle })`、`uploadEpubBook({ filePath, title, author, description })`

解析由 `epubParser.js` 完成，内置最小 ZIP 读取实现（只用 Node 的 `zlib`），无需额外依赖。

## 测试

```bash
npm test
```

## 目录说明

- `main.js`：Electron 主进程，处理文件上传、SQLite 数据库存储、章节解析和静态 HTTP 服务
- `preload.js`：暴露安全 IPC 接口给渲染进程
- `db.js`：SQLite 数据库封装
- `parseRules.js`：解析规则读取与章节提取
- `epubParser.js`：EPUB（ZIP）解析，章节提取与图片 base64 内嵌
- `fileService.js`：书籍文件保存和 HTML 文件列表读取
- `index.html`：用户界面
