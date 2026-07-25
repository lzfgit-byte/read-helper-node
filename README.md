# Reader Helper Electron

Electron 应用，支持：

- 上传 TXT 文件
- 按章节解析 TXT 内容
- 配置章节解析规则
- SQLite 存储书籍信息
- 启动 HTTP 服务返回已有 HTML 文件

## 运行

1. 在 `d:\projects\read-helper-node` 目录下运行
   ```bash
   npm install
   npm start
   ```

2. 启动后，使用界面上传 TXT 书籍、保存解析规则、启动 HTML 服务。

## 目录说明

- `main.js`：Electron 主进程，处理文件上传、SQLite 数据库存储、章节解析和静态 HTTP 服务
- `preload.js`：暴露安全 IPC 接口给渲染进程
- `db.js`：SQLite 数据库封装
- `parseRules.js`：解析规则读取与章节提取
- `fileService.js`：书籍文件保存和 HTML 文件列表读取
- `index.html`：用户界面
