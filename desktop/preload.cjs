// Gives the farm page the same bridge the macOS app has (window.farmNative.postMessage).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('farmNative', {
  postMessage: (msg) => ipcRenderer.send('farm', msg),
});
// the error page's "Try again" button
contextBridge.exposeInMainWorld('farmShell', { restart: () => ipcRenderer.send('farm', { type: 'restart' }) });
