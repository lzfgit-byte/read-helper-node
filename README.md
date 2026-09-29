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
- 章节内的图片（`<img>`、SVG `<image>`、CSS `url(...)`）默认转成 `data:<mime>;base64,...` 嵌在返回的 HTML 中（HTTP 与 IPC 都是，见「正文图片地址」一节；想要绝对地址传 `imageMode: 'url'` / `?images=url`）
  - **默认不设总量上限**：一本 340 张图的 85 MB 书若选 base64 会内嵌约 72 MB（图片只做 base64，不做压缩转换）
  - **整本一次性解析不会爆内存**：`/content` 只解析请求的那一章（`/bookinfo` 的链接带 `&index=`，解析时只给这一章生成图片，其余章节只保留结构）
  - **按章解析不改变章节结构**：判断章节「有没有图片」用的是**原始**内容（`chapter.hasImages`），不是已经内联过图片的 HTML，因此章节合并/数量/标题与整本解析完全一致。否则同一本书两次解析的章节下标会错位（`/bookinfo` 给的下标到了 `/content` 变成另一章，那一章的图片也就不是 base64 了）
  - 单张图片上限 8 MB（`maxImageBytes`），更大的单张图会跳过并计入 `skippedImages`；`maxInlineImageBytes` 给正数时才启用整本总量预算（超限的图片会改用按需地址或跳过）
  - **字体等非图片资源默认不内嵌**：同一字体常被多章引用，base64 会在每章重复一份（某本书光字体就 23 MB）→ 统一改为按需地址，需要旧行为可传 `inlineFonts: true`
  - 图片地址可选：`imageMode: 'url'`（默认给绝对地址）、`'inline'`（base64）、`'none'`；未保存的解析（没有书籍 id）会退到 `ebook-assets` 磁盘缓存，返回 `/ebook-assets/<sha1>.<ext>` 的绝对地址
  - 统计在 `stats` 里：`imageMode`（`inline`/`url`/`none`）、`imageCount`（引用张数）、`inlinedImages`（base64 张数）、`imageBytes`、`skippedImages`（改用按需或跳过）
- **正文图片直接内联展示**：多看书系等 EPUB 会把插图/注号图包成 `<sup><a href="..."><img/></a></sup>`，解析时会把这类「只包图片」的 `sup`/`sub`/`a` 包裹层去掉，只保留 `<img>` 本身（带文字的正常链接不动）；可用 `unwrapImages: false` 关闭
- **单图 `<svg><image>` 一律换成 `<img>`**：Calibre 导出的封面页常用 `<svg><image xlink:href="..."/></svg>`，阅读器渲染不了这种写法，现在不管有没有内嵌成功都输出固定格式的 `<img>`（未内嵌时保留原相对地址，按章解析时不再出现“同一页在两次解析里一个变成 `<img>` 一个还是 `<svg>`”的差异）
- **懒加载图片（微信读书等导出）**：`<img data-src="..." src="占位/相对路径">` 这类写法里，base64 写进真正的 `src`；`src` 是空值或 1×1 占位图时会改用 `data-src` / `data-original` 等属性指向的书内图片。这些懒加载候选属性（含 `srcset`）**在所有情况下都会被清掉**（输出就是上面的固定格式）——legado 的 `HtmlFormatter.formatKeepImg()` 只要发现有 `data-src` / `data-original` 就只认它，`src` 里放什么都不管
- **封面不内嵌 base64，一律以 URL 形式提供**：
  - 仅解析（未保存）时封面写入缓存目录，返回 `http://localhost:3000/epub-covers/<sha1>.<ext>`
  - 保存为书籍后 `coverImg` 为 `/book-cover?id=<书籍id>`，由接口从 EPUB 文件中实时提取（内存缓存，取图无需重复解析）
  - 书籍编辑时封面留空会沿用自动封面地址，不会被清空
