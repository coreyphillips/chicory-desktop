import React, {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { pickQrImage } from '../../../platform/qrImage';
import * as BrowserCamera from '../../../platform/cameraKit';
import Clipboard from '@react-native-clipboard/clipboard';
import Reanimated, {
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type {
  EntryExitAnimationFunction,
  SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { parsePayment } from '@beignet/wallet-core';
import { announce } from '../design/announce';
import { copy } from '../design/copy';
import { Glyph } from '../design/glyphs';
import type { GlyphName } from '../design/glyphs';
import { haptics } from '../design/haptics';
import { mixHex, palette } from '../design/palette';
import { Whisper } from '../glyphs/Whisper';
import { riseIn, sceneOut } from '../motion/presets';
import { steady } from '../motion/steady';
import { curves, durations, overlap, shake, springs } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';
import { normalizePaymentLink } from '../services/links';
import { useAppActive } from '../scenes/home/useAppActive';
import { STATUS_ROW } from '../stage/layout';
import type { ScanPurpose, ScanSource } from '../stage/scene';
import { duringSystemPrompt } from '../stage/systemPrompt';
import { focusOn } from '../motion/focus';
import { HIT_SLOP, space } from '../theme';

/**
 * Point the camera at a payment request (REDESIGN.md 5, Scan reveal).
 *
 * Nothing here is written on screen. Four corners mark where to aim: dashed
 * and turning while the camera is being asked for, breathing while it reads,
 * snapping in and turning sage on a code that can be paid, and flashing
 * radish with a shake on one that cannot, which leaves the camera reading.
 * A camera that is off or missing shows `cameraOff`, with the paste fallback
 * and, when it is only switched off, a cog for the device settings. The words
 * each state used to print are its accessibility strings.
 *
 * The camera module is resolved optionally, so the JavaScript still runs in
 * Jest and in any build whose native side has not been rebuilt since the
 * module was added; without it this degrades to the paste path rather than a
 * blank or broken screen.
 *
 * A scanned code is handed to Send exactly as a pasted one is, and only once
 * the payment parser can read it as something to pay. Nothing is paid from
 * here, and no frame or image leaves the device.
 *
 * Settings asks it for other codes: a primary node's address, or the Bitcoin
 * address the wallet empties to. Each brings its check (`validate`), which
 * stands in for the payment parser, and its words (`purpose`, `scanWords`),
 * so the scan is named for what it reads and says what it found.
 */
type CameraModule = {
  Camera?: React.ComponentType<Record<string, unknown>>;
  CameraType?: { Back?: unknown };
};

function loadCamera(): CameraModule | null {
  return BrowserCamera.cameraSupported() ? BrowserCamera : null;
}

/**
 * camera-kit's own module, which asks iOS for the camera: whether it may be
 * used (true, false, or -1 while it has never been asked), and asking.
 */
interface CameraAuthorization {
  checkDeviceCameraAuthorizationStatus: () => Promise<boolean | number>;
  requestDeviceCameraAuthorization: () => Promise<boolean>;
}

/** That module, or null in a build without it, as under Jest. */
export function cameraAuthorization(): CameraAuthorization | null {
  return null;
}

/**
 * What the camera can do: being asked for, reading, switched off by the
 * user, or absent from this build.
 */
export type CameraAccess = 'checking' | 'granted' | 'denied' | 'missing';

/**
 * The access a scanner starts with. Android asks at runtime, so it starts
 * out asking; iOS asks when the camera mounts, and reports a refusal as an
 * error from it.
 */
export function firstAccess(): CameraAccess {
  if (!loadCamera()?.Camera) return 'missing';
  return 'granted';
}

/** The corners' arm length, stroke and bend (REDESIGN.md 5, Scan reveal). */
const ARM = 28;
const STROKE = 3;
const BEND = 8;
/** The corners' dashes while the camera is being asked for. */
const DASH = [3, 6];
/** The corners set off this long after the scanner mounts, 40ms apart. */
const FLY_DELAY = 200;
const FLY_STAGGER = 40;
/** One breath while reading, in to .97 and out again. */
const BREATH_MS = 2400;
const BREATH_SCALE = 0.97;
/** A code that can be paid pulls the corners in to this. */
export const CAUGHT_SCALE = 0.85;
/** How long the caught corners hold before they go with the disc. */
export const CAUGHT_HOLD = 160;
/** How long the cover over a camera just mounted takes to fade away. */
const COVER_MS = 300;
/**
 * The same unpayable code buzzes, shakes and is said at most once in this
 * long; each read of it still flashes.
 */
export const REFUSAL_QUIET_MS = 1500;
/** Reduce Motion's stand-in for a shake: a radish tint held this long. */
export const TINT_MS = 400;
/** The round controls, at the minimum comfortable size and then some. */
const CONTROL = 56;

/** Fades that still run under Reduce Motion, since they move nothing. */
const FADE = {
  duration: durations.crossfade,
  easing: curves.standard,
  reduceMotion: ReduceMotion.Never,
};
const EXIT = { duration: durations.exit, easing: curves.exit };

/**
 * Why `value` cannot be paid, as a screen reader hears it, or null when it
 * can. A code the parser reads but refuses, such as an LNURL, is refused here
 * too, with the parser's own reason after ours.
 */
export function refusal(value: string): string | null {
  const parsed = parsePayment(value);
  if (parsed.kind === 'empty') return copy.scan.invalid;
  if (parsed.kind === 'invalid') {
    return [copy.scan.invalid, parsed.message].filter(Boolean).join(' ');
  }
  return null;
}

/** Keep only the distinct payable codes in the selected image. */
function paymentFromImage(
  codes: string[],
): { value: string } | { reason: string } {
  const distinct = [...new Set(codes.map(code => code.trim()).filter(Boolean))];
  let value: string | undefined;
  let reason: string = copy.scan.noImageCode;
  for (const code of distinct) {
    const invalid = refusal(code);
    if (invalid) reason = invalid;
    else if (value) return { reason: copy.scan.severalImageCodes };
    else value = code;
  }
  return value ? { value } : { reason };
}

/**
 * What the scanner says for a scan of `purpose`, none of it drawn: its
 * name, what the reticle tells a screen reader the camera is for, what to do
 * with the camera off, what is said as a code is found, and what a check
 * that refuses a code without a reason of its own says.
 */
export interface ScanWords {
  title: string;
  privacy: string;
  noCamera: string;
  missingHint: string;
  detected: string;
  invalid: string;
}

const WORDS: Record<ScanPurpose, ScanWords> = {
  payment: {
    title: copy.scan.title,
    privacy: copy.scan.privacy,
    noCamera: copy.scan.noCamera,
    missingHint: copy.scan.missingHint,
    detected: copy.scan.detected,
    invalid: copy.scan.invalid,
  },
  primary: {
    title: copy.scan.primaryTitle,
    privacy: copy.scan.primaryPrivacy,
    noCamera: copy.scan.primaryNoCamera,
    missingHint: copy.scan.missingFieldHint,
    detected: copy.scan.primaryDetected,
    invalid: copy.scan.primaryInvalid,
  },
  address: {
    title: copy.scan.addressTitle,
    privacy: copy.scan.addressPrivacy,
    noCamera: copy.scan.addressNoCamera,
    missingHint: copy.scan.missingFieldHint,
    detected: copy.scan.addressDetected,
    invalid: copy.scan.addressInvalid,
  },
};

/**
 * The words for a scan of `purpose`, a payment request unless given. The
 * same object each time, so the reticle, which takes them, draws again only
 * when what it says changes.
 */
export function scanWords(purpose: ScanPurpose = 'payment'): ScanWords {
  return WORDS[purpose];
}

/** The last unpayable code the camera read, and when it last buzzed. */
export interface Refused {
  value: string;
  at: number;
}

/**
 * Whether an unpayable read buzzes, shakes and is said. A code held in view
 * is read again every 600ms, so the same one only complains again after
 * REFUSAL_QUIET_MS; a different one complains at once.
 */
export function shouldRefuse(
  last: Refused | null,
  value: string,
  now: number,
): boolean {
  return !last || last.value !== value || now - last.at >= REFUSAL_QUIET_MS;
}

/** The reticle's side for a surface `width` by `height` points. */
export function reticleSide(width: number, height: number): number {
  return Math.round(
    Math.min(280, Math.max(200, 0.68 * Math.min(width, height))),
  );
}

/**
 * How far along its own diagonal each corner flies in from, per axis, for a
 * reticle `side` points wide centred in the surface: from where the diagonal
 * meets the nearest edge, which is where the growing disc's rim is by the
 * time the corners set off.
 */
export function flight(width: number, height: number, side: number): number {
  return Math.max(0, Math.min(width - side, height - side) / 2);
}

/**
 * The next quarter turn at or past `degrees`. The reticle looks the same at
 * every one, so a spin stops there without a jump.
 */
export function settleTurn(degrees: number): number {
  'worklet';
  return Math.ceil(degrees / 90) * 90;
}

export type ReticleMode = 'checking' | 'waiting' | 'scanning';

/**
 * Which loops the reticle runs (REDESIGN.md 5 and 8): it turns while the
 * camera is asked for and breathes while it reads, never while the app is in
 * the background, and under Reduce Motion it holds still.
 */
export function reticleLoops(
  mode: ReticleMode,
  reduced: boolean,
  running: boolean,
): { spin: boolean; breathe: boolean } {
  const moving = running && !reduced;
  return {
    spin: moving && mode === 'checking',
    breathe: moving && mode === 'scanning',
  };
}

/**
 * One corner, bending at (x, y), its arms running ARM points along `dx` and
 * `dy`. Inset by half the stroke, so a corner drawn in an ARM box fits it.
 */
export function cornerPath(
  x: number,
  y: number,
  dx: 1 | -1,
  dy: 1 | -1,
): string {
  const inset = STROKE / 2;
  const ax = x + dx * inset;
  const ay = y + dy * inset;
  const reach = ARM - STROKE;
  const sweep = dx * dy > 0 ? 1 : 0;
  return (
    `M${ax} ${ay + dy * reach}V${ay + dy * BEND}` +
    `A${BEND} ${BEND} 0 0 ${sweep} ${ax + dx * BEND} ${ay}H${ax + dx * reach}`
  );
}

/**
 * The corners in the order they fly in, top left then clockwise, each with
 * the way its arms run and where it sits in the reticle.
 */
const CORNERS = [
  { dx: 1, dy: 1, at: { left: 0, top: 0 } },
  { dx: -1, dy: 1, at: { right: 0, top: 0 } },
  { dx: -1, dy: -1, at: { right: 0, bottom: 0 } },
  { dx: 1, dy: -1, at: { left: 0, bottom: 0 } },
] as const;

/** All four corners of a reticle `side` points wide, as one path. */
function reticlePath(side: number): string {
  return CORNERS.map(({ dx, dy }) =>
    cornerPath(dx > 0 ? 0 : side, dy > 0 ? 0 : side, dx, dy),
  ).join('');
}

/**
 * Slate's night, the ground's corners on a test network: the step from roast
 * toward slate the canvas's own test glow takes, deep and quiet. Slate's
 * half step, a mid grey, ringed a near black middle and read as fog on dirty
 * glass rather than as a night (P10, 52-scan-reveal-sheet).
 */
export const SLATE_NIGHT = mixHex(palette.roast, palette.slate, 0.2);

/**
 * The ground the scan opens onto: roast at the centre, deepening to the
 * bloom's night at the corners, or on a test network to slate's (`test`,
 * REDESIGN.md 3.1), so play money never scans on mainnet's colour. The
 * overlay's disc reveals it, and the same ground covers a camera just
 * mounted and fades off it, so the handover from disc to camera shows no
 * seam.
 */
export const ScanGround = memo(function ScanGroundSvg({
  width,
  height,
  test = false,
}: {
  width: number;
  height: number;
  test?: boolean;
}) {
  return (
    <Svg
      width={width}
      height={height}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Defs>
        <RadialGradient
          id="scan-ground"
          cx={width / 2}
          cy={height / 2}
          r={Math.hypot(width, height) / 2}
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset="0" stopColor={palette.roast} />
          <Stop offset="0.45" stopColor={palette.roast} />
          <Stop
            offset="1"
            stopColor={test ? SLATE_NIGHT : palette.bloomNight}
          />
        </RadialGradient>
      </Defs>
      <Rect width={width} height={height} fill="url(#scan-ground)" />
    </Svg>
  );
});
ScanGround.displayName = 'ScanGround';

/**
 * What the reticle is told when a code is read, as shared values, so a code
 * caught in the same tick as the overlay closes still shows on the way out.
 * `caught` is 1 once a payable code is read; the exits read it.
 */
interface Cues {
  caught: SharedValue<number>;
  sage: SharedValue<number>;
  radish: SharedValue<number>;
  nudge: SharedValue<number>;
  pinch: SharedValue<number>;
}

/** A shared value as an exit reads it, once, as the exit starts. */
type Reading = Pick<SharedValue<number>, 'get'>;

/**
 * The reticle leaving, from wherever its shake, turn and breath have it, so
 * it does not jump as it goes. A caught code holds the corners pulled in for
 * a beat, sage, before they fade; anything else fades them at once.
 */
export function reticleOut(
  cues: { caught: Reading; pinch: Reading; nudge: Reading },
  pose: { turn: Reading; breath: Reading },
  reduced: boolean,
): EntryExitAnimationFunction {
  return () => {
    'worklet';
    if (reduced) {
      return {
        initialValues: { opacity: 1 },
        animations: { opacity: withTiming(0, FADE) },
      };
    }
    const scale = pose.breath.get() * cues.pinch.get();
    const rotate = `${pose.turn.get()}deg`;
    const initialValues = {
      opacity: 1,
      transform: [{ translateX: cues.nudge.get() }, { rotate }, { scale }],
    };
    const still = withTiming(0, EXIT);
    const turned = withTiming(rotate, EXIT);
    if (cues.caught.get() === 1) {
      return {
        initialValues,
        animations: {
          transform: [
            { translateX: still },
            { rotate: turned },
            { scale: withSpring(CAUGHT_SCALE, springs.snap) },
          ],
          opacity: withDelay(CAUGHT_HOLD, withTiming(0, EXIT)),
        },
      };
    }
    return {
      initialValues,
      animations: {
        transform: [
          { translateX: still },
          { rotate: turned },
          { scale: withTiming(scale * 0.98, EXIT) },
        ],
        opacity: withTiming(0, EXIT),
      },
    };
  };
}

/** The sage corners, which a caught code turns on as the scan closes. */
function sageOut(cues: {
  caught: Reading;
  sage: Reading;
}): EntryExitAnimationFunction {
  return () => {
    'worklet';
    return {
      initialValues: { opacity: cues.sage.get() },
      animations: {
        opacity: withTiming(cues.caught.get() === 1 ? 1 : 0, {
          duration: durations.tick,
          easing: curves.standard,
          reduceMotion: ReduceMotion.Never,
        }),
      },
    };
  };
}

const svgHidden = {
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

/**
 * One corner, flying in along its own diagonal from `from` points out, the
 * `index`th of four. Under Reduce Motion it fades in where it belongs.
 */
const Corner = memo(function CornerMark({
  index,
  dx,
  dy,
  at,
  from,
  mode,
  reduced,
}: {
  index: number;
  dx: 1 | -1;
  dy: 1 | -1;
  at: (typeof CORNERS)[number]['at'];
  from: number;
  mode: ReticleMode;
  reduced: boolean;
}) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.set(
      reduced
        ? withTiming(1, FADE)
        : steady(
            withDelay(
              FLY_DELAY + index * FLY_STAGGER,
              withTiming(1, { duration: durations.move, easing: curves.enter }),
            ),
          ),
    );
  }, [progress, reduced, index]);
  const style = useAnimatedStyle(() => {
    const shown = progress.get();
    const away = reduced ? 0 : (1 - shown) * from;
    return {
      opacity: shown,
      transform: [{ translateX: -dx * away }, { translateY: -dy * away }],
    };
  }, [reduced, from, dx, dy]);
  const checking = mode === 'checking';
  return (
    <Reanimated.View style={[styles.corner, at, style]}>
      <Svg width={ARM} height={ARM} {...svgHidden}>
        <Path
          d={cornerPath(dx > 0 ? 0 : ARM, dy > 0 ? 0 : ARM, dx, dy)}
          fill="none"
          stroke={checking ? palette.steam : palette.cream}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={checking ? DASH : undefined}
        />
      </Svg>
    </Reanimated.View>
  );
});
Corner.displayName = 'Corner';

/**
 * The four corners that mark where to aim, and the whole of what the scanner
 * says while it reads: its label is the instruction the screen used to print.
 */
const Reticle = memo(function ReticleMarks({
  mode,
  side,
  from,
  reduced,
  running,
  cues,
  words,
}: {
  words: ScanWords;
  mode: ReticleMode;
  side: number;
  from: number;
  reduced: boolean;
  running: boolean;
  cues: Cues;
}) {
  const turn = useSharedValue(0);
  const breath = useSharedValue(1);
  const { spin, breathe } = reticleLoops(mode, reduced, running);

  useEffect(() => {
    if (!spin) {
      turn.set(withSpring(settleTurn(turn.get()), springs.snap));
      return;
    }
    const start = turn.get();
    turn.set(
      withRepeat(
        withTiming(start + 360, {
          duration: durations.dashRotate,
          easing: curves.linear,
        }),
        -1,
      ),
    );
    return () => cancelAnimation(turn);
  }, [spin, turn]);

  useEffect(() => {
    if (!breathe) {
      breath.set(withTiming(1, { duration: durations.exit }));
      return;
    }
    breath.set(
      withRepeat(
        withTiming(BREATH_SCALE, {
          duration: BREATH_MS / 2,
          easing: curves.sine,
        }),
        -1,
        true,
      ),
    );
    return () => cancelAnimation(breath);
  }, [breathe, breath]);

  const group = useAnimatedStyle(() => ({
    transform: [
      { translateX: cues.nudge.get() },
      { rotate: `${turn.get()}deg` },
      { scale: breath.get() * cues.pinch.get() },
    ],
  }));
  const sage = useAnimatedStyle(() => ({ opacity: cues.sage.get() }));
  const radish = useAnimatedStyle(() => ({ opacity: cues.radish.get() }));
  const exiting = useMemo(
    () => reticleOut(cues, { turn, breath }, reduced),
    [cues, turn, breath, reduced],
  );
  const sageExit = useMemo(() => sageOut(cues), [cues]);
  const path = useMemo(() => reticlePath(side), [side]);
  const tint = (color: string) => (
    <Svg width={side} height={side} {...svgHidden}>
      <Path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );

  return (
    <Reanimated.View
      accessible
      accessibilityRole="image"
      accessibilityLabel={copy.scan.aim}
      accessibilityHint={words.privacy}
      accessibilityValue={
        mode === 'checking' ? { text: copy.scan.starting } : undefined
      }
      accessibilityState={{ busy: mode === 'checking' }}
      exiting={exiting}
      style={[{ width: side, height: side }, group]}
    >
      {/* Held, it whispers what it asks (REDESIGN.md rule 3). Inside the
          reticle, so its own exit is left as it is. */}
      <Whisper
        label={[copy.scan.aim, mode === 'checking' ? copy.scan.starting : '']
          .filter(Boolean)
          .join(' ')}
        style={styles.fill}
      >
        {CORNERS.map(({ dx, dy, at }, index) => (
          <Corner
            key={index}
            index={index}
            dx={dx}
            dy={dy}
            at={at}
            from={from}
            mode={mode}
            reduced={reduced}
          />
        ))}
        <Reanimated.View pointerEvents="none" style={[styles.fill, radish]}>
          {tint(palette.radish)}
        </Reanimated.View>
        <Reanimated.View
          pointerEvents="none"
          exiting={sageExit}
          style={[styles.fill, sage]}
        >
          {tint(palette.sage)}
        </Reanimated.View>
      </Whisper>
    </Reanimated.View>
  );
});
Reticle.displayName = 'Reticle';

/**
 * A round glyph control. `refused` counts the times its action was turned
 * down, each one a radish ring and a shake (a held tint under Reduce Motion),
 * and says why in its value.
 */
function GlyphButton({
  glyph,
  label,
  onPress,
  reduced,
  refused,
  buttonRef,
}: {
  glyph: GlyphName;
  label: string;
  onPress: () => void | Promise<void>;
  reduced: boolean;
  refused?: { count: number; reason: string };
  buttonRef?: React.Ref<React.ComponentRef<typeof View>>;
}) {
  const reasonId = useId();
  const press = useSharedValue(1);
  const nudge = useSharedValue(0);
  const ring = useSharedValue(0);
  const count = refused?.count ?? 0;
  useEffect(() => {
    if (!count) return;
    if (reduced) {
      ring.set(
        withSequence(
          withTiming(1, { ...FADE, duration: durations.tick }),
          withDelay(TINT_MS, withTiming(0, FADE), ReduceMotion.Never),
        ),
      );
      return;
    }
    ring.set(
      withSequence(
        withTiming(1, { duration: durations.tick }),
        withTiming(0, { duration: durations.draw }),
      ),
    );
    nudge.set(shake());
  }, [count, reduced, ring, nudge]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: nudge.get() }, { scale: press.get() }],
  }));
  const ringStyle = useAnimatedStyle(() => ({ opacity: ring.get() }));
  const to = (value: number) =>
    press.set(reduced ? 1 : withSpring(value, springs.snap));
  return (
    <Reanimated.View style={style}>
      <div title={refused?.reason || label}>
        {refused?.reason ? <span id={reasonId} hidden>{refused.reason}</span> : null}
        <Pressable
          ref={buttonRef}
          accessibilityRole="button"
          accessibilityLabel={label}
          aria-describedby={refused?.reason ? reasonId : undefined}
          hitSlop={HIT_SLOP}
          onPressIn={() => to(0.94)}
          onPressOut={() => to(1)}
          onPress={() => {
            haptics.tick();
            return onPress();
          }}
          style={styles.control}
        >
          <Glyph name={glyph} size={24} color={palette.cream} />
          <Reanimated.View
            pointerEvents="none"
            style={[styles.ring, ringStyle]}
          />
        </Pressable>
      </div>
    </Reanimated.View>
  );
}

