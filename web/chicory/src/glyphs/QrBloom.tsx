import QRCode from 'qrcode';
import React, { memo, useEffect, useState } from 'react';
import type { Ref } from 'react';
import { PixelRatio, Pressable, StyleSheet, View } from 'react-native';
import type { HostInstance } from 'react-native';
import Reanimated, {
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { copy } from '../design/copy';
import { Glyph } from '../design/glyphs';
import { haptics } from '../design/haptics';
import { palette } from '../design/palette';
import { riseIn } from '../motion/presets';
import { curves, durations, springs } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';
import { usePaneActive } from '../stage/panes/Pane';
import { radius } from '../theme';

/**
 * A payment request's QR, always ink on cream (REDESIGN.md 5, QrBloom).
 *
 * The modules are split into five bands by their distance from the centre,
 * plus the three finder squares, and each is a static drawing on a layer of
 * its own, so only transforms and opacity ever move. A code blooms in: the
 * card settles from .92, the bands arrive from the centre outward 40ms apart
 * and the finders pop last. It leaves the way its state says: an expired
 * request dissolves from the outside in, a paid one implodes from the inside
 * out while its cream card contracts and rounds into the disc it lands on
 * (`lands`), and one whose address was reused scatters and leaves a honey
 * twin.
 *
 * The modules fill the card but for a quiet zone of four modules (`qrGrid`),
 * and every module edge falls on a whole pixel, so no seam shows where one
 * band's modules meet the next band's and a dense request still scans.
 *
 * Only a request that can still be paid is drawn as a code, named for a
 * screen reader and pressable. Anything else is decoration for its caller to
 * put words to, so nothing on screen can be scanned into a payment that would
 * go wrong. `onPress` enlarges it and `onLongPress` copies it.
 */
export type QrState = 'shown' | 'expired' | 'paid' | 'scattered';

export interface QrBloomProps {
  value: string;
  /** How wide the card is drawn, its quiet zone included. */
  size: number;
  state: QrState;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel: string;
  /**
   * The side of the disc a paid code lands on, centred where the code was:
   * its card contracts and rounds into it, then hands over to it.
   */
  lands?: number;
  /** The code itself, for a screen reader to be sent back to. */
  ref?: Ref<HostInstance>;
}

/**
 * The quiet zone around the modules, in modules: the four ISO 18004 asks
 * for, which scanners need to find the code.
 */
export const QR_QUIET = 4;

/** Bands of modules, from the centre out. */
export const BANDS = 5;

/** The layer the finder squares move on, after every band. */
export const FINDERS = BANDS;

/** A finder square is 7 modules across. */
const FINDER = 7;

/** The honey twin's stroke, in grid units, where it fills a whole frame. */
const TWIN_STROKE = 0.9;

/** The module grid: `size` modules a side, `data` 1 where a module is dark. */
export interface QrModules {
  size: number;
  data: ArrayLike<number>;
}

/** The modules for `value`, at the error correction the old code used. */
export function qrModules(value: string): QrModules {
  const { modules } = QRCode.create(value, {
    errorCorrectionLevel: 'M',
  }) as { modules: QrModules };
  return modules;
}

/** Where a finder square sits, in modules, and its modules as a path. */
export interface Finder {
  x: number;
  y: number;
  d: string;
}

/** Where a code's modules sit on its card. */
export interface QrGrid {
  ratio: number;
  /** A module's width in points, on average. */
  unit: number;
  /** The quiet zone, in points. */
  inset: number;
  /** Where each module edge falls, 0 to `modules`, in pixels from the card's edge. */
  edges: number[];
}

/**
 * Where a code of `modules` a side sits on a card `side` points across, on a
 * screen of `ratio` pixels to the point (`PixelRatio.get()`).
 *
 * The modules fill the card but for the quiet zone: QR_QUIET modules, or a
 * little more on the densest codes, so the card's rounded corner stays a
 * module clear of each finder's outer corner. Each module edge is rounded to
 * a whole pixel, so neighbouring modules in different layers meet without a
 * seam, and a module is at most a pixel wider than another.
 */
export function qrGrid(
  side: number,
  modules: number,
  ratio: number,
  corner: number = radius.qr,
): QrGrid {
  const plain = side / (modules + 2 * QR_QUIET);
  // A finder's outer corner at (d, d) lies r - (r - d)√2 inside a corner of
  // radius r. This is the module at which that is one module, which is the
  // smaller only on the densest codes.
  const clear = (side - (2 - Math.SQRT2) * corner) / (modules + Math.SQRT2);
  const unit = Math.min(plain, clear);
  const inset = (side - modules * unit) / 2;
  const edges = Array.from({ length: modules + 1 }, (_, k) =>
    Math.round((inset + k * unit) * ratio),
  );
  return { ratio, unit, inset, edges };
}

/**
 * Modules on a row drawn as runs, one path for each of `count` layers, so a
 * path holds a run as one rectangle. `layer` says which layer the module at
 * a row and column is drawn in, or -1 for none; `x` and `y` say where module
 * edge k falls across and down. One pass over the grid draws every layer.
 */
function runs(
  size: number,
  count: number,
  layer: (row: number, column: number) => number,
  x: (k: number) => number,
  y: (k: number) => number,
): string[] {
  const d: string[] = Array.from({ length: count }, () => '');
  for (let row = 0; row < size; row++) {
    const top = y(row);
    const height = y(row + 1) - top;
    let start = -1;
    let open = -1;
    for (let column = 0; column <= size; column++) {
      const here = column < size ? layer(row, column) : -1;
      if (here === open) continue;
      if (open >= 0) {
        const width = x(column) - x(start);
        d[open] += `M${x(start)} ${top}h${width}v${height}h-${width}z`;
      }
      open = here;
      start = column;
    }
  }
  return d;
}

/**
 * The code split for its bloom: `bands` holds a path per band, centre
 * first, and `finders` the three finder squares, each drawn from the corner
 * of its own 7 by 7 box. Paths are in module units, or with `edges` from
 * `qrGrid` in pixels from where the layer's box starts: the whole code for
 * a band, and its own square for a finder.
 *
 * Each module's band is worked out once, and every band drawn in one pass,
 * since a dense request has sixteen thousand modules and this runs as the
 * request comes up.
 */
export function qrLayers(
  { size, data }: QrModules,
  edges?: ArrayLike<number>,
): {
  bands: string[];
  finders: Finder[];
} {
  const at = (k: number) => (edges ? edges[k] : k);
  const from = (origin: number) => (k: number) => at(origin + k) - at(origin);
  const dark = (row: number, column: number) => data[row * size + column] === 1;
  const corners = [
    { x: 0, y: 0 },
    { x: size - FINDER, y: 0 },
    { x: 0, y: size - FINDER },
  ];
  const inFinder = (row: number, column: number) =>
    corners.some(
      ({ x, y }) =>
        column >= x && column < x + FINDER && row >= y && row < y + FINDER,
    );
  const middle = (size - 1) / 2;
  const farthest = Math.SQRT2 * middle || 1;
  const band = new Int8Array(size * size).fill(-1);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (!dark(row, column) || inFinder(row, column)) continue;
      band[row * size + column] = Math.min(
        BANDS - 1,
        Math.floor(
          (BANDS * Math.hypot(row - middle, column - middle)) / farthest,
        ),
      );
    }
  }
  const bands = runs(
    size,
    BANDS,
    (row, column) => band[row * size + column],
    from(0),
    from(0),
  );
  const finders = corners.map(({ x, y }) => ({
    x,
    y,
    d: runs(
      FINDER,
      1,
      (row, column) => (dark(y + row, x + column) ? 0 : -1),
      from(x),
      from(y),
    )[0],
  }));
  return { bands, finders };
}