- **正文图片统一成固定格式**：所有正文图片只输出下面这一种写法（不管是 base64、按需 URL，还是书里原本的外链），`data-ratio` / `data-w` / `data-w-new` / `class` / `srcset` / `data-src` 等属性一律丢弃：

  ```html
  <img src="data:image/jpeg;base64,..." alt="" width="100%" height="100%" style="display:block">
  ```

  图片前后会各补一个 `<br/>` 分隔（旁边已有的 `<br/>` 不会重复叠加），可用 `blockImages: false` 只关掉这两个 `<br/>`（标签格式仍固定）
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
- `GET /ebook-assets/<sha1>.<ext>`：仅解析（未保存）时超预算图片/字体的磁盘缓存（按内容去重）
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
- **正文图片默认给绝对地址（阅读 App 只能加载这种地址）**：页面内容流里 `Do` 到的图片按「文本 / 图片」出现的先后顺序插进章节正文，地址形如 `http://<请求 Host>/pdf-page?id=<书籍id>&page=12&name=Im0`（每页实时解码 + LRU 32 缓存）；传 `imageMode: 'inline'` 可改成 base64 内嵌
  - 图片位置优先按 y 坐标从大到小排序（PDF 原点在左下角），文字与图片都能拿到坐标时更接近视觉顺序；坐标不可比（进入过 Form XObject）时退回内容流顺序；同一章里重复引用的同一张图只嵌一次
  - **整本一次性解析不会因为图片多而爆内存**：`/content` 只解析请求的那一章（`/bookinfo` 的链接带 `&index=`，解析器只给这一章生成图片，其余章节只保留结构），单章字节数 ≈ 这一章的图片大小
  - 需要 URL 形式时可显式传 `imageMode: 'url'`（配 `/pdf-page` 按需地址）或 `'none'`；`maxInlineImageBytes` 给正数时才会在超总量时降级（默认 0 = 不限），`imageMode: 'url'` 配合 `/pdf-page` 时图片每页实时解码 + LRU 小缓存
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
      "content": "正文<br/><br/><img src=\"data:image/jpeg;base64,...\" style=\"display:block;max-width:100%;height:auto;\" /><br/>更多正文",
      "text": "纯文本（不含图片，供目录与合并判断使用）",
      "imageCount": 2,
      "images": [{ "page": 12, "name": "Im0", "mediaType": "image/jpeg", "bytes": 20480 }]
    }
  ],
  "images": [{ "name": "Im1", "mediaType": "image/jpeg", "bytes": 20480 }],
  "stats": {
    "pageCount": 274, "chapterCount": 12, "textLength": 123456, "textPageCount": 260,
    "scanned": false, "imageMode": "inline", "imageCount": 12,
    "inlinedImages": 12, "imageBytes": 245760, "skippedImages": 0
  }
}
```

`imageMode: 'url'` 时 `content` 里改放 `/pdf-page?id=<书籍id>&page=12&name=Im0` 这样的按需地址，`stats.inlinedImages/imageBytes` 为 0。

`parse-epub-file` / `POST /data-operate/epub/parse` 返回会多一个 `format` 字段（`epub` / `pdf`）便于前端区分展示，`book` 摘要里也带 `format/pageCount/outlineCount/scanned/imageCount/warnings`。

阅读器的两个内部接口都走同一条解析链路：`/bookinfo`（只列目录）传 `inlineImages: false`，链接里带 `&index=<章节下标>`；`/content` 用这个下标只解析那一章。

### 正文图片地址：为什么默认 base64

对照 legado 源码（`data/src/commonMain/.../analyzeRule/AnalyzeUrlCore.kt`、`ui/.../page/provider/ReaderImageResolver.kt`）：

- **网络书**（书源书籍）：取图走 `ReaderImageResolver` → `AnalyzeUrlCore(rawUrl = src)`，而 `AnalyzeUrlCore.getByteArrayIfDataUri()` **支持 `data:` URI**（`if (!url.isDataUrl()) return null; … MimeBase64Decoder.decode(...)`）→ **base64 能显示** ✓；相对地址会被 `NetworkUtils.getAbsoluteURL(baseUrl, src)` 按书籍地址拼成 HTTP 地址（拼不对就 404），所以不要用相对地址
- **本地书**（把 epub 文件直接导入阅读器）：`EpubFile.getBody` 会保留 `data:` URI（`if (src.isDataUrl())`），但随后 `FileBook.getImage(book, src)` 只在包内按 href 找资源 → 本地书适合用书内相对 href

因此默认策略是：

| 场景 | 默认 | 说明 |
| --- | --- | --- |
| HTTP（`/content`、`POST /data-operate/epub/parse|upload`） | **base64 内嵌** | 网络书书源链路能直接显示；传 `?images=url`（或 `imageMode=url`）才改发绝对地址 |
| IPC / Electron 界面预览 | **base64 内嵌** | Chromium 支持 `data:` |
| 可选 | `imageMode: 'url'` | 发 `http://<请求 Host>/epub-image?id=..&href=..` 绝对地址，图片按需从书籍里取（LRU 缓存） |

图片标签里的 `data-src` / `data-original` / `data-lazy-src` / `data-echo` / `data-url` / `srcset` **一律清掉**（不管这张图有没有取到、有没有换成 base64），因为 legado 的正文处理器 `HtmlFormatter.formatKeepImg()`（`foundation/src/commonMain/.../HtmlFormatter.kt`，网络书在 `BookContent.kt` 里调用）对 `img` 是这么取地址的：

```kotlin
val src = when {
    node.hasAttr("data-src")      -> node.absUrl("data-src").ifEmpty { node.attr("data-src") }
    node.hasAttr("data-original") -> node.absUrl("data-original").ifEmpty { node.attr("data-original") }
    else                          -> node.absUrl("src").ifEmpty { node.attr("src") }
}
str.append("<img src=\"$src\"")   // 其它属性全丢
```

也就是说：**只要标签里还有 `data-src`，legado 就只用 `data-src`，把我们在 `src` 里放的 base64 直接扔掉**（微信读书导出的 `<img data-src="https://res.weread.qq.com/…" src="…">` 正是这种情况，图片会变成破图）。所以这两个属性必须清掉，`src` 才是唯一生效的地址。

因此正文图片一律重建成固定格式（EPUB 与 PDF 都是），原有的其它属性全部丢弃：

```html
<img src="data:image/jpeg;base64,..." alt="" width="100%" height="100%" style="display:block">
```

`buildContentImageTag()`（`epubParser.js` / `pdfParser.js`）是唯一的出口，`blockImages` 只控制前后的 `<br/>`，不影响标签格式。

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
