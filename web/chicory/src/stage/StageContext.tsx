import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Dispatch, PropsWithChildren, RefObject } from 'react';
import type { Activity } from '@beignet/wallet-core';
import type { SafetyKind } from '../motion/speech';
import { swapScene } from '../../../platform/sceneSwap';
import { noteRefusedTap } from '../services/perf';
import { initialStage, scanTarget, stageReducer } from './scene';
import type {
  Point,
  Rect,
  ScanPurpose,
  ScanSource,
  StageAction,
  StageState,
} from './scene';

/**
 * How a gesture that let go hands its speed to the move it asks for:
 * `velocity` is the sheet's, in points a second, down being positive. The
 * seam's spring then carries on from the fling rather than from rest.
 */
export interface Fling {
  velocity?: number;
}

/**
 * Every way a control moves the canvas, named for what it asks. Each is a
 * stable function for the life of the stage, so a screen can take one as a
 * prop without re-rendering whenever the scene changes. The two a sheet
 * drag can end in, `openActivity` and `home`, take its `Fling`.
 */
export interface StageActions {
  navigate: (name: 'home' | 'activity' | 'send' | 'receive' | 'settings') => void;
  openSend: (prefill?: string) => void;
  openReceive: () => void;
  /**
   * Opens the scan overlay, its disc growing out of `origin`, the scan
   * button's centre in the window. A Settings field passes `scan`: what it
   * scans for, and where it is, for a code read to collapse into it.
   */
  openScan: (
    origin?: Point | null,
    scan?: { purpose?: ScanPurpose; into?: Point | null },
  ) => void;
  openDetail: (item: Activity, rect?: Rect) => void;
  openActivity: (fling?: Fling) => void;
  openSettings: () => void;
  openCreate: (restoring: boolean) => void;
  back: () => void;
  home: (fling?: Fling) => void;
  setBusy: (busy: boolean) => void;
}

/** Whether `to` takes the top slot straight from Send to Receive, or back. */
function swapsTopScene(from: StageState, to: StageState): boolean {
  const top = (state: StageState) =>
    state.scene.name === 'send' || state.scene.name === 'receive';
  return top(from) && top(to) && from.scene.key !== to.scene.key;
}

/**
 * Whether `to` widens the desktop's Activity column beside Overview, or takes
 * it back. A payment's detail changes its width too, but grows out of its row
 * as it does, which a captured column would cover.
 */
function resizesActivity(from: StageState, to: StageState): boolean {
  const names = [from.scene.name, to.scene.name];
  return names.includes('home') && names.includes('activity');
}

/**
 * What the canvas tells the stage about its panes, while it is drawn.
 */
export interface PaneMotion {
  /** A pane is still on its way, so a tap now would land on a moving target. */
  moving: () => boolean;
  /**
   * Starts the panes toward `next`, in the tick a tap asked for it, with the
   * speed of the gesture that asked, if one did.
   */
  follow: (next: StageState, fling?: Fling) => void;
  /**
   * Puts Settings' cover back to the pose the panes aim for, after a tap
   * started it on the UI thread (`moveCover`) and the stage then refused
   * the tap, or had already moved.
   */
  realign: () => void;
}

/** One registered answer, read at the moment it is asked for. */
export type Responder<T> = { current: T };

/**
 * Where a scanned code goes once the overlay reads it (`useScanReceiver`):
 * `receive` takes it, and `validate`, when given, is the check the scanner
 * holds a code to before it takes one, returning the value to receive or
 * throwing the reason it is refused. A Settings field gives one; a Send
 * leaves the scanner its own check of a payment request.
 */
export interface ScanReceiver {
  receive: (value: string, source: ScanSource) => void;
  validate?: (value: string) => string;
}

/**
 * What surfaces inside the stage answer before the stage itself does. Each
 * set is in the order its entries became active, so the newest, the
 * innermost surface on screen, is asked first.
 */
export interface Responders {
  /** Android back inside a scene: Send's review, a lifted QR, a search. */
  sceneBack: Set<Responder<() => boolean>>;
  /** Android back inside a shell phase: a panel or an editor it opened. */
  phaseBack: Set<Responder<() => boolean>>;
  /**
   * Where a code scanned for the Send already open, or for the Settings
   * field that asked, goes.
   */
  scan: Set<Responder<ScanReceiver>>;
}

/** A registry's answers, newest first. */
export function newestFirst<T>(registry: Set<Responder<T>>): T[] {
  return [...registry].reverse().map(entry => entry.current);
}

/** A G3 tint a scene holds for as long as its state lasts (REDESIGN.md 3.2). */
export type HeldTint = 'honey' | 'night';

/** A G3 tint that flashes once and goes. */
export type FlashTint = 'sage' | 'radish';

/**
 * What the scenes ask of the ground's G3 layer: the tint held now, and the
 * last flash, keyed so each plays once.
 */
export interface Tints {
  held: HeldTint | null;
  flash: { tint: FlashTint; key: number } | null;
}

