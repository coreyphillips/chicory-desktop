'use strict';

const codeSign = require('app-builder-lib/out/codeSign/macCodeSign');

/**
 * electron-builder hands codesign the certificate's name. codesign searches
 * every keychain, and refuses the name as ambiguous when another keychain holds
 * a certificate with the same name, even the same certificate. The hash of the
 * certificate imported from CSC_LINK names exactly one. Everything else stays
 * as electron-builder set it, and it still notarizes after this returns.
 */
module.exports = async function signByHash(options) {
  if (!options.keychain) throw new Error('Set CSC_LINK. A release signs only with the certificate imported from it.');
  const identity = await codeSign.findIdentity('Developer ID Application', null, options.keychain);
  if (!identity) throw new Error('CSC_LINK did not provide a valid Developer ID Application certificate.');
  return codeSign.sign({ ...options, identity: identity.hash });
};
