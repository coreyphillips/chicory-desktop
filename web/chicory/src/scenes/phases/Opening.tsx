import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { Network } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { Bloom } from '../../glyphs/Bloom';
import { Whisper } from '../../glyphs/Whisper';
import { useFocus } from '../../motion/focus';
import { PhaseRoot } from './parts';
import { bloomTone, QUIET_MS, SIZES, TONE_WAIT_MS } from './visual';

/**
 * The restore at launch, before it is known whether there is a wallet to
 * show: the bloom's chase, a light running round the petals, and nothing to
 * read. A screen reader hears the wait, marked busy. A quick open ends
 * before the loader shows. It chases in the tone of the network it opens on,
 * slate off mainnet, so the loader and the mark it hands over to are one
 * colour: until that network is `known`, it holds back, its quiet counted
 * from its mount, so it is never drawn in bloom on a test network and turned
 * slate mid-chase. Should the network take longer than TONE_WAIT_MS to be
 * known, it shows in the tone it has.
 */
export function Opening({
  network,
  known = true,
}: {
  network?: Network;
  known?: boolean;
}) {
  const [since] = useState(() => Date.now());
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (known) return;
    const late = setTimeout(() => setWaited(true), TONE_WAIT_MS);
    return () => clearTimeout(late);
  }, [known]);
  const shown = known || waited;
  const focus = useFocus(shown);
  if (!shown) return null;
  return (
    <PhaseRoot delay={Math.max(0, QUIET_MS - (Date.now() - since))}>
      <Whisper label={copy.phase.openingWallet}>
        <View
          ref={focus}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={copy.phase.openingWallet}
          accessibilityState={{ busy: true }}
        >
          <Bloom size={SIZES.loader} mode="chase" tone={bloomTone(network)} />
        </View>
      </Whisper>
    </PhaseRoot>
  );
}
