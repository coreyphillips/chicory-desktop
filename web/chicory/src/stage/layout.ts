import { palette } from '../design/palette';
import { space, type as typography } from '../theme';
import type { Scene, StageState } from './scene';

/**
 * Where the canvas's panes rest for each scene (REDESIGN.md 2.3), as pure
 * data, so the layout is a table test and the canvas only animates between
 * answers it is given.
 *
 * The bottom sheet moves by one number, its top edge (the seam). The top pane
 * never moves; what it shows grows and fades with `hero` and `bar`.
 */

/** A place the seam rests, named for what it leaves showing. */
export type Stop = 'full' | 'compact' | 'home' | 'gone';

/** Every stop in points from the top of the canvas. */
export type Stops = Record<Stop, number>;

/** The status row across the top of the canvas, which no pane covers. */
export const STATUS_ROW = 56;

/** The hero's scale as the mini strip, the smallest it gets. */
export const HERO_MINI = 0.34;

/**
 * The band under the status row that Send and Receive leave clear, where the
 * balance rests as the mini strip while either is open (REDESIGN.md 7, T1).
 * Activity and a payment's detail leave no band, since the sheet's compact
 * stop sits just under the row, so there the strip rests in the row itself.
 */
export const MINI_STRIP = 44;

/**
 * How far a scene's content sits inside its slot (`SceneSlot`): for whatever
 * lands on it from outside, such as a scan closing into Send's well, and
 * whatever reaches past it to the slot's edges, such as a scrim.
 */
export const SLOT_PADDING = {
  top: space.md,
  side: space.xl,
  bottom: space.xxxl,
};

/** The height of Send's request well while it waits for a request. */
export const WELL = 72;

/**
 * Where the centre of Send's request well sits below the status row, which
 * a code read from home collapses into as Send opens around it (REDESIGN.md
 * 7, T3): under the mini strip the balance rests in, inside its slot's
 * padding, half the well down.
 */
export const WELL_DROP = MINI_STRIP + SLOT_PADDING.top + WELL / 2;

/**
 * How Home lays out its pane, under the status row and above the sheet's
 * home stop: the balance and its vessel centred in what the action row
 * leaves, and the row at the foot. The loading page draws its skeleton from
 * the same measures, so the canvas that replaces it builds in over it with
 * nothing moving (REDESIGN.md 7, R-3).
 */
export const HOME = {
  /** The page edge, each side of the balance and the row. */
  edge: space.xl,
  /** Between the balance and its vessel. */
  gap: space.md,
  /** Above and below the balance's figures. */
  heroPad: space.xs,
  /** The vessel's box, its pill at its widest short of a tap. */
  vessel: 8,
  /** How much further in than the page edge the vessel runs. */
  vesselInset: space.xxl,
  /** The action row: as tall as the Scan circle, the largest in it. */
  row: 76 as const,
  /** The Send and Receive circles. */
  circle: 56 as const,
  /** Under the action row, over the sheet. */
  rowBottom: space.lg,
};

/** The most the hero's figures grow with the text size (REDESIGN.md 3.3). */
export const HERO_MAX_SCALE = 1.2;

/**
 * The height of the balance's box at the full hero size, at `fontScale` on a
 * screen of `ratio` pixels a point: one line box of its figures, in whole
 * pixels rounded up as the odometer sets its cells, and the padding round
 * it. The hero only steps down from here, so the box never needs to be
 * smaller, and keeping it at least this tall keeps the vessel and the row
 * where they are whatever the balance's size.
 */
export function heroBox(fontScale: number, ratio: number): number {
  const scale = Math.min(fontScale, HERO_MAX_SCALE);
  const line = typography.hero.lineHeight ?? 0;
  return Math.ceil(line * scale * ratio - 1e-6) / ratio + 2 * HOME.heroPad;
}

/**
 * The primary control Send and Receive draw at the foot of their slot, 88pt
 * across, which the action circle that opens either grows into (REDESIGN.md
 * 7, T1).
 */
export const PRIMARY_CONTROL = 88;

