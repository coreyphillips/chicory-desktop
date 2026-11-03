import { announce } from '../design/announce';
import { focusPending, lastFocusMove } from './focus';
import { afterTransition } from './idle';

/*
 * Safety messages, spoken so they are heard whole (REDESIGN.md rule 4 and
 * 9).
 *
 * A safety state is announced assertively, which interrupts whatever a
 * screen reader is saying. As a scene arrives, the canvas then moves focus
 * to its primary element, and the screen reader reads that aloud, which
 * would cut the message short. Several states that begin together, such as
 * a stale balance, a backup to save and a test network as a wallet opens,
 * would also cut each other off. So each waits here until the transition
 * has settled and focus has landed, and those waiting together are said as
 * one message, in order of how much they matter.
 */

/**
 * How long a screen reader is given to land where focus moved before a
 * safety message is said over it.
 */
export const FOCUS_SETTLE_MS = 400;

/**
 * Which safety state is heard first when several begin together: a payment
 * whose outcome is unknown or held, then a balance too old to spend
 * against, a request or quote that expired, an address used before, a
 * backup still to save, and a test network.
 */
export const SAFETY_ORDER = {
  held: 0,
  stale: 1,
  expired: 2,
  reused: 3,
  backup: 4,
  testNetwork: 5,
} as const;

export type SafetyKind = keyof typeof SAFETY_ORDER;

/**
 * The code each safety state is logged under (REDESIGN.md rule 4), which
 * Settings > Diagnostics colours it by. A held payment is HELD, or
 * UNCERTAIN where Send knows its outcome is unknown, and an expired quote
 * keeps the engine's QUOTE_EXPIRED; a request that expired is EXPIRED.
 */
export const SAFETY_CODE: Record<SafetyKind, string> = {
  held: 'HELD',
  stale: 'STALE',
  expired: 'EXPIRED',
  reused: 'AMBIGUOUS_RECEIVE_ADDRESS',
  backup: 'BACKUP_PENDING',
  testNetwork: 'TEST_NETWORK',
};

const waiting = new Map<string, number>();
/** The kinds each waiting message speaks for. */
const kindsOf = new Map<string, Set<SafetyKind>>();
/** When a message of each kind was last said. */
const heardAt = new Map<SafetyKind, number>();
let queued: (() => void) | null = null;

/**
 * Says `message` assertively once the screen has settled, with any others
 * waiting, in order of `kind`. Returns a withdrawal, for a state that ends
 * before it is heard, or a surface that goes away first.
 */
export function announceSafety(message: string, kind: SafetyKind): () => void {
  if (!message) return () => {};
  const rank = SAFETY_ORDER[kind];
  waiting.set(message, Math.min(rank, waiting.get(message) ?? rank));
  kindsOf.set(message, (kindsOf.get(message) ?? new Set()).add(kind));
  queued ??= whenSettled(speak);
  return () => {
    waiting.delete(message);
    kindsOf.delete(message);
    if (waiting.size === 0) {
      queued?.();
      queued = null;
    }
  };
}

/**
 * Drops every safety message still waiting, unsaid. For tests only: the
 * waiting list outlives a test, and a test that ends before its messages
 * are heard, or throws away the fake clock they wait on, would otherwise
 * leave them to be said in the next.
 */
export function forgetSafety() {
  queued?.();
  queued = null;
  waiting.clear();
  kindsOf.clear();
  heardAt.clear();
}

/**
 * Whether a message of `kind` has been said at `since` or after. A state
 * felt on one surface whose words were withdrawn with it, as it went before
 * they were heard, is still owed them by the next surface that shows it.
 */
export function heardSince(kind: SafetyKind, since: number): boolean {
  return (heardAt.get(kind) ?? -Infinity) >= since;
}

function speak() {
  queued = null;
  const said = [...waiting]
    .sort(([, a], [, b]) => a - b)
    .map(([message]) => message);
  const now = Date.now();
  for (const message of said) {
    kindsOf.get(message)?.forEach(kind => heardAt.set(kind, now));
  }
  waiting.clear();
  kindsOf.clear();
  if (said.length > 0) announce(said.join(' '), { assertive: true });
}

/**
 * How long a safety message waits before looking again at a focus move
 * still on its way.
 */
const FOCUS_RETRY_MS = 50;

/**
 * Runs `fn` once no transition is running, no focus move is waiting, and
 * the last move has had FOCUS_SETTLE_MS to land. Returns a cancel.
 *
 * A move still on its way is waited for on a timer, never by asking for the
 * next idle moment at once. React Native runs idle callbacks back to back,
 * so asking again from inside one keeps the JavaScript thread from its
 * timers, and a move that waits on one (`focusAfterTransition` with a
 * delay) would never be made: nothing on a timer would fire until the next
 * touch.
 */
function whenSettled(fn: () => void): () => void {
  let stop = () => {};
  const attempt = () => {
    stop = afterTransition(() => {
      if (focusPending()) {
        const timer = setTimeout(attempt, FOCUS_RETRY_MS);
        stop = () => clearTimeout(timer);
        return;
      }
      const wait = lastFocusMove() + FOCUS_SETTLE_MS - Date.now();
      if (wait > 0) {
        const timer = setTimeout(attempt, wait);
        stop = () => clearTimeout(timer);
        return;
      }
      fn();
    });
  };
  attempt();
  return () => stop();
}
