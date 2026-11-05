import path from 'node:path';

// Git Bash can put GNU tar ahead of the system tool. It treats a Windows
// drive letter in an archive argument as a remote hostname.
export const systemTar = process.platform === 'win32'
  ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
  : 'tar';
