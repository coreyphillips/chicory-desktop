'use strict';

const path = require('node:path');

function supportedHost(platform, arch) {
  return platform === 'darwin' && ['arm64', 'x64'].includes(arch) ||
    ['linux', 'win32'].includes(platform) && arch === 'x64';
}

// The only packaged trust source is package.json inside app.asar. A resource
// beside the executable, a profile preference, or an environment variable
// cannot turn a normal build into a preview or substitute another digest.
function previewCandidate(metadata, resources, platform = process.platform, arch = process.arch) {
  const pin = metadata?.chicoryFlorestaPreview;
  if (metadata?.chicoryChannel !== 'floresta-preview' || !supportedHost(platform, arch) ||
      pin?.version !== 1 || pin.platform !== platform || pin.arch !== arch ||
      typeof pin.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pin.sha256) ||
      typeof pin.sourceBinarySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pin.sourceBinarySha256) ||
      (platform !== 'darwin' && pin.sha256 !== pin.sourceBinarySha256)) return null;
  return { binary: path.join(resources, 'runtime', 'floresta', platform === 'win32' ? 'florestad.exe' : 'florestad'), sha256: pin.sha256 };
}

module.exports = { previewCandidate, supportedHost };