/** The bloom's clock, in ms. */
export const QR_TIMING = {
  start: 80,
  step: 40,
  enter: 220,
  dissolve: 220,
  implode: 420,
  scatter: 320,
};

/**
 * When the cream card has gone once a code can no longer be paid, in ms: it
 * fades after the bands have set off, so a paid code implodes on cream, and a
 * paid code's card has landed on its disc by then, every module gone.
 * Whatever takes the code's place waits for this before it draws a dark
 * stroke across where the card was.
 */
export const QR_CARD_GONE = QR_TIMING.step * BANDS + QR_TIMING.dissolve;

/** How long a paid card takes to hand over to the disc it has landed on. */
export const QR_HANDOVER = 90;

/**
 * When a code has bloomed in, in ms from its mount: the finders, its last
 * layer, have entered. A request's frame starts to listen for its payment
 * then (REDESIGN.md 5, Listening ping), never over a code still arriving.
 */
export const QR_SETTLED =
  QR_TIMING.start + QR_TIMING.step * FINDERS + QR_TIMING.enter;

/**
 * A paid code's card `c` (0 to 1) of the way to the disc it lands on,
 * `lands` across, from a card `size` across with corners of `corner`: its
 * scale, and the corner that makes it that disc, a circle, at the end.
 */
export function paidCard(
  c: number,
  size: number,
  lands: number,
  corner: number,
): { scale: number; radius: number } {
  'worklet';
  return {
    scale: 1 + (lands / size - 1) * c,
    radius: corner + (size / 2 - corner) * c,
  };
}

