import type { Activity } from '@beignet/wallet-core';
import type { Tab } from '../services/useWalletSession';

export type Rect = { x: number; y: number; width: number; height: number };

/** A point in the window, in points. */
export type Point = { x: number; y: number };

/**
 * What a scan is for, which the scanner's words and its check of a code
 * follow: a payment request, a primary node's address, or the Bitcoin
 * address Settings empties the wallet to.
 */
export type ScanPurpose = 'payment' | 'primary' | 'address';

/**
 * Where a scanned code goes: a new Send from home, the Send already open,
 * or the Settings field that asked for it.
 */
export type ScanTarget = 'home' | 'send' | 'settings';

/**
 * What the canvas is showing. Every open hands out a new key, so a scene
 * opened again is a fresh instance that remembers nothing of the last one. A
 * send's prefill lives on its scene for the same reason: leaving the scene is
 * what discards it, and a request that was paid or abandoned never greets the
 * next Send.
 */
export type Scene =
  | { name: 'home'; key: number }
  | { name: 'activity'; key: number }
  | { name: 'detail'; item: Activity; from: Rect | null; key: number }
  | {
      name: 'send';
      prefill: string;
      /**
       * The camera read `prefill`, rather than a link bringing it: the one
       * way a request may pay itself, when Settings > Auto-pay allows it.
       */
      scanned?: true;
      key: number;
    }
  | { name: 'receive'; key: number }
  | { name: 'settings'; key: number };

/** What covers the scene without replacing it. */
export type Overlay =
  | {
      name: 'scan';
      /**
       * Where a scanned code goes: a new Send, the Send already open, or the
       * Settings field that asked for it.
       */
      target: ScanTarget;
      /** The scan button the disc grows out of, in the window. */
      origin: Point | null;
      /**
       * What the scan is for, set only by a scan that names one. The
       * receiver a Settings field arms registers in the commit that opens
       * the overlay, after the overlay has drawn its scanner, so what the
       * scanner says has to come with the overlay itself.
       */
      purpose?: ScanPurpose;
      /**
       * The field a code read fills, in the window, which the disc collapses
       * into (REDESIGN.md 7, T3). Set only when one is given.
       */
      into?: Point | null;
      key: number;
    }
  | { name: 'create'; restoring: boolean; key: number }
  | null;

export type StageState = {
  scene: Scene;
  /**
   * What back returns to, oldest first. Its first entry, or the scene itself
   * when it is empty, is always home.
   */
  stack: Scene[];
  overlay: Overlay;
  /** A payment or a new wallet is in flight, so nothing may leave it. */
  busy: boolean;
  /** The innermost surface's own step, which answers back before the stack. */
  step: string | null;
  /** The last key handed out. */
  key: number;
};

type Unkeyed<T> = T extends unknown ? Omit<T, 'key'> : never;

export type StageAction =
  | { type: 'open'; scene: Unkeyed<Scene> }
  | { type: 'navigate'; name: 'home' | 'activity' | 'send' | 'receive' | 'settings' }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'reset' }
  | { type: 'tab'; tab: Tab }
  | { type: 'link'; request: string }
  | { type: 'overlay'; overlay: Unkeyed<NonNullable<Overlay>> }
  | { type: 'scanned'; value: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'step'; step: string | null };

type SceneName = Scene['name'];

/**
 * Home reaches everything. Activity reaches a payment's detail, and Settings
 * for a recovery phrase still to save, which the open list pins first; back
 * from either returns to the list. Send and Receive reach the Activity that
 * shows what they just did. Home is always a way out.
 */
const OPENS: Record<SceneName, readonly SceneName[]> = {
  home: ['activity', 'detail', 'send', 'receive', 'settings'],
  activity: ['home', 'detail', 'settings'],
  detail: ['home'],
  send: ['home', 'activity'],
  receive: ['home', 'activity'],
  settings: ['home'],
};

const TAB_SCENES: Record<Tab, 'home' | 'activity' | 'settings'> = {
  Wallet: 'home',
  Activity: 'activity',
  Settings: 'settings',
};

export function initialStage(): StageState {
  return {
    scene: { name: 'home', key: 0 },
    stack: [],
    overlay: null,
    busy: false,
    step: null,
    key: 0,
  };
}

export function canOpen(state: StageState, name: SceneName): boolean {
  return !state.busy && OPENS[state.scene.name].includes(name);
}

/**
 * Where a scan opened over `scene` sends its code: into the Send already
 * open, into the Settings field that asked for it, and from anywhere else to
 * a new Send.
 */
export const scanTarget = (scene: Scene['name']): ScanTarget =>
  scene === 'send' ? 'send' : scene === 'settings' ? 'settings' : 'home';

/** The session still speaks in tabs, so a network switch can put the user back. */
export function tabOf(state: StageState): Tab {
  if (state.scene.name === 'settings') return 'Settings';
  if (state.scene.name === 'activity') return 'Activity';
  return 'Wallet';
}

/**
 * The home every stack rests on. Each way back to it returns this same
 * instance, so Home is not rebuilt whenever a scene closes.
 */
function base(state: StageState): Scene {
  return state.stack.length ? state.stack[0] : state.scene;
}

