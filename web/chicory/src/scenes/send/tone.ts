import { createContext, useContext } from 'react';
import { palette } from '../../design/palette';

/**
 * Bloom as a payment draws it (REDESIGN.md 3.1): on a test network slate
 * stands in for it everywhere, so a payment of play money never looks like
 * one of real money. `soft` is the fill behind a control, bloomSoft or on a
 * test network slateSoft, and `hi` the sparks of a hold that commits.
 */
export interface Bloom {
  tone: string;
  soft: string;
  hi: string;
}

const LIVE: Bloom = {
  tone: palette.bloom,
  soft: palette.bloomSoft,
  hi: palette.bloomHi,
};

const TEST: Bloom = {
  tone: palette.slate,
  soft: palette.slateSoft,
  hi: palette.slate,
};

export const bloomFor = (test: boolean): Bloom => (test ? TEST : LIVE);

/** Whether the payment being drawn is on a test network. */
export const TestNetwork = createContext(false);

/** Bloom for the payment this is drawn in. */
export const useBloom = (): Bloom => bloomFor(useContext(TestNetwork));

/** Whether the payment this is drawn in is on a test network. */
export const useTestNetwork = (): boolean => useContext(TestNetwork);