/**
 * How the primary control a launch lands on looks as its scene opens, which
 * the tapped circle takes on as it travels, so it lands looking like what
 * it becomes (REDESIGN.md 7, T1): its fill, its ring and the ring's width,
 * its glyph's colour and size, in points on the 88pt control, and how far
 * the control is scaled.
 */
export interface ControlLook {
  fill: string;
  ring: string;
  ringWidth: number;
  ink: string;
  glyph: number;
  scale: number;
}

/**
 * The look of the control `scene` lands the circle on, as its scene draws
 * it (Send's `CircleControl` in scenes/send/Controls and Receive's
 * `GlyphButton` in scenes/receive/controls), with slate for bloom on a
 * `test` network. `live` is whether it takes a tap as the scene opens:
 * Send's review once a request is in the well, Receive's Continue when an
 * empty amount can be asked for. Held back, each is a mocha disc in a 4pt
 * husk ring with a dust glyph, at full size.
 */
export function launchLook(
  scene: 'send' | 'receive',
  { live, test }: { live: boolean; test: boolean },
): ControlLook {
  const bloom = test ? palette.slate : palette.bloom;
  if (scene === 'send') {
    return live
      ? {
          fill: test ? palette.slateSoft : palette.bloomSoft,
          ring: bloom,
          ringWidth: 4,
          ink: palette.cream,
          glyph: 32,
          scale: 1,
        }
      : {
          fill: palette.mocha,
          ring: palette.husk,
          ringWidth: 4,
          ink: palette.dust,
          glyph: 32,
          scale: 1,
        };
  }
  const glyph = Math.round(PRIMARY_CONTROL * 0.42);
  return live
    ? {
        fill: bloom,
        ring: bloom,
        ringWidth: 0,
        ink: palette.ink,
        glyph,
        scale: 1,
      }
    : {
        fill: palette.mocha,
        ring: palette.husk,
        ringWidth: 4,
        ink: palette.dust,
        glyph,
        scale: 1,
      };
}

/**
 * Where the centre of that control sits, in window points, on a canvas
 * `width` by `height` with `insets`: at the bottom centre of the slot, over
 * the slot's bottom padding and the bottom inset. The tapped circle travels
 * here unless the scene has measured its own control (`useLaunchLanding` in
 * stage/panes/Launch).
 */
export function launchLanding(
  width: number,
  height: number,
  insets: { bottom: number; left: number; right: number },
): { x: number; y: number } {
  return {
    x: insets.left + (width - insets.left - insets.right) / 2,
    y: height - insets.bottom - SLOT_PADDING.bottom - PRIMARY_CONTROL / 2,
  };
}

/** What Settings does to the canvas it slides over. */
export const COVERED = { scale: 0.94, opacity: 0.5 };

/** What the scan overlay does to the canvas it opens over. */
export const SCANNING = { scale: 0.96, opacity: 0.5 };

/**
 * The opacity of what the Reduce Motion crossfade covers (the panes'
 * `veil`), from its clock: whole at rest (1), gone halfway, whole again at
 * the end, so the jump at the middle is never seen.
 */
export function veilOpacity(veil: number): number {
  'worklet';
  return Math.min(1, Math.abs(1 - 2 * veil));
}

/**
 * About how long the pane spring takes to look settled, which is well before
 * its rest threshold reports rest. The transition lock lasts this long, so
 * taps wait this long at most, and only while a pane is actually moving.
 */
export const PANE_SETTLE_MS = 340;

/**
 * How the canvas came to be drawn: the lock opening over it (R-1), a wallet
 * that finished loading (R-3), or one that was offline and answered again
 * (R-5). Each is a build: the canvas does not appear at rest, it builds in.
 */
export type Arrival = 'unlock' | 'load' | 'reconnect';

/**
 * When each part of the canvas builds in, in ms from the canvas mounting
 * (REDESIGN.md 7, R-1): the hero counts up from 0, then 50ms later the
 * sheet rises, 50ms after that the actions pop in 50ms apart, and then the
 * rows stagger in 30ms apart. After an unlock the bud unfolds first, so the
 * build waits for it; after a load or a reconnect it starts as the phase
 * leaves.
 */