/**
 * The camera cannot be used: `cameraOff`, steam when the user switched it
 * off and dust when this build has no camera at all. A long press whispers
 * why (REDESIGN.md rule 3).
 */
function CameraOff({
  access,
  words,
}: {
  access: 'denied' | 'missing';
  words: ScanWords;
}) {
  const denied = access === 'denied';
  const label = denied ? copy.scan.denied : copy.scan.missing;
  return (
    <Whisper label={label}>
      <Reanimated.View
        entering={riseIn(overlap.rise, overlap.enterDelay)}
        exiting={sceneOut()}
        accessible
        accessibilityRole="image"
        accessibilityLabel={label}
        accessibilityHint={denied ? words.noCamera : words.missingHint}
        style={styles.status}
      >
        <Glyph
          name="cameraOff"
          size={40}
          color={denied ? palette.steam : palette.dust}
        />
      </Reanimated.View>
    </Whisper>
  );
}

/** The flask's size, as the status row draws it beside the mark. */
const FLASK = 14;

/**
 * A test network, while the scan covers the status row that says so
 * (REDESIGN.md rule 4): the slate flask, at the page edge in the status
 * row's band, rising in with the controls. It is drawing; the canvas says
 * the network to a screen reader.
 */
function TestFlask({ top }: { top: number }) {
  return (
    <Reanimated.View
      testID="scan-flask"
      pointerEvents="none"
      entering={riseIn(overlap.rise, FLY_DELAY)}
      exiting={sceneOut()}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.flask, { top: top + (STATUS_ROW - FLASK) / 2 }]}
    >
      <Glyph name="flask" size={FLASK} color={palette.slate} />
    </Reanimated.View>
  );
}