/**
 * The tint channel. It is a store of its own rather than stage state, so a
 * scene that holds or flashes a tint draws only the ground again, not the
 * whole stage.
 */
export interface TintChannel {
  read: () => Tints;
  subscribe: (listener: () => void) => () => void;
  /** Holds `tint` until the returned release is called. */
  hold: (tint: HeldTint) => () => void;
  flash: (tint: FlashTint) => void;
}

function tintChannel(): TintChannel {
  let tints: Tints = { held: null, flash: null };
  const listeners = new Set<() => void>();
  const holders: HeldTint[] = [];
  const publish = (next: Tints) => {
    tints = next;
    for (const listener of listeners) listener();
  };
  // Honey is a safety state (REDESIGN.md rule 4), so it wins over night.
  const settle = () => {
    const held = holders.includes('honey')
      ? 'honey'
      : holders.includes('night')
      ? 'night'
      : null;
    if (held !== tints.held) publish({ ...tints, held });
  };
  return {
    read: () => tints,
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hold: tint => {
      holders.push(tint);
      settle();
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        holders.splice(holders.indexOf(tint), 1);
        settle();
      };
    },
    flash: tint =>
      publish({ ...tints, flash: { tint, key: (tints.flash?.key ?? 0) + 1 } }),
  };
}

/**
 * Which safety states have been felt and not ended since, for the wallet
 * they belong to (`useSafetySignal` in scenes/home/signals). The stage keeps
 * them rather than Home, which is drawn again after a relock or a spell
 * offline, so a state is felt once however often Home is drawn. Another
 * wallet's states start afresh, and the stage forgets them all as the
 * wallet closes.
 */
export interface FeltStates {
  has: (wallet: string, kind: SafetyKind) => boolean;
  /** When the state was felt, while it has not ended since. */
  since: (wallet: string, kind: SafetyKind) => number | undefined;
  set: (wallet: string, kind: SafetyKind, felt: boolean) => void;
  forget: () => void;
}

export function feltStates(): FeltStates {
  let owner = '';
  const kinds = new Map<SafetyKind, number>();
  return {
    has: (wallet, kind) => wallet === owner && kinds.has(kind),
    since: (wallet, kind) => (wallet === owner ? kinds.get(kind) : undefined),
    set: (wallet, kind, felt) => {
      if (wallet !== owner) {
        owner = wallet;
        kinds.clear();
      }
      if (!felt) kinds.delete(kind);
      else if (!kinds.has(kind)) kinds.set(kind, Date.now());
    },
    forget: () => {
      owner = '';
      kinds.clear();
    },
  };
}

export interface StageStore {
  state: StageState;
  dispatch: Dispatch<StageAction>;
  actions: StageActions;
  /**
   * The canvas's panes, or null when no canvas is drawn. With none, as under
   * a shell phase, nothing is moving and taps go straight through.
   */
  panes: RefObject<PaneMotion | null>;
  responders: Responders;
  tint: TintChannel;
  felt: FeltStates;
}

const StageContext = createContext<StageStore | null>(null);

/**
 * Owns the navigation state. It lives with the wallet session rather than
 * inside the provider, because the session speaks to it too: it moves the
 * user between tabs and closes whatever is open when the wallet changes.
 */
export function useStageStore(): StageStore {
  const [state, dispatch] = useReducer(stageReducer, undefined, initialStage);
  const panes = useRef<PaneMotion | null>(null);
  const [responders] = useState<Responders>(() => ({
    sceneBack: new Set(),
    phaseBack: new Set(),
    scan: new Set(),
  }));
  const [tint] = useState(tintChannel);
  const [felt] = useState(feltStates);
  // The state as of the last tap, ahead of React while a render is pending,
  // so two taps in one tick each start from where the one before led. A scan
  // started inside Send or Settings also reads it, to hand its code back to
  // the scene that asked.
  const latest = useRef(state);
  useLayoutEffect(() => {
    latest.current = state;
  }, [state]);
  const actions = useMemo<StageActions>(() => {
    // A tap is refused while a pane is still moving. Otherwise the panes start
    // toward where it leads in the same tick, rather than a frame later when
    // the canvas renders the new scene.
    const tap = (action: StageAction, fling?: Fling) => {
      const motion = panes.current;
      if (motion?.moving()) {
        noteRefusedTap();
        return;
      }
      const before = latest.current;
      latest.current = stageReducer(before, action);
      if (swapsTopScene(before, latest.current)) swapScene(() => dispatch(action));
      else if (resizesActivity(before, latest.current)) swapScene(() => dispatch(action), 'column');
      else dispatch(action);
      if (latest.current !== before) motion?.follow(latest.current, fling);
    };
    // A control's handler may be called with its press event; only a
    // gesture's own fling carries a speed.
    const speed = (fling?: Fling): Fling | undefined =>
      typeof fling?.velocity === 'number'
        ? { velocity: fling.velocity }
        : undefined;
    return {
      openSend: (prefill = '') =>
        tap({ type: 'open', scene: { name: 'send', prefill } }),
      openReceive: () => tap({ type: 'open', scene: { name: 'receive' } }),
      // What the scan is for and where its field is are set only when
      // given, so a scan from home or Send carries neither.
      openScan: (origin, scan) =>
        tap({
          type: 'overlay',
          overlay: {
            name: 'scan',
            target: scanTarget(latest.current.scene.name),
            origin: origin ?? null,
            ...(scan?.purpose ? { purpose: scan.purpose } : {}),
            ...(scan?.into ? { into: scan.into } : {}),
          },
        }),
      openDetail: (item, rect) =>
        tap({
          type: 'open',
          scene: { name: 'detail', item, from: rect ?? null },
        }),
      openActivity: fling =>
        tap({ type: 'open', scene: { name: 'activity' } }, speed(fling)),
      openSettings: () => tap({ type: 'open', scene: { name: 'settings' } }),
      openCreate: restoring =>
        tap({ type: 'overlay', overlay: { name: 'create', restoring } }),
      navigate: name => tap({ type: 'navigate', name }),
      back: () => tap({ type: 'back' }),
      home: fling => tap({ type: 'home' }, speed(fling)),
      // A screen's own state, not a tap: a payment that starts while a pane
      // settles must still hold the user in it. It is recorded ahead of the
      // render as a tap is, so a tap in the same tick as a payment going out
      // is refused before it starts the panes toward a back or a home the
      // reducer will not take.
      setBusy: busy => {
        const action: StageAction = { type: 'busy', busy };
        latest.current = stageReducer(latest.current, action);
        dispatch(action);
      },
    };
  }, []);
  return useMemo(
    () => ({ state, dispatch, actions, panes, responders, tint, felt }),
    [state, actions, responders, tint, felt],
  );
}