/**
 * How layer `layer` (a band from the centre out, or FINDERS) moves into
 * `state`: when it starts, how long it takes, and where it ends.
 */
export interface LayerMotion {
  delay: number;
  duration: number;
  opacity: number;
  scale: number;
  /** How far it flies off along its own heading, 0 to 1. */
  spread: number;
}

export function layerMotion(layer: number, state: QrState): LayerMotion {
  const { start, step } = QR_TIMING;
  switch (state) {
    case 'shown':
      return {
        delay: start + step * layer,
        duration: QR_TIMING.enter,
        opacity: 1,
        scale: 1,
        spread: 0,
      };
    case 'expired':
      // The outside goes first, and the finders last of all.
      return {
        delay: step * (layer === FINDERS ? BANDS : BANDS - 1 - layer),
        duration: QR_TIMING.dissolve,
        opacity: 0,
        scale: 1.06,
        spread: 0,
      };
    case 'paid': {
      // Every module is gone as the card lands on its disc, so nothing is
      // left inside the ring once the card has gone (P10, 42-c3 frames
      // 206-210). The finders go at once, since the card's corners round
      // away from them, and the bands from the centre out.
      const delay = layer === FINDERS ? 0 : step * layer;
      return {
        delay,
        duration: layer === FINDERS ? QR_TIMING.dissolve : QR_CARD_GONE - delay,
        opacity: 0,
        scale: 0.2,
        spread: 0,
      };
    }
    case 'scattered':
      return {
        delay: (step / 2) * layer,
        duration: QR_TIMING.scatter,
        opacity: 0,
        scale: 1,
        spread: 1,
      };
  }
}

/**
 * Under Reduce Motion a code only fades, in or out, and never travels. A fade
 * moves nothing, so it opts out of the system setting, which would otherwise
 * skip it and cut the code in or out at once.
 */
const CROSSFADE = {
  duration: durations.crossfade,
  easing: curves.standard,
  reduceMotion: ReduceMotion.Never,
};

/** How long every layer takes to leave `state`'s way, all told. */
export function leaveMs(state: Exclude<QrState, 'shown'>): number {
  return Math.max(
    ...Array.from({ length: FINDERS + 1 }, (_, layer) => {
      const motion = layerMotion(layer, state);
      return motion.delay + motion.duration;
    }),
  );
}

/**
 * How layer `layer` moves into `state` on a card that waited `late` ms for
 * its modules: a code blooming in spends its lead in first, never its
 * stagger, and anything else moves as `layerMotion` says.
 */
export function bloomMotion(
  layer: number,
  state: QrState,
  late: number,
): LayerMotion {
  const motion = layerMotion(layer, state);
  if (state !== 'shown') return motion;
  return {
    ...motion,
    delay: motion.delay - Math.min(Math.max(0, late), QR_TIMING.start),
  };
}

/** How far a scattered layer flies, and which way: each its own heading. */
const SCATTER = 28;
export function scatterOffset(layer: number): { x: number; y: number } {
  // The golden angle, so no two layers leave the same way.
  const heading = (layer * 137.5 * Math.PI) / 180;
  return { x: Math.cos(heading) * SCATTER, y: Math.sin(heading) * SCATTER };
}

/** A code worked out for a card: where its modules sit, and its layers. */
export interface QrDrawing {
  grid: QrGrid;
  layers: { size: number; bands: string[]; finders: Finder[] };
  /** How long the card waited for it, in ms. */
  late: number;
}

/**
 * The code `value` worked out for a card `size` points across on a screen
 * of `ratio`, or null until it has been. It is worked out once the card is
 * drawn rather than while it is: a dense request holds the JS thread for a
 * frame or more, and worked out in the render that brought the request up,
 * it held back the whole change of step, so the quote never left and the
 * request came in at once (P7, 48-c3-request-reveal). The card arrives
 * first and the modules bloom in on it as soon as they are ready.
 */
export function useQrDrawing(
  value: string,
  size: number,
  ratio: number,
): QrDrawing | null {
  const [born] = useState(() => Date.now());
  const [drawn, setDrawn] = useState<{
    key: string;
    drawing: QrDrawing;
  } | null>(null);
  const key = `${size} ${ratio} ${value}`;
  useEffect(() => {
    const modules = qrModules(value);
    const grid = qrGrid(size, modules.size, ratio);
    setDrawn({
      key: `${size} ${ratio} ${value}`,
      drawing: {
        grid,
        layers: { size: modules.size, ...qrLayers(modules, grid.edges) },
        late: Date.now() - born,
      },
    });
  }, [value, size, ratio, born]);
  return drawn?.key === key ? drawn.drawing : null;
}

