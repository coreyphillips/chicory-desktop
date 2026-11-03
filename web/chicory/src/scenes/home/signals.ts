import { useEffect, useRef, useState } from 'react';
import { SAFETY_CODE, announceSafety, heardSince } from '../../motion/speech';
import type { SafetyKind } from '../../motion/speech';
import { recordDiagnostic } from '../../services/diagnosticLog';
import { useStage } from '../../stage/StageContext';

/**
 * Where one safety state's signal stands after a step: whether the state
 * has been felt and not ended since (`felt`), so it owes nothing more, and
 * whether this step plays it (`play`).
 */
export interface SignalStep {
  felt: boolean;
  play: boolean;
}

/**
 * The next step of a safety state's signal (REDESIGN.md rule 4), from
 * whether it was `felt`, whether the state holds (`on`), and whether it is
 * in front of the person (`front`): the app active, and no scene over Home
 * that warns about it itself.
 *
 * A state is felt once as it begins, and not again while it lasts, however
 * often Home is drawn again or the app comes back. One that begins while it
 * is not in front, as a balance that goes old while the app is away, or as
 * it leaves, waits, and is felt once it is in front and still holds. Only a
 * state that ends can begin, and be felt, again.
 */
export function signalStep(
  felt: boolean,
  on: boolean,
  front: boolean,
): SignalStep {
  if (!on) return { felt: false, play: false };
  if (felt || !front) return { felt, play: false };
  return { felt: true, play: true };
}

/** Where Home is when a state's signal steps. */
export interface SignalPlace {
  /** The wallet the state belongs to. */
  wallet: string;
  /** Whether it is in front of the person (`signalStep`). */
  front: boolean;
}

/**
 * A safety state (REDESIGN.md rule 4): felt with `feel` and written to the
 * diagnostic log at once as it begins, under its kind's code, and spoken
 * assertively once the screen has settled, together with any other state
 * that began with it, in order of `kind` (`motion/speech`). It plays once
 * each time the state starts, including when the wallet opens in it, and a
 * state that ends before it is heard is not said. What keeps it on screen
 * until it clears, and what it blocks, belong to the surfaces that draw it.
 *
 * Whether a state has been felt is kept with the stage (`StageStore.felt`),
 * not with Home, which is drawn again after a relock or a spell offline: a
 * Home drawn again over a state already felt feels nothing (`signalStep`).
 * A state that begins while Home is not in front waits for it (`where`).
 * Felt is not heard, though: a state felt on a surface that went, or by a
 * Home torn down, before its words were said is said once more when Home
 * is in front, without being felt or logged again.
 */
export function useSafetySignal(
  on: boolean,
  message: string,
  feel: () => void,
  kind: SafetyKind,
  where: SignalPlace,
) {
  const { felt } = useStage();
  const { wallet, front } = where;
  // The message waiting to be said, withdrawn if the state ends first or
  // Home goes away, but not when Home leaves the front for a moment.
  const withdraw = useRef<(() => void) | null>(null);
  useEffect(() => {
    const step = signalStep(felt.has(wallet, kind), on, front);
    felt.set(wallet, kind, step.felt);
    if (!on) {
      withdraw.current?.();
      withdraw.current = null;
    }
    if (!step.play) {
      const since = felt.since(wallet, kind);
      if (
        on &&
        front &&
        !withdraw.current &&
        since !== undefined &&
        !heardSince(kind, since)
      ) {
        withdraw.current = announceSafety(message, kind);
      }
      return;
    }
    feel();
    recordDiagnostic({ phase: 'ui', message, code: SAFETY_CODE[kind] });
    withdraw.current?.();
    withdraw.current = announceSafety(message, kind);
  }, [felt, wallet, on, front, message, feel, kind]);
  useEffect(
    () => () => {
      withdraw.current?.();
      withdraw.current = null;
    },
    [],
  );
}

/**
 * How long a cached launch waits for its first live read before the old
 * balance it shows is warned about: longer than a poll's interval, so a
 * start that is going well is never warned about.
 */
export const LIVE_OVERDUE_MS = 15_000;

/**
 * Whether the wallet is still opening on the figures it last saw: the
 * balance is old, the wallet is connecting, and its first live read is not
 * yet overdue (LIVE_OVERDUE_MS). The canvas asks once, for all its regions.
 */
export function useOpening(stale: boolean, connecting: boolean): boolean {
  const overdue = useOverdue(stale && connecting, LIVE_OVERDUE_MS);
  return stale && connecting && !overdue;
}

/**
 * Whether `on` has held for `ms` without a break. It turns false the
 * moment `on` does.
 */
export function useOverdue(on: boolean, ms: number): boolean {
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    setOverdue(false);
    if (!on) return;
    const timer = setTimeout(() => setOverdue(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on && overdue;
}