export const BUILD = {
  lead: { unlock: 600, load: 80, reconnect: 80 } as Record<Arrival, number>,
  sheet: 50,
  actions: 100,
  actionStep: 50,
  rows: 150,
  rowStep: 30,
  /** How long after the rows begin the build counts as over. */
  settle: 400,
};

export interface BuildBeats {
  hero: number;
  sheet: number;
  actions: number;
  actionStep: number;
  rows: number;
  rowStep: number;
  /** When the whole build has landed. */
  done: number;
}

/** The beats of the build for an `arrival`. */
export function buildBeats(arrival: Arrival): BuildBeats {
  const hero = BUILD.lead[arrival];
  return {
    hero,
    sheet: hero + BUILD.sheet,
    actions: hero + BUILD.actions,
    actionStep: BUILD.actionStep,
    rows: hero + BUILD.rows,
    rowStep: BUILD.rowStep,
    done: hero + BUILD.rows + BUILD.settle,
  };
}

/**
 * The stops for a canvas `height` points tall whose top edge sits `top`
 * points below the system status bar's.
 *
 * Home leaves the balance at least 380 points and never less than half the
 * canvas. Compact leaves the status row and a little air. Gone is past the
 * bottom edge, far enough that the sheet's rounded corners are gone too.
 */
export function stops(height: number, insets: { top: number }): Stops {
  return {
    full: insets.top,
    compact: insets.top + 72,
    home: Math.max(insets.top + 380, 0.5 * height),
    gone: height + 24,
  };
}

/**
 * One pose of the panes: where the seam rests, how far the hero is expanded
 * (1 is the full balance, 0 the mini strip), and the action row's opacity.
 */
export interface PaneLayout {
  seam: Stop;
  hero: number;
  bar: number;
}

/** The scenes the canvas itself draws, as opposed to sliding over it. */
export type CanvasSceneName = Exclude<Scene['name'], 'settings'>;

/**
 * Each scene's pose. Settings has none: it slides over the canvas and leaves
 * the canvas exactly as the scene under it had it.
 */
export const SCENE_LAYOUT: Record<CanvasSceneName, PaneLayout> & {
  settings: null;
} = {
  home: { seam: 'home', hero: 1, bar: 1 },
  activity: { seam: 'compact', hero: 0, bar: 0 },
  detail: { seam: 'compact', hero: 0, bar: 0 },
  send: { seam: 'gone', hero: 0, bar: 0 },
  receive: { seam: 'gone', hero: 0, bar: 0 },
  settings: null,
};

/**
 * The scene the canvas shows: the stage's own scene, or under Settings the
 * one it covers. The stack under Settings always rests on home, so home is
 * also the answer when there is nothing else to go on.
 */
export function canvasScene(
  state: Pick<StageState, 'scene' | 'stack'>,
): CanvasSceneName {
  for (const scene of [state.scene, ...[...state.stack].reverse()]) {
    if (scene.name !== 'settings') return scene.name;
  }
  return 'home';
}

/**
 * The panes' pose for a stage, plus whether Settings covers the canvas,
 * whether the scan overlay is open over it, and whether a payment's detail
 * card is open on the sheet. The card leaves the panes where the list had
 * them, but its growth out of the row is a move all the same, so it holds
 * the transition lock like any other.
 */
export interface CanvasLayout extends PaneLayout {
  covered: boolean;
  scanning: boolean;
  card: boolean;
}

export function canvasLayout(
  state: Pick<StageState, 'scene' | 'stack'> &
    Partial<Pick<StageState, 'overlay'>>,
): CanvasLayout {
  const shown = canvasScene(state);
  return {
    ...SCENE_LAYOUT[shown],
    covered: state.scene.name === 'settings',
    scanning: state.overlay?.name === 'scan',
    card: shown === 'detail',
  };
}

export const sameLayout = (a: CanvasLayout, b: CanvasLayout) =>
  a.seam === b.seam &&
  a.hero === b.hero &&
  a.bar === b.bar &&
  a.covered === b.covered &&
  a.scanning === b.scanning &&
  a.card === b.card;