/** One layer of modules, which moves as its state says and nothing else. */
const Layer = memo(function QrLayer({
  layer,
  state,
  reduced,
  lead,
  frame,
  viewBox,
  d,
}: {
  layer: number;
  state: QrState;
  reduced: boolean;
  /**
   * How much of the bloom's lead in was spent waiting for the modules, taken
   * off each layer's start as it blooms in, so the bands keep their stagger.
   */
  lead: number;
  frame: { left: number; top: number; width: number; height: number };
  viewBox: string;
  d: string;
}) {
  const opacity = useSharedValue(0);
  const scale = useSharedValue(reduced ? 1 : layer === FINDERS ? 0.6 : 0.9);
  const spread = useSharedValue(0);
  useEffect(() => {
    const motion = bloomMotion(layer, state, lead);
    if (reduced) {
      // Nothing travels: every layer crossfades at once (REDESIGN.md 8).
      scale.set(1);
      spread.set(0);
      opacity.set(withTiming(motion.opacity, CROSSFADE));
      return () => cancelAnimation(opacity);
    }
    // A paid code implodes from its first frame and fades as it goes, rather
    // than holding dark on a fading card (P10, 42-c3 frames 199-205).
    const timing = {
      duration: motion.duration,
      easing:
        state === 'shown'
          ? curves.enter
          : state === 'paid'
          ? curves.standard
          : curves.exit,
    };
    opacity.set(withDelay(motion.delay, withTiming(motion.opacity, timing)));
    spread.set(withDelay(motion.delay, withTiming(motion.spread, timing)));
    // The finders pop in with a little overshoot, as the bloom's centre does.
    scale.set(
      withDelay(
        motion.delay,
        state === 'shown'
          ? withSpring(motion.scale, springs.reveal)
          : withTiming(motion.scale, timing),
      ),
    );
    return () => {
      cancelAnimation(opacity);
      cancelAnimation(scale);
      cancelAnimation(spread);
    };
  }, [layer, state, reduced, lead, opacity, scale, spread]);
  const away = scatterOffset(layer);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.get(),
    transform: [
      { translateX: away.x * spread.get() },
      { translateY: away.y * spread.get() },
      { rotate: `${(layer % 2 ? 8 : -8) * spread.get()}deg` },
      { scale: scale.get() },
    ],
  }));
  return (
    <Reanimated.View style={[styles.layer, frame, style]}>
      <Svg width={frame.width} height={frame.height} viewBox={viewBox}>
        <Path d={d} fill={palette.ink} />
      </Svg>
    </Reanimated.View>
  );
});

