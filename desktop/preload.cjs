'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const allowedCommands = new Set(['home', 'send', 'receive', 'activity', 'settings', 'payment-link']);
const lockEvents = new Set(['locked', 'unlocked', 'conceal', 'changed']);

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
  // The main process owns the lock. These calls can only ask it to prompt.
  lock: Object.freeze({
    state: () => ipcRenderer.invoke('lock:state'),
    unlock: () => ipcRenderer.invoke('lock:unlock'),
    setEnabled: (enabled) => ipcRenderer.invoke('lock:set-enabled', enabled === true),
    authorize: () => ipcRenderer.invoke('lock:authorize'),
    onEvent: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, name, value) => {
        if (lockEvents.has(name)) callback(name, typeof value === 'string' || typeof value === 'boolean' ? value : undefined);
      };
      ipcRenderer.on('desktop:lock', listener);
      return () => ipcRenderer.removeListener('desktop:lock', listener);
    },
  }),
}));
