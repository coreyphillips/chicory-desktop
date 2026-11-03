import type { Network } from '@beignet/wallet-core';
import type { useAppLock } from '../services/useAppLock';
import type { useWalletSession } from '../services/useWalletSession';

type Lock = ReturnType<typeof useAppLock>;
type Session = ReturnType<typeof useWalletSession>;

/**
 * Which shell the app is in. Each phase carries only what its own view reads,
 * so the views can change shape without the precedence changing with them.
 */
export type Phase =
  | { kind: 'locked'; prompting: boolean; error: string }
  | {
      kind: 'transit';
      why: 'erasing' | 'closing' | 'switching';
      target: Network | null;
    }
  | { kind: 'opening' }
  | { kind: 'saved'; error: string }
  | { kind: 'welcome'; opening: boolean; device: boolean; error: string }
  | { kind: 'picker'; error: string }
  | { kind: 'loading' }
  | { kind: 'offline'; error: string }
  | { kind: 'wallet'; error: string };

/** The lock and session reduced to plain values, so the ladder can be table-tested. */
export interface PhaseInput {
  locked: boolean;
  prompting: boolean;
  lockError: string;
  switching: boolean;
  closing: boolean;
  erasing: boolean;
  switchTarget: Network | null;
  initializing: boolean;
  connecting: boolean;
  hasClient: boolean;
  /**
   * A device wallet actually exists here, so this launch is a return rather
   * than a first run. It is false for a vault that was prepared but never got
   * a wallet, which must keep offering setup rather than claiming there is
   * something saved to open.
   */
  deviceHint: boolean;
  deviceVisible: boolean;
  walletId: string;
  hasSnapshot: boolean;
  error: string;
  switchError: string;
}

/**
 * The first phase whose condition holds wins, so the order is the contract: a
 * lock hides everything, and a close or switch in progress is never mistaken
 * for a wallet that failed to open.
 */
export function derivePhase(input: PhaseInput): Phase {
  if (input.locked) {
    return {
      kind: 'locked',
      prompting: input.prompting,
      error: input.lockError,
    };
  }
  if (input.switching || input.closing) {
    return {
      kind: 'transit',
      why: input.erasing ? 'erasing' : input.closing ? 'closing' : 'switching',
      target: input.switchTarget,
    };
  }
  if (input.initializing) return { kind: 'opening' };
  // A wallet already lives on this device. Whatever went wrong, first-run
  // setup is the wrong screen: it offers to put a wallet somewhere, which is
  // not the question. Show the wallet that is here and how to get back into it.
  if (!input.hasClient && input.deviceHint && !input.deviceVisible) {
    return { kind: 'saved', error: input.switchError || input.error };
  }
  if (!input.hasClient) {
    return {
      kind: 'welcome',
      // Initializing took the branch above, so a connect in flight is the only
      // wait left.
      opening: input.connecting,
      device: input.deviceVisible,
      error: input.error,
    };
  }
  if (!input.walletId) {
    return { kind: 'picker', error: input.switchError || input.error };
  }
  // The engine is starting and nothing has gone wrong. This is a wallet page
  // that has not filled in yet, not a connection problem.
  if (!input.hasSnapshot && !input.error) return { kind: 'loading' };
  if (!input.hasSnapshot) {
    return { kind: 'offline', error: input.switchError || input.error };
  }
  return { kind: 'wallet', error: input.error };
}

/**
 * Whether a wallet is open in the phase `kind`: shown, loading, offline,
 * or behind the lock. Anywhere else, the picker, a switch or a close
 * included, none is, and what the stage kept of the last one's safety
 * states is forgotten (`StageStore.felt`), so the wallet opened next feels
 * its own as it opens.
 */
export function walletOpen(kind: Phase['kind']): boolean {
  return (
    kind === 'wallet' ||
    kind === 'loading' ||
    kind === 'offline' ||
    kind === 'locked'
  );
}

export function phaseInput(
  lock: Pick<Lock, 'locked' | 'prompting' | 'error'>,
  session: Pick<
    Session,
    | 'switching'
    | 'closing'
    | 'erasing'
    | 'switchTarget'
    | 'initializing'
    | 'connecting'
    | 'client'
    | 'deviceHint'
    | 'deviceVisible'
    | 'walletId'
    | 'snapshot'
    | 'error'
    | 'switchError'
  >,
): PhaseInput {
  return {
    locked: lock.locked,
    prompting: lock.prompting,
    lockError: lock.error,
    switching: session.switching,
    closing: session.closing,
    erasing: session.erasing,
    switchTarget: session.switchTarget,
    initializing: session.initializing,
    connecting: session.connecting,
    hasClient: !!session.client,
    deviceHint: session.deviceHint,
    deviceVisible: session.deviceVisible,
    walletId: session.walletId,
    hasSnapshot: !!session.snapshot,
    error: session.error,
    switchError: session.switchError,
  };
}

/**
 * The recovery phrase still has to be saved. It sits beside the phase rather
 * than in it, because it overlays whatever is showing instead of replacing it,
 * and it drops away while the wallet is closing or switching.
 */
export function backupPending(
  session: Pick<
    Session,
    'client' | 'rememberedSession' | 'closing' | 'switching'
  >,
): boolean {
  return (
    !!session.client &&
    !!session.rememberedSession?.backupPending &&
    !session.closing &&
    !session.switching
  );
}