export const QrBloom = memo(function QrCode({
  value,
  size,
  state,
  onPress,
  onLongPress,
  accessibilityLabel,
  lands,
  ref,
}: QrBloomProps) {
  const live = usePaneActive();
  const { reduced } = useMotionPrefs();
  const shown = state === 'shown';
  const pressable = shown && (!!onPress || !!onLongPress);
  const ratio = PixelRatio.get();
  const drawing = useQrDrawing(value, size, ratio);

  // The layers stay drawn while they leave, then go, so a code that can no
  // longer be paid is not left on screen at any opacity.
  const [leaving, setLeaving] = useState(false);
  const [wasShown, setWasShown] = useState(shown);
  if (wasShown !== shown) {
    setWasShown(shown);
    setLeaving(!shown);
  }
  useEffect(() => {
    if (!leaving || state === 'shown') return;
    const timer = setTimeout(
      () => setLeaving(false),
      reduced ? CROSSFADE.duration : leaveMs(state),
    );
    return () => clearTimeout(timer);
  }, [leaving, state, reduced]);

  const card = useSharedValue(reduced ? 1 : 0.92);
  const cream = useSharedValue(shown ? 1 : 0);
  // A paid code's card contracting onto the disc it lands on, 0 to 1.
  const contract = useSharedValue(0);
  const landing = state === 'paid' && !!lands && !reduced;
  useEffect(() => {
    card.set(reduced ? 1 : withSpring(1, springs.pane));
  }, [card, reduced]);
  useEffect(() => {
    if (!landing) {
      contract.set(0);
      return;
    }
    contract.set(
      withTiming(1, { duration: QR_CARD_GONE, easing: curves.standard }),
    );
    return () => cancelAnimation(contract);
  }, [contract, landing]);
  useEffect(() => {
    const target = shown ? 1 : 0;
    cream.set(
      shown
        ? target
        : reduced
        ? withTiming(target, CROSSFADE)
        : landing
        ? // Opaque cream all the way down onto the disc, so the modules
          // implode on cream and never over a fading, taupe card; then it
          // hands over to the disc under it.
          withDelay(
            QR_CARD_GONE,
            withTiming(target, {
              duration: QR_HANDOVER,
              easing: curves.standard,
            }),
          )
        : withDelay(
            QR_TIMING.step * BANDS,
            withTiming(target, {
              duration: QR_TIMING.dissolve,
              easing: curves.exit,
            }),
          ),
    );
    return () => cancelAnimation(cream);
  }, [cream, shown, reduced, landing]);
  const lead = lands ?? size;
  const corner = radius.qr;
  const cardStyle = useAnimatedStyle(() => {
    const pose = paidCard(contract.get(), size, lead, corner);
    return {
      borderRadius: pose.radius,
      transform: [{ scale: card.get() * pose.scale }],
    };
  }, [size, lead, corner]);
  const creamStyle = useAnimatedStyle(
    () => ({
      opacity: cream.get(),
      borderRadius: paidCard(contract.get(), size, lead, corner).radius,
    }),
    [size, lead, corner],
  );

  // A layer's box, from module edge x, y to the edge `modules` on, in points
  // that land on whole pixels, and its drawing's own pixels as the viewBox.
  const edges = drawing?.grid.edges ?? [];
  const box = (x: number, y: number, modules: number) => {
    const width = edges[x + modules] - edges[x];
    const height = edges[y + modules] - edges[y];
    return {
      frame: {
        left: edges[x] / ratio,
        top: edges[y] / ratio,
        width: width / ratio,
        height: height / ratio,
      },
      viewBox: `0 0 ${width} ${height}`,
    };
  };
  return (
    <Pressable
      ref={ref}
      accessible={shown}
      accessibilityRole={pressable ? 'button' : 'image'}
      accessibilityLabel={shown ? accessibilityLabel : undefined}
      accessibilityHint={shown && onPress ? copy.receive.qrHint : undefined}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      disabled={!pressable}
      onPress={
        live && pressable && onPress
          ? () => {
              haptics.tick();
              onPress();
            }
          : undefined
      }
      onLongPress={
        live && pressable && onLongPress
          ? () => {
              haptics.tick();
              onLongPress();
            }
          : undefined
      }
    >
      <Reanimated.View
        style={[
          styles.card,
          { width: size, height: size },
          landing && styles.clip,
          cardStyle,
        ]}
      >
        <View
          style={[
            styles.fill,
            state === 'expired' && styles.expired,
            state === 'scattered' && styles.scattered,
          ]}
        />
        <Reanimated.View style={[styles.fill, styles.cream, creamStyle]} />
        {drawing && (shown || leaving) ? (
          <>
            {drawing.layers.bands.map((d, band) =>
              d ? (
                <Layer
                  key={band}
                  layer={band}
                  state={state}
                  reduced={reduced}
                  lead={drawing.late}
                  {...box(0, 0, drawing.layers.size)}
                  d={d}
                />
              ) : null,
            )}
            {drawing.layers.finders.map(finder => (
              <Layer
                key={`${finder.x}-${finder.y}`}
                layer={FINDERS}
                state={state}
                reduced={reduced}
                lead={drawing.late}
                {...box(finder.x, finder.y, FINDER)}
                d={finder.d}
              />
            ))}
          </>
        ) : null}
        {state === 'expired' || state === 'scattered' ? (
          <Reanimated.View
            entering={riseIn(0, leaveMs(state))}
            style={styles.face}
          >
            {state === 'expired' ? (
              <Glyph name="clock" size={size / 4} color={palette.dust} />
            ) : (
              <Glyph
                name="twin"
                size={size * 0.7}
                color={palette.honey}
                strokeWidth={TWIN_STROKE}
              />
            )}
          </Reanimated.View>
        ) : null}
      </Reanimated.View>
    </Pressable>
  );
});
QrBloom.displayName = 'QrBloom';

const styles = StyleSheet.create({
  card: { borderRadius: radius.qr },
  // A paid card rounds into a disc, and what is left of the code rounds
  // with it rather than poking past its corners.
  clip: { overflow: 'hidden' },
  fill: { ...StyleSheet.absoluteFill, borderRadius: radius.qr },
  cream: { backgroundColor: palette.cream },
  expired: {
    backgroundColor: palette.mocha,
    borderWidth: 1.5,
    borderColor: palette.husk,
  },
  scattered: {
    backgroundColor: palette.honeyWash,
    borderWidth: 1.5,
    borderColor: palette.honey,
  },
  layer: { position: 'absolute' },
  face: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
