'use strict';

const { createHash } = require('node:crypto');

// Floresta v0.9.1 mainnet Assume Utreexo commitment, tied to the approved build.
// The other supported networks start from genesis.
const checkpoint = Object.freeze({
  height: 939969,
  hash: '000000000000000000009d36aae180d04aeac872adb14e22f65c8b6647a8bf79',
});
function headerHash(hex) {
  const first = createHash('sha256').update(Buffer.from(hex, 'hex')).digest();
  return createHash('sha256').update(first).digest().reverse().toString('hex');
}

async function checkActiveCheckpoint(network, state, readHeaders) {
  if (network !== 'mainnet' || state.checkpointEligible !== true || !state.tipSynced || state.validatedHeight !== state.height ||
      state.historicalVerification !== 'verifying' || state.historicalTarget !== checkpoint.height ||
      state.height < checkpoint.height) return false;
  const [before, anchor, after] = await readHeaders([state.height, checkpoint.height, state.height]);
  return before === after && headerHash(before) === state.tipHash && headerHash(anchor) === checkpoint.hash;
}

// This is only the chain validation gate. Owner coverage and all Lightning
// admission checks still apply on each wallet operation.
function chainTrustAccepted(state) {
  return state.historicalVerification === 'verified' ||
    (state.network === 'mainnet' && state.historicalVerification === 'verifying' &&
     state.historicalTarget === checkpoint.height && state.checkpointAccepted === true);
}

module.exports = { checkpoint, headerHash, checkActiveCheckpoint, chainTrustAccepted };
