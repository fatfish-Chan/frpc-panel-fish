// 给页面暴露窗口控制（只有 Electron 里有）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fishWin', {
  min: () => ipcRenderer.send('win:min'),
  hide: () => ipcRenderer.send('win:hide'),
  toggleMax: () => ipcRenderer.invoke('win:toggle-max'),
  isMax: () => ipcRenderer.invoke('win:is-max'),
});
