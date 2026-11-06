'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const allowedCommands = new Set(['home', 'send', 'receive', 'activity', 'settings', 'payment-link']);
const lockEvents = new Set(['locked', 'unlocked', 'conceal', 'changed']);

contextBridge.exposeInMainWorld('chicoryDesktop', Object.freeze({
  platform: process.platform,
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  // Returns the redacted support report as text. The wallet's own report is
  // passed in so it is redacted by the same rules before it can be copied.
  diagnostics: (input) => ipcRenderer.invoke('desktop:diagnostics', input),
  // A secret on the clipboard for a short while. The main process clears it.
  copySecret: (text) => ipcRenderer.invoke('clipboard:copy-secret', typeof text === 'string' ? text : ''),
  // Erases every wallet in this profile after the lock's fresh confirmation.
  // It takes nothing from the page.
  erase: () => ipcRenderer.invoke('desktop:erase'),
  // The portable full backup. The page passes only the passphrase; the main
  // process picks the file with the owner and moves the archive itself.
  fullBackup: Object.freeze({
    export: (passphrase) => ipcRenderer.invoke('backup:export-full', typeof passphrase === 'string' ? passphrase : ''),
    restore: (passphrase) => ipcRenderer.invoke('backup:restore-full', typeof passphrase === 'string' ? passphrase : ''),
  }),
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
