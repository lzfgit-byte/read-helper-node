# Reader Helper Electron

Electron 应用，支持：

- 上传 TXT 文件
- 按章节解析 TXT 内容
- 标题被拆成多行时自动合并（如「第十二章」+「风起云涌」→「第十二章 风起云涌」，正文跟在合并后的目录后）
- 上传 EPUB / PDF 文件并解析章节（图片以 base64 内嵌返回，注释统一移到章节末尾）
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

2. 启动后，使用界面上传 TXT/EPUB/PDF 书籍、保存解析规则、启动 HTML 服务。

## TXT 章节解析

按「章节规则 + 目录项」识别标题；标题被拆成多行（源文件里目录与标题名分行）时会自动合并：

- 条件：**当前目录没有正文**（正文为空，或解析时用标题充当了占位正文）、**下一个目录有正文**、
  且**两个标题合起来仍符合章节规则**（或与已配置的目录项完全一致）
- 结果：合并为一个目录，标题形如 `第一章 风起云涌`（也支持无空格写法，取决于哪个仍符合规则），正文跟在合并后的目录之后
- 不合并的情况：下一标题本身就是完整的「第X章」标题（如「序章」+「第一章 出发」）、合并后超出标题长度限制、
  或标题里带句子标点（`。！？；，、`，通常是被误判成标题的正文）

## 电子书解析（EPUB / PDF）

「电子书上传解析」页（Electron 界面）或浏览器页面 `http://localhost:3000/epub` 同时支持 EPUB 与 PDF，按文件后缀（`.epub` / `.pdf`）自动分发到对应解析器，章节结果结构保持一致。

### EPUB

- 选择 `.epub` 文件后上传，自动读取书名、作者、简介与封面
- 按 `spine` 顺序输出章节，章节标题优先取 `<h1>~<h6>`，其次取 NCX/Nav 目录标题
- **标题被拆到不同 xhtml 时自动合并**：某章没有正文（空内容或只有标题）、下一章有正文，且两个标题合起来仍符合章节规则时，合并为一个目录（如「第十二章」+「风起云涌」→「第十二章 风起云涌」，正文跟在合并后的目录后）。判断逻辑与 TXT 章节解析完全共用（`parseRules.js` 的 `mergeChapterTitles`），服务端会把当前章节规则传进来；插图页（只含 `<img>`）和下一章本身是完整「第X章」标题的情况不合并，合并后的章节会带 `sourceHrefs` 便于排查
- 章节内的图片（`<img>`、SVG `<image>`、CSS `url(...)`）默认转成 `data:<mime>;base64,...` 内嵌在返回的 HTML 中，前端无需再请求图片接口
  - **但不再“无限内嵌”**：整本内嵌总量默认上限 24 MB、单张 8 MB，超过的图片在**已保存的书籍**里会自动改用 `/epub-image?id=<书籍id>&href=<书籍内路径>` 按需地址（图片实时从 EPUB 里取出并少量缓存，LRU 64），图片很多的漫画类书籍不会再把堆撑爆；未保存的解析（没有按需地址）则会跳过并在 `book.warnings` 里提示
  - 可用 `imageMode: 'url'` 把全部图片改为按需地址，`imageMode: 'none'` 完全不处理图片（保留原始相对地址），`maxInlineImageBytes` / `maxImageBytes` 调整预算
  - 统计在 `stats` 里：`imageMode`（`inline`/`url`/`none`）、`imageCount`（引用张数）、`inlinedImages`（base64 张数）、`imageBytes`、`skippedImages`（改用按需或跳过）
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

