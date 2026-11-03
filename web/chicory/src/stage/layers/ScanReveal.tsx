import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import Reanimated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type {
  EntryExitAnimationFunction,
  SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import {
  CAUGHT_HOLD,
  ScanGround,
  Scanner,
  firstAccess,
} from '../../components/Scanner';
import type { CameraAccess } from '../../components/Scanner';
import { steady } from '../../motion/steady';
import { curves, durations, springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { STATUS_ROW, WELL_DROP } from '../layout';
import type { Point, ScanPurpose, ScanTarget } from '../scene';
import { localPoint } from '../../../../platform/geometry';

/** The scan button's diameter on Home, which the disc grows out of. */
export const BUTTON = 76;
/** How far the disc opens when the camera cannot be used. */
export const PARTIAL = 0.6;
/**
 * About how long the pane spring takes to look open. The camera mounts then,
 * timed by a clock of its own: the spring only reports rest near 630ms.
 */
const REVEAL_MS = 380;
// Where a code read from home collapses into Send's well, kept with the
// canvas's other measures.
export { WELL_DROP };
/** How long the disc takes to close, and the curve it closes on. */
const COLLAPSE_MS = durations.move;
const COLLAPSE_CURVE = curves.standard;
/** How far into a collapse the disc starts to fade. */
const COLLAPSE_FADE_AT = 180;
const NOWHERE: Point = { x: 0, y: 0 };

const FADE = {
  duration: durations.crossfade,
  easing: curves.standard,
  reduceMotion: ReduceMotion.Never,
};

/**
 * The disc for an `origin` in a `width` by `height` layer: centred on the
 * origin, or the bottom centre without one, with a radius that reaches the
 * farthest corner, so at full size it covers everything. `from` is the scale
 * at which it is the scan button's size.
 */
export interface Disc {
  x: number;
  y: number;
  radius: number;
  from: number;
}

export function discFor(
  origin: Point | null,
  width: number,
  height: number,
): Disc {
  const x = origin?.x ?? width / 2;
  const y = origin?.y ?? height;
  const radius = Math.max(
    Math.hypot(x, y),
    Math.hypot(width - x, y),
    Math.hypot(x, height - y),
    Math.hypot(width - x, height - y),
  );
  return { x, y, radius, from: Math.min(1, BUTTON / (2 * radius)) };
}

/**
 * The transform that holds the disc's content still while the disc is at
 * `scale`. The content fills the layer, so it scales about the layer's centre,
 * and the disc about the origin: undoing one with the other takes the inverse
 * scale plus a shift of the difference between the two centres.
 */
export function counterScale(
  scale: number,
  disc: Disc,
  width: number,
  height: number,
) {
  'worklet';
  const inverse = 1 / scale;
  return {
    translateX: (inverse - 1) * (width / 2 - disc.x),
    translateY: (inverse - 1) * (height / 2 - disc.y),
    scale: inverse,
  };
}

/**
 * How far the disc opens: all the way onto the camera, or partway around the
 * glyph and the paste fallback when there is no camera to show.
 */
export function opening(access: CameraAccess): number {
  return access === 'denied' || access === 'missing' ? PARTIAL : 1;
}

/**
 * Where the disc collapses once a code is read (REDESIGN.md 7, T3): into
 * Send's request well, or into the Settings field the code fills. From
 * inside Send the well is where it grew from, the well's own scan button;
 * from home, the well of the Send it opens. For Settings it is the field,
 * `into` in the layer's own coordinates (`layerPoint`), or back into its
 * button when the field could not say where it is. A close, as opposed to a
 * code read, always closes back into the button.
 */
export function landing(
  disc: Disc,
  target: ScanTarget,
  grewFromButton: boolean,
  width: number,
  top: number,
  into: Point | null = null,
): Point {
  if (target === 'settings') return into ?? { x: disc.x, y: disc.y };
  if (target === 'send' && grewFromButton) return { x: disc.x, y: disc.y };
  return { x: width / 2, y: top + STATUS_ROW + WELL_DROP };
}

/**
 * `point`, in the window, in the coordinates of a layer `width` by `height`
 * that starts `left` points in, after a side cutout, and kept inside it: a
 * field scrolled partly out of view still takes the disc to the edge it
 * went past, rather than off the screen.
 */
export function layerPoint(
  point: Point,
  left: number,
  width: number,
  height: number,
): Point {
  return {
    x: Math.min(Math.max(point.x - left, 0), width),
    y: Math.min(Math.max(point.y, 0), height),
  };
}

/** One transform, in the order the disc and its ground apply theirs. */
export interface Pose {
  translateX: number;
  translateY: number;
  scale: number;
}

/**
 * The disc and its ground `p` of the way through closing from scale `start`
 * to `end`, its centre moving by `shift`. The disc closes like an iris: its
 * ground is held where it is on screen, so the circle closes over a still
 * picture instead of shrinking it. Holding it still takes the counter-scale,
 * less the disc's own shift at the ground's scale.
 */
export function irisPose(
  p: number,
  start: number,
  end: number,
  shift: Point,
  disc: Disc,
  width: number,
  height: number,
): { disc: Pose; ground: Pose } {
  'worklet';
  const scale = start + (end - start) * p;
  const x = shift.x * p;
  const y = shift.y * p;
  const still = counterScale(scale, disc, width, height);
  return {
    disc: { translateX: x, translateY: y, scale },
    ground: {
      translateX: still.translateX - x / scale,
      translateY: still.translateY - y / scale,
      scale: still.scale,
    },
  };
}

/**
 * A timing's target and easing that carry `value(p)` along `curve`. A timing
 * eases from where it starts to its target, so an easing of how far along
 * that line `value(curve(u))` lies puts the view exactly on it every frame.
 * This keeps the ground's counter-scale, which is no straight line of the
 * disc's scale, in step with the disc on the same clock.
 */
export function eased(
  value: (p: number) => number,
  curve: (u: number) => number,
): { to: number; easing: (u: number) => number } {
  'worklet';
  const from = value(0);
  const to = value(1);
  const easing = (u: number) => {
    'worklet';
    return to === from ? 1 : (value(curve(u)) - from) / (to - from);
  };
  return { to, easing };
}

type Reading = Pick<SharedValue<number>, 'get'>;

/** What a closing disc reads as it starts, and where it is drawn. */
export interface Closing {
  scale: Reading;
  fade: Reading;
  /** 1 once a code was read, which sends the disc into the well or field. */
  caught: Reading;
  disc: Disc;
  width: number;
  height: number;
  /** The shift from the origin to the well, or to the field a code fills. */
  toWell: Point;
}

/**
 * Where a closing disc is headed. A code read closes it into the well, or
 * the field it fills, once the corners have held a beat, sage; anything else
 * closes it at once back into its button.
 */
function closing({ scale, caught, disc, toWell }: Closing) {
  'worklet';
  const read = caught.get() === 1;
  return {
    start: Math.max(scale.get(), disc.from),
    shift: read ? toWell : NOWHERE,
    delay: read ? CAUGHT_HOLD : 0,
  };
}

/**
 * The disc leaving (REDESIGN.md 7, T3): it closes back into its button, or
 * with a code read into Send's well or the Settings field it fills, fading
 * as it gets there. Under Reduce Motion it only fades.
 */
export function collapse(
  closes: Closing,
  reduced: boolean,
): EntryExitAnimationFunction {
  return () => {
    'worklet';
    if (reduced) {
      return {
        initialValues: { opacity: closes.fade.get() },
        animations: { opacity: withTiming(0, FADE) },
      };
    }
    const { start, shift, delay } = closing(closes);
    const to = (value: number) =>
      withDelay(
        delay,
        withTiming(value, { duration: COLLAPSE_MS, easing: COLLAPSE_CURVE }),
      );
    return {
      initialValues: {
        opacity: closes.fade.get(),
        transform: [{ translateX: 0 }, { translateY: 0 }, { scale: start }],
      },
      animations: {
        opacity: withDelay(
          delay + COLLAPSE_FADE_AT,
          withTiming(0, { duration: durations.exit, easing: curves.exit }),
        ),
        transform: [
          { translateX: to(shift.x) },
          { translateY: to(shift.y) },
          { scale: to(closes.disc.from) },
        ],
      },
    };
  };
}

/**
 * The disc's ground while the disc closes: held still on screen, on the
 * disc's own clock and curve, so the iris closes over it. The two start in
 * the same frame, since Reanimated starts a batch of layout animations on
 * one timestamp.
 */
export function groundCollapse(closes: Closing): EntryExitAnimationFunction {
  return () => {
    'worklet';
    const { start, shift, delay } = closing(closes);
    const { disc, width, height } = closes;
    const curve = COLLAPSE_CURVE.factory();
    const at = (p: number) =>
      irisPose(p, start, disc.from, shift, disc, width, height).ground;
    const along = (key: keyof Pose) => {
      const { to, easing } = eased(p => at(p)[key], curve);
      return withDelay(
        delay,
        withTiming(to, { duration: COLLAPSE_MS, easing }),
      );
    };
    const first = at(0);
    return {
      initialValues: {
        transform: [
          { translateX: first.translateX },
          { translateY: first.translateY },
          { scale: first.scale },
        ],
      },
      animations: {
        transform: [
          { translateX: along('translateX') },
          { translateY: along('translateY') },
          { scale: along('scale') },
        ],
      },
    };
  };
}

/**
 * The scan overlay (REDESIGN.md 2.3, 5 and 7, T3): a disc that grows out of
 * the scan button at `origin`, in window coordinates, onto the scanner.
 * `target` is where a code goes: a new Send from home, the Send already
 * open, or the Settings field that asked, which gives `purpose`, what the
 * scanner says it reads, `validate`, its own check of a code, and `into`,
 * where the field is in the window, for a code read to collapse into it.
 * `onDetected` gets the code in the same call the scanner reads it;
 * `onCancel` asks for the overlay to close, as Android's back does through
 * the stage.
 *
 * The disc is a circle as wide as twice the distance to the farthest corner,
 * clipping a ground that stays still while it scales from the button's size
 * to 1 on the pane spring. Under Reduce Motion it fades in at full size.
 *
 * Android's camera preview is a SurfaceView, which ignores clipping, alpha
 * and transforms, so the camera never rides the disc. It mounts full bleed,
 * beside the disc rather than in it, once the disc has opened, under a cover
 * of the same ground that fades away. Leaving, the camera, which has no exit
 * of its own, is removed at once, and the disc closes like an iris over its
 * still ground while the corners fade. iOS clips a camera fine, and takes the
 * same path.
 */
export interface ScanRevealProps {
  browserOrigin?: Point;
  browserWell?: Point;
  origin: Point | null;
  target: ScanTarget;
  /** What the scan is for; a payment request unless given. */
  purpose?: ScanPurpose;
  /**
   * The check a code is held to before it is taken, which returns what is
   * taken or throws why not. Without one, a payment request is looked for.
   */
  validate?: (value: string) => string;
  /** The Settings field a code read fills, in the window. */
  into?: Point | null;
  onDetected: (value: string) => void;
  onCancel: () => void;
  /**
   * A wallet on a test network: slate's night in place of bloom's on the
   * ground, and the flask kept in view (REDESIGN.md rule 4 and 3.1).
   */
  test?: boolean;
}

export function ScanReveal({
  origin,
  target,
  purpose,
  validate,
  into = null,
  onDetected,
  onCancel,
  test = false,
  browserOrigin,
  browserWell,
}: ScanRevealProps) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const { reduced } = useMotionPrefs();
  const offsetX = browserOrigin?.x ?? insets.left;
  const offsetY = browserOrigin?.y ?? 0;
  // The canvas this covers runs edge to edge, and only a side cutout narrows
  // it. The window stands in until the first layout.
  const [measured, setMeasured] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const width = measured?.width ?? window.width - insets.left - insets.right;
  const height = measured?.height ?? window.height;
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width: w, height: h } = event.nativeEvent.layout;
    setMeasured(last =>
      last && last.width === w && last.height === h
        ? last
        : { width: w, height: h },
    );
  }, []);
  // `origin` is in the window, and this layer starts after a side cutout.
  const disc = useMemo(
    () =>
      discFor(
        origin ? localPoint(origin, { x: offsetX, y: offsetY }) : null,
        width,
        height,
      ),
    [origin, offsetX, offsetY, width, height],
  );

  const [access, setAccess] = useState<CameraAccess>(firstAccess);
  // The opening the disc last finished growing to. The camera waits for a
  // full one, including when it is switched on from the device settings
  // and the disc opens the rest of the way.
  const [opened, setOpened] = useState<number | null>(null);
  const open = opening(access);
  const scale = useSharedValue(reduced ? open : disc.from);
  const fade = useSharedValue(reduced ? 0 : 1);
  const clock = useSharedValue(0);
  const caught = useSharedValue(0);

  useEffect(() => {
    const done = (finished?: boolean) => {
      'worklet';
      if (finished) scheduleOnRN(setOpened, open);
    };
    if (reduced) {
      scale.set(open);
      fade.set(withTiming(1, FADE, done));
      return;
    }
    fade.set(1);
    // The frame that mounts the camera's layer can take a while to paint, so
    // the disc and the clock that mounts the camera both run on the steady
    // clock (REDESIGN.md 3.5): the reveal is seen from the button, and the
    // camera still waits for the disc to look open.
    scale.set(steady(withSpring(open, springs.pane)));
    clock.set(0);
    clock.set(
      steady(
        withTiming(
          1,
          {
            duration: REVEAL_MS,
            easing: curves.linear,
            reduceMotion: ReduceMotion.Never,
          },
          done,
        ),
      ),
    );
  }, [open, reduced, scale, fade, clock]);

  // The disc's exit reads `caught` to tell a code read from a close.
  const detected = useCallback(
    (value: string) => {
      caught.set(1);
      onDetected(value);
    },
    [caught, onDetected],
  );

  const discStyle = useAnimatedStyle(() => ({
    opacity: fade.get(),
    transform: [{ translateX: 0 }, { translateY: 0 }, { scale: scale.get() }],
  }));
  const groundStyle = useAnimatedStyle(() => {
    const still = counterScale(
      Math.max(scale.get(), disc.from),
      disc,
      width,
      height,
    );
    return {
      transform: [
        { translateX: still.translateX },
        { translateY: still.translateY },
        { scale: still.scale },
      ],
    };
  }, [disc, width, height]);

  // `into` is in the window too, and kept inside this layer.
  const field = useMemo(
    () => (into ? layerPoint(localPoint(into, { x: offsetX, y: offsetY }), 0, width, height) : null),
    [into, offsetX, offsetY, width, height],
  );
  const exits = useMemo(() => {
    const well = browserWell && target !== 'settings'
      ? localPoint(browserWell, { x: offsetX, y: offsetY })
      : landing(disc, target, !!origin, width, insets.top, field);
    const closes: Closing = {
      scale,
      fade,
      caught,
      disc,
      width,
      height,
      toWell: { x: well.x - disc.x, y: well.y - disc.y },
    };
    // Under Reduce Motion the disc only fades, so its ground stays put
    // without an exit of its own.
    return {
      disc: collapse(closes, reduced),
      ground: reduced ? undefined : groundCollapse(closes),
    };
  }, [
    disc,
    target,
    origin,
    field,
    browserWell,
    offsetX,
    offsetY,
    width,
    height,
    insets.top,
    scale,
    fade,
    caught,
    reduced,
  ]);

  return (
    <View style={styles.layer} onLayout={onLayout} accessibilityViewIsModal>
      <Reanimated.View
        testID="scan-disc"
        pointerEvents="none"
        exiting={exits.disc}
        style={[
          styles.disc,
          {
            left: disc.x - disc.radius,
            top: disc.y - disc.radius,
            width: disc.radius * 2,
            height: disc.radius * 2,
            borderRadius: disc.radius,
          },
          discStyle,
        ]}
      >
        <Reanimated.View
          exiting={exits.ground}
          style={[
            styles.ground,
            {
              left: disc.radius - disc.x,
              top: disc.radius - disc.y,
              width,
              height,
            },
            groundStyle,
          ]}
        >
          <ScanGround width={width} height={height} test={test} />
        </Reanimated.View>
      </Reanimated.View>
      <View style={styles.layer} pointerEvents="box-none">
        <Scanner
          live={opened === 1}
          purpose={purpose}
          validate={validate}
          onDetected={detected}
          onCancel={onCancel}
          onAccess={setAccess}
          test={test}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: StyleSheet.absoluteFill,
  disc: { position: 'absolute', overflow: 'hidden' },
  ground: { position: 'absolute' },
});
