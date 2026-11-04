/**
 * The app's own stage, drawn over the gallery's wallet: the shell phase or
 * the canvas, with the scene a state opens, exactly as the app draws them
 * below its providers. Only the session is the gallery's.
 */
import React, { useEffect } from 'react';
import type { Activity, Network, WalletSnapshot } from '@beignet/wallet-core';
import type { WalletAdapter } from '../chicory/src/services/wallet';
import type { Phase } from '../chicory/src/stage/phase';
import type { StageAction } from '../chicory/src/stage/scene';
import { Stage } from '../chicory/src/stage/Stage';
import { StageProvider, useStageStore } from '../chicory/src/stage/StageContext';
import type { AutoPay } from '../chicory/src/services/autoPayPreference';
import { clientOf, onMainnet, sessionOf } from './fakes';
import { setAutoPay } from './sealed';
import type { Session } from './fakes';

type Remembered = NonNullable<Session['rememberedSession']>;
import { counter, useCount } from './shots';
import type { Counter, Shot, Step, Take } from './shots';

/** One moment of a state: the phase the app is in, and its session. */
export interface Frame {
  phase: Phase;
  session: Session;
}

const noop = () => {};

function Staged({
  frames,
  count,
  open,
}: {
  frames: Frame[];
  count: Counter;
  open: StageAction[];
}) {
  const stage = useStageStore();
  const { dispatch } = stage;
  const at = Math.min(useCount(count), frames.length - 1);
  const { phase, session } = frames[at];
  // The scene is opened once the canvas is up, so it moves there as it does
  // when a control opens it.
  useEffect(() => {
    for (const action of open) dispatch(action);
  }, [dispatch, open]);
  return (
    <StageProvider value={stage}>
      <Stage phase={phase} session={session} onUnlock={noop} />
    </StageProvider>
  );
}

/**
 * The stage in each of `frames` in turn, one a step after the state's own
 * `steps`, with the actions in `open` dispatched as it mounts.
 */
export function staged(
  frames: Frame[],
  open: StageAction[] = [],
  steps: Step[] = [],
): Take {
  const count = counter();
  return {
    view: <Staged frames={frames} count={count} open={open} />,
    steps: [...steps, ...frames.slice(1).map(() => count.next)],
  };
}

/** Hides the balance, through the hero's own handler. */
export const hideBalance: Step = drive => drive.call('onToggleHidden');

/**
 * Rolls the balance on to its next face, through the hero's own handler:
 * the integer after the bitcoin sign, then BTC, then sats (`nextFace`).
 */
export const swapUnit: Step = drive => drive.call('onToggleUnit');

/** The balance in BTC, one tap on from `₿`, where it opens. */
export const inBtc: Step[] = [swapUnit];

/** The balance in sats, two taps on from `₿`. */
export const inSats: Step[] = [swapUnit, swapUnit];

/** What the app remembers of the wallet on `network`, as it was last open. */
export const remembered = (
  network: Network,
  over: Partial<Remembered> = {},
): Remembered => ({
  mode: 'host',
  network,
  walletId: 'fixture-wallet',
  locked: false,
  ...over,
});

export const open = {
  activity: (): StageAction => ({ type: 'open', scene: { name: 'activity' } }),
  settings: (): StageAction => ({ type: 'open', scene: { name: 'settings' } }),
  receive: (): StageAction => ({ type: 'open', scene: { name: 'receive' } }),
  send: (prefill = ''): StageAction => ({
    type: 'open',
    scene: { name: 'send', prefill },
  }),
  /** Send with a code the camera read from home, as the scan overlay opens it. */
  scanned: (prefill: string): StageAction => ({
    type: 'open',
    scene: { name: 'send', prefill, scanned: true },
  }),
  detail: (item: Activity): StageAction => ({
    type: 'open',
    scene: { name: 'detail', item, from: null },
  }),
};

/** A state of the open wallet. */
export interface OnWallet {
  /** The wallet as read; the fixture wallet on mainnet, just now, if unset. */
  snapshot?: WalletSnapshot;
  /** Later reads of the wallet, one a step, as polls bring them. */
  later?: WalletSnapshot[];
  session?: Partial<Session>;
  /** Calls the wallet answers its own way in this state. */
  client?: Partial<WalletAdapter>;
  open?: StageAction[];
  steps?: Step[];
  /** Settings > Auto-pay in this state; off if unset. */
  autoPay?: AutoPay;
}

export function wallet(
  name: string,
  make: () => OnWallet = () => ({}),
  hold?: number,
): Shot {
  return {
    name,
    hold,
    make: () => {
      const state = make();
      setAutoPay(state.autoPay);
      const snapshot = state.snapshot ?? onMainnet();
      const session = sessionOf(snapshot, {
        client: clientOf(state.client),
        ...state.session,
      });
      const phase: Phase = { kind: 'wallet', error: session.error };
      const frames = [snapshot, ...(state.later ?? [])].map(read => ({
        phase,
        session: { ...session, snapshot: read },
      }));
      return staged(frames, state.open, state.steps);
    },
  };
}
