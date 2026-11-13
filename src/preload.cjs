/** Minimal, explicit bridge between the Calci UI and the desktop shell. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calciDesktop', {
  platform: process.platform,
  version: '1.1.0',
  setAlwaysOnTop: (on) => ipcRenderer.invoke('calci:setAlwaysOnTop', !!on),
  isAlwaysOnTop: () => ipcRenderer.invoke('calci:isAlwaysOnTop'),
  setTitleBarTheme: (theme) => ipcRenderer.send('calci:titleBarTheme', theme === 'dark' ? 'dark' : 'light'),
  openExternal: (url) => ipcRenderer.send('calci:openExternal', String(url)),
});
