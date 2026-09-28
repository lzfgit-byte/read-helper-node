const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectTxtFile: () => ipcRenderer.invoke('select-txt-file'),
  uploadBook: (payload) => ipcRenderer.invoke('upload-book', payload),
  getBooks: () => ipcRenderer.invoke('get-books'),
  parseBook: (payload) => ipcRenderer.invoke('parse-book', payload),
  openBookFolder: (bookId) => ipcRenderer.invoke('open-book-folder', bookId),
  deleteBook: (bookId) => ipcRenderer.invoke('delete-book', bookId),
  getRules: () => ipcRenderer.invoke('get-rules'),
  saveRules: (rules) => ipcRenderer.invoke('save-rules', rules),
  startServer: () => ipcRenderer.invoke('start-server'),
  readHtmlFiles: () => ipcRenderer.invoke('read-html-files'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  updateBook: (payload) => ipcRenderer.invoke('update-book', payload),
  // EPUB：上传解析（图片以 base64 内嵌返回）与保存为书籍
  parseEpubFile: (payload) => ipcRenderer.invoke('parse-epub-file', payload),
  uploadEpubBook: (payload) => ipcRenderer.invoke('upload-epub-book', payload)
});
