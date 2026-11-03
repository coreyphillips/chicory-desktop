'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const allowedCommands = new Set(['home', 'send', 'receive', 'activity', 'settings', 'payment-link']);

contextBridge.exposeInMainWorld('chicoryDesktop', Object.freeze({
  platform: process.platform,
  version: '0.1.0',
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  onCommand: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, command, value) => {
      if (allowedCommands.has(command)) callback(command, typeof value === 'string' ? value : undefined);
    };
    ipcRenderer.on('desktop:command', listener);
    return () => ipcRenderer.removeListener('desktop:command', listener);
  },
}));