- `POST /data-operate/epub/parse`：上传并解析 EPUB/PDF，返回章节内容（章节图片为 base64）与封面 URL，不落库
- `POST /data-operate/epub/upload`：上传 EPUB/PDF，解析元数据并保存为书籍
- `GET /book-cover?id=<bookId>`：按书籍 id 返回从 EPUB/PDF 里提取出的封面图片
- `GET /epub-image?id=<bookId>&href=<书籍内路径>`：按需返回 EPUB 里的正文图片（超内嵌预算的章节图片地址）
- `GET /pdf-page?id=<bookId>&page=<页号>&name=<图片名>`：按页实时解码并返回 PDF 正文图片（正文里的按需地址）
- `GET /epub-covers/<sha1>.<ext>`：未保存电子书的封面缓存
- `GET /epub-covers/<sha1>.<ext>`：未保存电子书的封面缓存
- IPC：`parseEpubFile({ filePath, inlineImages, inlineStyles, includeText, unwrapImages, blockImages, notesToEnd, notesTitle, chapterMode })`、`uploadEpubBook({ filePath, title, author, description })`（PDF 只用到 `includeText`、`chapterMode` 等与自身相关的选项，其余会被忽略）

解析由 `epubParser.js` 完成，内置最小 ZIP 读取实现（只用 Node 的 `zlib`），无需额外依赖。

## PDF 解析

与 EPUB 走同一条上传/解析链路（同一个界面、同一套接口与 IPC，文件名以 `.pdf` 结尾即自动分发到 `pdfParser.js`）：

- **分章方式**：优先按 PDF 书签（`/Outlines`，支持 `Dest` 与 `A /D`，按层级取 `level`）分章，书签指向的页码区间即章节正文；没有书签时降级为「每页一章」，标题为 `第 N 页`（可用 `chapterMode: 'page'` 强制按页）
- 同样执行**目录合并**：某个目录没有正文（空内容或只有标题）、下一个目录有正文，且两个标题合起来仍符合章节规则时合并为一条（与 TXT/EPUB 共用 `parseRules.mergeChapterTitles`）
- **文本抽取**：内容流支持 `BT/ET`、`Tf/TL/Td/TD/T*/Tm`、`Tj`、`'`、`"`、`TJ`（水平间距 ≤ -200 判为空格），并会递归进入 `Do` 调用的 Form XObject；段落按行合并（上一行以 `。！？；：…——”"'）】》」』〕）\]\)．.!?;` 结尾或长度不足 8 字则不合并）
- **正文图片默认按需加载（不再全量 base64）**：页面内容流里 `Do` 到的图片会按「文本 / 图片」出现的先后顺序插进章节正文：
  - **已保存的书籍**：正文里只放一个按需地址 `<img src="/pdf-page?id=<书籍id>&page=12&name=Im0" style="display:block;max-width:100%;height:auto;"/>`，图片每页实时解码后返回并少量缓存（LRU 32）。扫描版一页一张整页图时，单章 HTML 只有几百字节，不会把主进程内存拉爆
  - **未保存的解析（预演/书源一次性取全书）**：默认 base64 内嵌（与 EPUB 一致），但受 **单张 8 MB / 全书 24 MB** 预算限制，超出的图片会被跳过并计入 `stats.skippedImages`（`book.warnings` 会提示）。可传 `imageMode: 'url' | 'none' | 'inline'`、`imageUrlBase`、`maxInlineImageBytes` 自行控制
  - 图片位置优先按 y 坐标从大到小排序（PDF 原点在左下角），文字与图片都能拿到坐标时更接近视觉顺序；坐标不可比（进入过 Form XObject）时退回内容流顺序；内嵌模式下同一章里重复引用的同一张图只嵌一次
  - 图片数量与「是否内嵌」无关：`chapter.imageCount` 始终反映页面里检测到的图片数，所以**章节结构不会因为图片模式而变化**（同样的章节数、同样的 id/顺序）