export function StageProvider({
  value,
  children,
}: PropsWithChildren<{ value: StageStore }>) {
  return (
    <StageContext.Provider value={value}>{children}</StageContext.Provider>
  );
}

/** The stage the calling component is drawn on. */
export function useStage(): StageStore {
  const stage = useContext(StageContext);
  if (!stage) throw new Error('useStage is only available inside a Stage.');
  return stage;
}

/**
 * Whether the scene keyed `key` is the scene the stage shows, whatever
 * overlay covers it. `usePaneActive()` turns false under the scan overlay;
 * this does not, so a surface that answers the overlay, as a Send takes the
 * code scanned over it, keeps answering while it is open.
 */
export function useIsCurrentScene(key: number): boolean {
  return useStage().state.scene.key === key;
}

/**
 * Keeps `value` in `registry` while `active`, always its latest version. An
 * entry that turns active again moves to the end, as the newest.
 */
export function useResponder<T>(
  registry: Set<Responder<T>>,
  value: T,
  active: boolean,
) {
  const entry = useRef(value);
  useLayoutEffect(() => {
    entry.current = value;
  });
  useLayoutEffect(() => {
    if (!active) return;
    registry.add(entry);
    return () => {
      registry.delete(entry);
    };
  }, [registry, active]);
}

/**
 * Answers Android back inside a scene while `active`, before the stage steps
 * back through its stack (REDESIGN.md 2.2). `handler` returns true when it
 * took the press, such as Send's review returning to compose, and false to
 * pass it on. The innermost wins: the one that became active last is asked
 * first. A surface that another covers, such as one under the scan overlay,
 * passes `active` false, which `usePaneActive()` tells it.
 */
export function useSceneBack(handler: () => boolean, active: boolean) {
  useResponder(useStage().responders.sceneBack, handler, active);
}

const NO_TINTS: Tints = { held: null, flash: null };
const noFlash = () => {};

/**
 * The G3 tints the scenes ask for, for the ground to draw. Outside a stage
 * there are none.
 */
export function useTint(): Tints {
  const channel = useContext(StageContext)?.tint;
  return useSyncExternalStore(
    channel?.subscribe ?? noSubscribe,
    channel?.read ?? noTints,
  );
}
const noSubscribe = () => () => {};
const noTints = () => NO_TINTS;

/**
 * Holds the G3 tint `tint` on the ground while it is set and the caller is
 * mounted: night while an offline receive is chosen, honey while a payment's
 * outcome is unknown. Outside a stage, as when a suite draws a screen alone,
 * it does nothing.
 */
export function useHoldTint(tint: HeldTint | null) {
  const channel = useContext(StageContext)?.tint;
  useEffect(() => {
    if (!channel || !tint) return;
    return channel.hold(tint);
  }, [channel, tint]);
}

/**
 * Flashes a G3 tint over the ground once: sage when money arrives, radish
 * when a payment fails. Outside a stage it does nothing.
 */
export function useFlashTint(): (tint: FlashTint) => void {
  return useContext(StageContext)?.tint.flash ?? noFlash;
}

/**
 * Answers Android back inside a shell phase, once the stage has nothing of
 * its own left to close: a panel or an editor the phase opened. `handler`
 * returns true when it took the press, and false to let the system have it.
 */
export function usePhaseBack(handler: () => boolean) {
  useResponder(useStage().responders.phaseBack, handler, true);
}
