// Builds the Windows Hello helper (desktop/windows-hello/hello.cpp) into
// .runtime/windows-hello with the host's Visual Studio C++ tools and Windows
// SDK. npm run runtime:prepare runs it on Windows. Run this file directly to
// rebuild only the helper.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HELPER_SOURCE = 'desktop/windows-hello/hello.cpp';
export const HELPER_DIRECTORY = '.runtime/windows-hello';
export const HELPER_NAME = 'chicory-hello.exe';

// The helper is built on the architecture it ships for, like the rest of the runtime.
const TOOLS = {
  x64: { target: 'x64', component: 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' },
  arm64: { target: 'arm64', component: 'Microsoft.VisualStudio.Component.VC.Tools.ARM64' },
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const system32 = (name) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);

function developerEnvironment(tools) {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  let install = '';
  try {
    install = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', tools.component, '-property', 'installationPath'],
      { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  } catch {}
  if (!install) {
    throw new Error(`The Windows Hello helper needs Visual Studio or its Build Tools, with the C++ tools for ${tools.target} and a Windows SDK.`);
  }
  const vcvars = path.join(install, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
  // cmd /s strips the outer quotes and keeps the quoted batch path intact.
  const output = execFileSync(system32('cmd.exe'), ['/d', '/s', '/c', `""${vcvars}" ${tools.target} >nul && set"`],
    { encoding: 'utf8', windowsVerbatimArguments: true, maxBuffer: 16 * 1024 * 1024 });
  const env = {};
  for (const line of output.split(/\r?\n/)) {
    const split = line.indexOf('=');
    if (split > 0) env[line.slice(0, split)] = line.slice(split + 1);
  }
  return env;
}

export async function buildWindowsHello(root, arch = process.arch) {
  if (process.platform !== 'win32') throw new Error('The Windows Hello helper is built on Windows.');
  const tools = TOOLS[arch];
  if (!tools) throw new Error(`The Windows Hello helper has no build for ${arch}.`);
  const source = path.join(root, HELPER_SOURCE);
  const destination = path.join(root, HELPER_DIRECTORY);
  const env = developerEnvironment(tools);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const work = await fs.mkdtemp(`${destination}-build-`);
  try {
    const output = path.join(work, HELPER_NAME);
    execFileSync('cl.exe', [
      '/nologo', '/std:c++17', '/permissive-', '/EHsc', '/O2', '/MT', '/GS', '/sdl', '/guard:cf',
      '/W4', '/WX', '/external:anglebrackets', '/external:W0', '/utf-8', '/DUNICODE', '/D_UNICODE', '/DNOMINMAX',
      `/Fo${work}\\`, `/Fe${output}`, source,
      // No console window, the static CRT so no redistributable is needed, and
      // static imports resolved from System32 only.
      '/link', '/SUBSYSTEM:WINDOWS', '/ENTRY:wmainCRTStartup', '/DYNAMICBASE', '/NXCOMPAT', '/guard:cf',
      '/DEPENDENTLOADFLAG:0x800', ...(arch === 'x64' ? ['/CETCOMPAT'] : []), 'windowsapp.lib', 'user32.lib',
    ], { cwd: work, env, stdio: 'inherit' });
    const binary = await fs.readFile(output);
    const build = { source: sha256(await fs.readFile(source)), arch, sha256: sha256(binary) };
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, HELPER_NAME), binary);
    await fs.writeFile(path.join(destination, 'build.json'), JSON.stringify(build, null, 2) + '\n');
    return build;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const build = await buildWindowsHello(fileURLToPath(new URL('../../', import.meta.url)));
  console.log(`Windows Hello helper ready for ${build.arch}: ${HELPER_DIRECTORY}/${HELPER_NAME} ${build.sha256}.`);
}
