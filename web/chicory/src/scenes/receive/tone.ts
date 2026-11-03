import { createContext, useContext } from 'react';
import { mixHex, palette } from '../../design/palette';

/**
 * Bloom as Receive draws it, and the shades it takes from bloom, or slate in
 * their place on a test network (REDESIGN.md 3.1), so nothing a test wallet
 * asks to be paid can be taken for mainnet money.
 */
export interface Bloom {
  /** Glyphs, rings, orbits and the primary control. */
  bloom: string;
  /** The offline switch's track while it is on. */
  night: string;
  /** The petals a paid request bursts into. */
  hi: string;
}

const LIVE: Bloom = {
  bloom: palette.bloom,
  night: palette.bloomNight,
  hi: palette.bloomHi,
};

const TEST: Bloom = {
  bloom: palette.slate,
  night: mixHex(palette.slate, palette.roast, 0.5),
  hi: palette.slate,
};

/** Bloom on a live network, slate on a test one. */
export const bloomFor = (test: boolean): Bloom => (test ? TEST : LIVE);

/**
 * Whether what Receive draws is for a wallet on a test network. Outside a
 * provider it is not, as for a caller that never says.
 */
export const TestNetwork = createContext(false);

/** Bloom, or slate in its place, for whatever is drawn here. */
export const useBloom = (): Bloom => bloomFor(useContext(TestNetwork));

/**
 * Whether what is drawn here is for a test network, for a glyph that takes
 * its own `test`, such as an expiry ring.
 */
export const useTestNetwork = (): boolean => useContext(TestNetwork);
