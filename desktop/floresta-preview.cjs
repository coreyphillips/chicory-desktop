'use strict';

const path = require('node:path');

// The only packaged trust source is package.json inside app.asar. A resource
// beside the executable, a profile preference, or an environment variable
// cannot turn a normal build into a preview or substitute another digest.
function previewCandidate(metadata, resources, platform = process.platform, arch = process.arch) {
  const pin = metadata?.chicoryFlorestaPreview;
  if (metadata?.chicoryChannel !== 'floresta-preview' || platform !== 'darwin' ||
      pin?.version !== 1 || pin.platform !== platform || pin.arch !== arch ||
      typeof pin.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pin.sha256) ||
      typeof pin.sourceBinarySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pin.sourceBinarySha256)) return null;
  return { binary: path.join(resources, 'runtime', 'floresta', 'florestad'), sha256: pin.sha256 };
}

module.exports = { previewCandidate };
