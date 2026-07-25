const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectTxtFile: () => ipcRenderer.invoke('select-txt-file'),
  uploadBook: (payload) => ipcRenderer.invoke('upload-book', payload),
  getBooks: () => ipcRenderer.invoke('get-books'),
  parseBook: (payload) => ipcRenderer.invoke('parse-book', payload),
  getRules: () => ipcRenderer.invoke('get-rules'),
  saveRules: (rules) => ipcRenderer.invoke('save-rules', rules),
  startServer: () => ipcRenderer.invoke('start-server'),
  readHtmlFiles: () => ipcRenderer.invoke('read-html-files'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url)
});