const atBase = (state: StageState) =>
  !state.stack.length && !state.overlay && state.scene.name === 'home';

/**
 * A step belongs to the innermost surface, the overlay when there is one and
 * the scene otherwise, so it is dropped as soon as that surface stops being
 * the one showing.
 */
function settle(
  state: StageState,
  change: Partial<Pick<StageState, 'scene' | 'stack' | 'overlay' | 'key'>>,
): StageState {
  const next = { ...state, ...change };
  const innermost = (value: StageState) => value.overlay ?? value.scene;
  return innermost(next) === innermost(state) ? next : { ...next, step: null };
}

/**
 * A fresh Send over home, for a request that came from outside the canvas:
 * a link, or a code the camera read from home (`scanned`).
 */
function sendOver(
  state: StageState,
  prefill: string,
  scanned = false,
): StageState {
  const key = state.key + 1;
  return settle(state, {
    scene: scanned
      ? { name: 'send', prefill, scanned: true, key }
      : { name: 'send', prefill, key },
    stack: [base(state)],
    overlay: null,
    key,
  });
}

/** What back returns to from a scene opened over the current one. */
function stackUnder(state: StageState, name: SceneName): Scene[] {
  if (name === 'home') return [];
  // A payment that hands over to Activity is finished with, so back from
  // there goes home rather than to the spent form.
  if (state.scene.name === 'send' || state.scene.name === 'receive') {
    return [base(state)];
  }
  return [...state.stack, state.scene];
}

function openScene(state: StageState, request: Unkeyed<Scene>): StageState {
  if (request.name === 'detail' && state.scene.name === 'detail' && !state.busy && !state.overlay) {
    if (request.item.id === state.scene.item.id) return state;
    const key = state.key + 1;
    return settle(state, { scene: { ...request, key }, key });
  }
  if (!canOpen(state, request.name)) return state;
  const key = state.key + 1;
  return settle(state, {
    scene: { ...request, key },
    stack: stackUnder(state, request.name),
    // Whatever was asked for is what shows, never something left on top.
    overlay: null,
    key,
  });
}

function switchTab(state: StageState, next: Tab): StageState {
  const name = TAB_SCENES[next];
  // The session moves tabs while a wallet is being created, and that sheet
  // must survive it. A scan has nowhere to deliver once its scene is gone,
  // and closes even over a Settings the tab keeps: the session moved the
  // wallet under it, and the field that asked lands focus as it closes.
  const overlay = state.overlay?.name === 'create' ? state.overlay : null;
  if (name === 'home') {
    return settle(state, { scene: base(state), stack: [], overlay });
  }
  if (state.scene.name === name) {
    return settle(state, { stack: [base(state)], overlay });
  }
  const key = state.key + 1;
  return settle(state, {
    scene: { name, key },
    stack: [base(state)],
    overlay,
    key,
  });
}

/**
 * The navigation of the wallet canvas. It is pure, so every rule is a table
 * test, and it refuses by returning the state it was given, which is how a
 * caller tells that back had nothing left to close.
 *
 * `busy` holds the user inside a payment or a wallet being created: nothing
 * opens or closes until it clears. `reset` and `tab` come from the session,
 * which moves the wallet itself (a close, a switch, a wallet created) and so
 * outranks any scene: they always apply.
 */
export function stageReducer(
  state: StageState,
  action: StageAction,
): StageState {
  switch (action.type) {
    case 'navigate': {
      if (state.busy || state.overlay || state.scene.name === action.name) return state;
      const home = settle(state, { scene: base(state), stack: [], overlay: null });
      if (action.name === 'home') return home;
      return openScene(home, action.name === 'send'
        ? { name: 'send', prefill: '' }
        : { name: action.name });
    }
    case 'open':
      return openScene(state, action.scene);
    case 'back':
      if (state.busy) return state;
      if (state.overlay) return settle(state, { overlay: null });
      if (!state.stack.length) return state;
      return settle(state, {
        scene: state.stack[state.stack.length - 1],
        stack: state.stack.slice(0, -1),
      });
    case 'home':
      if (state.busy || atBase(state)) return state;
      return settle(state, { scene: base(state), stack: [], overlay: null });
    case 'reset':
      return {
        ...settle(state, { scene: base(state), stack: [], overlay: null }),
        busy: false,
        step: null,
      };
    case 'tab':
      return switchTab(state, action.tab);
    case 'link':
      // A link that lands mid-payment is dropped rather than queued, so it
      // can never take the place of the payment on screen.
      return state.busy ? state : sendOver(state, action.request);
    case 'overlay':
      if (state.busy || state.overlay) return state;
      return settle(state, {
        overlay: { ...action.overlay, key: state.key + 1 },
        key: state.key + 1,
      });
    case 'scanned':
      if (state.overlay?.name !== 'scan') return state;
      // A Send that is already open, or the Settings field that asked, takes
      // the code through its own receiver, and the overlay closes over it.
      if (state.overlay.target !== 'home') {
        return settle(state, { overlay: null });
      }
      return sendOver(state, action.value, true);
    case 'busy':
      return state.busy === action.busy
        ? state
        : { ...state, busy: action.busy };
    case 'step':
      return state.step === action.step
        ? state
        : { ...state, step: action.step };
  }
}