export function Scanner({
  onDetected,
  validate,
  purpose = 'payment',
  onCancel,
  live = true,
  onAccess,
  test = false,
}: {
  onDetected: (value: string, source: ScanSource) => void;
  validate?: (value: string) => string;
  /**
   * What the scan is for: a payment request, a primary node's address, or
   * a Bitcoin address to empty the wallet to. Only the words follow it; what
   * a code must be is `validate`'s, and a payment request without one.
   */
  purpose?: ScanPurpose;
  onCancel: () => void;
  /**
   * Whether the camera may mount. The scan overlay holds it back until its
   * disc has opened, because Android's camera preview ignores the disc's
   * clip, alpha and scale. Drawn on its own, the scanner starts at once.
   */
  live?: boolean;
  /** Told what the camera can do, so the overlay can open only partway. */
  onAccess?: (access: CameraAccess) => void;
  /**
   * A wallet on a test network: the ground is slate's night, and a flask
   * stands in for the status row's, which the scan covers.
   */
  test?: boolean;
}) {
  const lib = loadCamera();
  const Camera = lib?.Camera;
  const words = scanWords(purpose);
  const [access, setAccess] = useState<CameraAccess>(firstAccess);
  const { reduced } = useMotionPrefs();
  const foreground = useAppActive();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [measured, setMeasured] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const { width, height } = measured ?? window;
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width: w, height: h } = event.nativeEvent.layout;
    setMeasured(last =>
      last && last.width === w && last.height === h
        ? last
        : { width: w, height: h },
    );
  }, []);

  // One code, once. A second frame carrying the same request must not stack
  // another Send on top of the one already opening.
  const claimed = useRef(false);
  const refused = useRef<Refused | null>(null);
  const [pasteRefused, setPasteRefused] = useState({ count: 0, reason: '' });

  const [imageRefused, setImageRefused] = useState({ count: 0, reason: '' });
  const photoButton = useRef<React.ComponentRef<typeof View>>(null);
  const pendingImage = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingImage.current?.abort();
    };
  }, []);
  const manual = useRef<'photo' | 'clipboard' | null>(null);
  const [picking, setPicking] = useState(false);
  // Deliver a file only to the open scanner after its wallet is visible again.
  const [imageResult, setImageResult] = useState<
    ReturnType<typeof paymentFromImage> | 'cancelled' | null
  >(null);

  const caught = useSharedValue(0);
  const sage = useSharedValue(0);
  const radish = useSharedValue(0);
  const nudge = useSharedValue(0);
  const pinch = useSharedValue(1);
  const cues = useMemo<Cues>(
    () => ({ caught, sage, radish, nudge, pinch }),
    [caught, sage, radish, nudge, pinch],
  );

  useEffect(() => {
    onAccess?.(access);
  }, [access, onAccess]);

  // A camera found to be off changes the screen under a screen reader, which
  // would otherwise not hear of it.
  useEffect(() => {
    if (access === 'denied') announce(copy.scan.denied);
  }, [access]);

  // A screen reader lands on the scan as it opens (REDESIGN.md 9), where its
  // name is, rather than staying on the button that opened it.
  const title = useRef<React.ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (title.current) {
      focusOn(title.current);
    }
  }, []);

  const cameraOn = live && !picking && access === 'granted' && !!Camera;
  const cover = useSharedValue(1);
  useEffect(() => {
    if (!cameraOn) {
      cover.set(1);
      return;
    }
    cover.set(withTiming(0, reduced ? FADE : { ...FADE, duration: COVER_MS }));
  }, [cameraOn, reduced, cover]);
  const coverStyle = useAnimatedStyle(() => ({ opacity: cover.get() }));

  const take = useCallback(
    (value: string, source: ScanSource) => {
      if (!mounted.current || claimed.current) return;
      claimed.current = true;
      caught.set(1);
      sage.set(withTiming(1, { ...FADE, duration: durations.tick }));
      if (!reduced) pinch.set(withSpring(CAUGHT_SCALE, springs.snap));
      haptics.thud();
      announce(words.detected);
      onDetected(
        validate ? validate(value) : normalizePaymentLink(value) || value,
        source,
      );
    },
    [caught, sage, reduced, pinch, onDetected, validate, words],
  );

  // Every refused read flashes the corners radish. Only a loud one shakes
  // them too, and Reduce Motion holds the tint a while instead of shaking.
  function flash(loud: boolean) {
    if (reduced) {
      radish.set(
        withSequence(
          withTiming(1, { ...FADE, duration: durations.tick }),
          withDelay(TINT_MS, withTiming(0, FADE), ReduceMotion.Never),
        ),
      );
      return;
    }
    radish.set(
      withSequence(
        withTiming(1, { duration: durations.tick }),
        withTiming(0, { duration: durations.draw }),
      ),
    );
    if (loud) nudge.set(shake());
  }

  function validationError(value: string): string | null {
    if (!validate) return refusal(value);
    try {
      validate(value);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : words.invalid;
    }
  }

  function read(raw: string | undefined) {
    const value = raw?.trim();
    if (!mounted.current || claimed.current || manual.current || !value) return;
    const reason = validationError(value);
    if (!reason) {
      take(value, 'camera');
      return;
    }
    const now = Date.now();
    const loud = shouldRefuse(refused.current, value, now);
    if (loud) {
      refused.current = { value, at: now };
      haptics.error();
      announce(reason);
    }
    flash(loud);
  }

  function refuseInput(reason: string, source: 'clipboard' | 'photo') {
    haptics.error();
    announce(reason);
    const setRefused = source === 'photo' ? setImageRefused : setPasteRefused;
    setRefused(last => ({ count: last.count + 1, reason }));
  }

  async function paste() {
    if (claimed.current || manual.current) return;
    manual.current = 'clipboard';
    try {
      const value = (
        await duringSystemPrompt(() => Clipboard.getString())
      )?.trim();
      if (!mounted.current) return;
      if (!value) {
        refuseInput(copy.scan.clipboardEmpty, 'clipboard');
        return;
      }
      const reason = validationError(value);
      if (reason) refuseInput(reason, 'clipboard');
      else take(value, 'clipboard');
    } catch {
      if (mounted.current)
        refuseInput(copy.scan.clipboardUnreadable, 'clipboard');
    } finally {
      manual.current = null;
    }
  }

  async function chooseImage() {
    if (claimed.current || manual.current) return;
    manual.current = 'photo';
    setPicking(true);
    const controller = new AbortController();
    pendingImage.current = controller;
    try {
      const codes = await pickQrImage(controller.signal);
      if (mounted.current)
        setImageResult(codes === null ? 'cancelled' : paymentFromImage(codes));
    } catch {
      if (mounted.current)
        setImageResult({ reason: copy.scan.unreadableImage });
    } finally {
      pendingImage.current = null;
    }
  }

  useEffect(() => {
    if (!imageResult || !foreground || manual.current !== 'photo') return;
    manual.current = null;
    setImageResult(null);
    setPicking(false);
    if (imageResult !== 'cancelled') {
      if ('value' in imageResult) {
        take(imageResult.value, 'photo');
        return;
      }
      refuseInput(imageResult.reason, 'photo');
    }
    focusOn(photoButton.current);
  }, [imageResult, foreground, take]);

  const openSettings = () => {
    announce('Enable camera access in your browser site settings, then try again.');
    setAccess(BrowserCamera.cameraSupported() ? 'granted' : 'missing');
  };

  const side = reticleSide(width, height);
  const fallback = access === 'denied' || access === 'missing';
  const mode: ReticleMode =
    access === 'checking' ? 'checking' : cameraOn ? 'scanning' : 'waiting';

  const controls = (
    <Reanimated.View
      entering={riseIn(overlap.rise, FLY_DELAY)}
      exiting={sceneOut()}
      style={[styles.controls, access === 'denied' && styles.compactControls]}
    >
      <GlyphButton
        glyph="clipboard"
        label={copy.scan.paste}
        onPress={paste}
        reduced={reduced}
        refused={pasteRefused}
      />
      {purpose === 'payment' ? (
        <Whisper
          enabled={!!imageRefused.reason}
          label={imageRefused.reason || copy.scan.chooseImage}
        >
          <GlyphButton
            glyph="photo"
            label={copy.scan.chooseImage}
            onPress={chooseImage}
            buttonRef={photoButton}
            reduced={reduced}
            refused={imageRefused}
          />
        </Whisper>
      ) : null}
      {access === 'denied' ? (
        <GlyphButton
          glyph="cog"
          label="Try camera again"
          onPress={openSettings}
          reduced={reduced}
        />
      ) : null}
      <GlyphButton
        glyph="close"
        label={copy.scan.close}
        onPress={onCancel}
        reduced={reduced}
      />
    </Reanimated.View>
  );

  return (
    <View style={styles.surface} onLayout={onLayout}>
      {cameraOn && Camera ? (
        <View style={styles.fill}>
          <Camera
            scanBarcode
            allowedBarcodeTypes={['qr']}
            scanThrottleDelay={600}
            cameraType={lib?.CameraType?.Back}
            style={styles.fill}
            onReadCode={(event: {
              nativeEvent?: { codeStringValue?: string };
            }) => read(event?.nativeEvent?.codeStringValue)}
            onError={() => setAccess('denied')}
          />
          <Reanimated.View
            pointerEvents="none"
            style={[styles.fill, coverStyle]}
          >
            <ScanGround width={width} height={height} test={test} />
          </Reanimated.View>
        </View>
      ) : null}
      {test ? <TestFlask top={insets.top} /> : null}
      <View
        pointerEvents="box-none"
        style={[
          styles.body,
          {
            paddingTop: insets.top + space.xl,
            paddingBottom: insets.bottom + space.xl,
          },
        ]}
      >
        <View
          ref={title}
          accessible
          accessibilityRole="header"
          accessibilityLabel={
            access === 'denied' ? copy.scan.camera : words.title
          }
          style={styles.title}
        />
        <View pointerEvents="box-none" style={styles.stage}>
          {fallback ? (
            <>
              <CameraOff access={access} words={words} />
              {controls}
            </>
          ) : (
            <Reticle
              words={words}
              mode={mode}
              side={side}
              from={flight(width, height, side)}
              reduced={reduced}
              running={foreground}
              cues={cues}
            />
          )}
        </View>
        {fallback ? null : controls}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1 },
  fill: StyleSheet.absoluteFill,
  body: { flex: 1, paddingHorizontal: space.xl },
  // A point rather than nothing: a screen reader passes over an element with
  // no size at all.
  title: { position: 'absolute', top: 0, left: 0, width: 1, height: 1 },
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xxl,
  },
  corner: { position: 'absolute', width: ARM, height: ARM },
  flask: { position: 'absolute', left: space.xl },
  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.xl,
  },
  compactControls: { gap: space.xs },
  control: {
    width: CONTROL,
    height: CONTROL,
    borderRadius: CONTROL / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.cocoa,
  },
  ring: {
    ...StyleSheet.absoluteFill,
    borderRadius: CONTROL / 2,
    borderWidth: 2,
    borderColor: palette.radish,
  },
  status: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.mocha,
  },
});