- **内存安全底线**（防住扫描书把堆撑爆）：单个流解压上限 64 MB（`zlib` 的 `maxOutputLength`，防解压炸弹）、单张图片像素上限 32 MP、单张内嵌字节上限 8 MB；异常尺寸的图片直接跳过而不是尝试分配
- **字体与编码**：`Type0`/复合字体按 2 字节编码处理，优先用 `ToUnicode` CMap（支持 `beginbfchar` 与 `beginbfrange`，目标含多码元时进位正确）；没有 CMap 时按编码名回退（`UCS2/UTF16*` 直当 Unicode、`GBK-EUC/GBPC` 用 `TextDecoder('gbk')`、`ETEN/BIG5` 用 `TextDecoder('big5')`）；简单字体用 WinAnsi 表回退；解析不出映射的码会在 `stats.unmappedCodes` 里计数
- **扫描版识别**：整本没有文本层（每页只有整页图片）时 `stats.scanned` 为 `true`，`book.warnings` 会带上「扫描版 PDF：没有文本层，正文以内嵌整页图片提供」（按需模式下则是「按需加载整页图片」）的提示
- **封面**：取首页中面积最大的图片对象，`DCTDecode` 直接输出 `image/jpeg`；`FlateDecode` 的灰度/RGB/CMYK 像素重新编码为 PNG；`JPXDecode` 原样输出 `image/jp2`（扫描书的首图）
- **封面同样不内嵌 base64**：地址规则与 EPUB 完全一致（`/epub-covers/<sha1>.<ext>` / `/book-cover?id=<书籍id>`）
- **零依赖、容错解析**：只用 Node 内置 `zlib`，自己扫描 `N G obj`（不依赖 xref/xref stream），支持对象流（`/Type /ObjStm`）、流长度缺失时按 `endstream` 定位、`FlateDecode`（含 `inflate`/`inflateRaw` 回退与 PNG/TIFF predictor）、`ASCIIHexDecode`、`ASCII85Decode`

解析结果结构与 EPUB 保持一致（`pageCount`、`outlineCount`、`stats.textPageCount`、`stats.scanned` 为 PDF 额外字段），章节字段多一个 `pages: [起页, 止页]` 与 `imageCount`：

```json
{
  "title": "书名",
  "author": "作者",
  "pageCount": 274,
  "outlineCount": 12,
  "cover": { "href": "page:1/image", "mediaType": "image/jp2", "bytes": 235561, "from": "page-image" },
  "chapters": [
    {
      "index": 1,
      "title": "第一章",
      "href": "page:1",
      "pages": [1, 18],
      "content": "正文<br/><br/><img src=\"/pdf-page?id=5&page=12&name=Im0\" style=\"display:block;max-width:100%;height:auto;\" /><br/>更多正文",
      "text": "纯文本（不含图片，供目录与合并判断使用）",
      "imageCount": 2,
      "images": [{ "page": 12, "name": "Im0", "url": "/pdf-page?id=5&page=12&name=Im0", "mediaType": "image/jpeg" }]
    }
  ],
  "images": [{ "name": "Im1", "mediaType": "image/jpeg", "bytes": 20480 }],
  "stats": {
    "pageCount": 274, "chapterCount": 12, "textLength": 123456, "textPageCount": 260,
    "scanned": false, "imageMode": "url", "imageCount": 12,
    "inlinedImages": 0, "imageBytes": 0, "skippedImages": 0
  }
}
```

内嵌模式（`imageMode: 'inline'`）下 `content` 里是 `data:image/...;base64,...`，`chapter.images` 带 `bytes`，`stats.inlinedImages/imageBytes` 反映实际内嵌量。

`parse-epub-file` / `POST /data-operate/epub/parse` 返回会多一个 `format` 字段（`epub` / `pdf`）便于前端区分展示，`book` 摘要里也带 `format/pageCount/outlineCount/scanned/imageCount/warnings`。

阅读器的两个内部接口都走同一条解析链路：`/bookinfo`（只列目录）传 `inlineImages: false`，避免为了一份目录反复生成 base64；`/content`（取正文）则输出 `/pdf-page` 按需图片地址。

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
- `pdfParser.js`：PDF 解析（自写对象扫描/流解压/文本抽取/书签分章/封面提取），零依赖
- `fileService.js`：书籍文件保存和 HTML 文件列表读取
- `index.html`：用户界面
