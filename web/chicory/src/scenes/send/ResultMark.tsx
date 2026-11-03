import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ComponentRef, ReactNode, Ref } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { HostInstance } from 'react-native';
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
import Svg, { Circle } from 'react-native-svg';
import { Glyph } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { Whisper } from '../../glyphs/Whisper';
import { popIn, useShake } from '../../motion/effects';
import { useLoop, wave } from '../../motion/loops';
import { fadeIn, fadeOut } from '../../motion/presets';
import { steady } from '../../motion/steady';
import { curves, durations, springs } from '../../motion/tokens';
import { motionReduced } from '../../services/motion';
import { usePaneActive } from '../../stage/panes/Pane';
import {
  CHECK_LEAD,
  CLOSE_MS,
  FILL_MS,
  MARK,
  arrivalBeats,
  travelPose,
  watchCentre,
} from './arrival';
import type { Arrival, ArrivalBeats } from './arrival';
import { COMET, Comet } from './Comet';
import { CONTROL } from './Controls';
import { BANG, DrawnGlyph } from './DrawnGlyph';
import type { Stroke } from './DrawnGlyph';
import type { ResultVisual } from './model';
import { Orbit } from './Orbit';
import { useBloom } from './tone';

const SIZE = MARK;
const STROKE = 5;

/**
 * The orbit of a held payment still under way, on a track of its own inside
 * the honey ring, a clear gap in from it, in cream at part strength. Drawn
 * on the ring itself, honey on honey, it could not be seen, and a payment
 * still going out looked exactly like one whose outcome is unknown (P12,
 * 06d4).
 */
export const HELD_ORBIT = { stroke: 3, gap: 4, alpha: 0.6 };
/** Across the held orbit's outer edge, just inside the ring and its gap. */
const HELD_ORBIT_SIZE = SIZE - 2 * (STROKE + HELD_ORBIT.gap);

/**
 * How big the disc starts as the held ring, or the orbit, resolves into it:
 * the ring's inside, so it grows out of the ring as the ring fades. Both
 * are drawn on the same ring.
 */
export const RESOLVE_FROM = (SIZE - 2 * STROKE) / SIZE;

/**
 * How long the held ring or the orbit takes to fade as the face after it
 * comes up: as long as anything leaving takes, or half a crossfade under
 * Reduce Motion, as `fadeOut` would have faded it.
 */
export const resolveOutMs = () =>
  motionReduced() ? durations.crossfade / 2 : durations.exit;

/**
 * The hold's look, grown with the mark: its 4pt ring and the comet's 6pt
 * head, each the hold's own size where the mark sets out at the hold's.
 */
const DEPART = {
  ring: (4 * SIZE) / CONTROL,
  head: (COMET.head * SIZE) / CONTROL,
};

/**
 * How long a mark that is growing out of the hold waits to be placed before
 * it is drawn where it rests regardless, so no mark is ever left unseen.
 */
export const PLACE_LATEST = 300;

/** The pause bars pop in one after the other, then hold still. */
const PAUSE: Stroke[] = [
  { pop: { x: 9, y: 12 } },
  { pop: { x: 15, y: 12 }, delay: 60 },
];

/** `strokes`, each beginning `lead` ms later than it would. */
const after = (lead: number, strokes: Stroke[]): Stroke[] =>
  lead ? strokes.map(s => ({ ...s, delay: (s.delay ?? 0) + lead })) : strokes;

/** A still ring round the mark, in `color`, `stroke` wide. */
function Ring({ color, stroke = STROKE }: { color: string; stroke?: number }) {
  return (
    <Svg width={SIZE} height={SIZE} style={styles.layer}>
      <Circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={(SIZE - stroke) / 2}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
      />
    </Svg>
  );
}

interface FaceProps {
  visual: ResultVisual;
  /** When the face's glyph begins, in ms from its mount. */
  lead: number;
  /** The done disc's cream, 0 to 1: it fills as a landing mark closes. */
  fill: SharedValue<number>;
}

/**
 * Done: a cream disc, and the visual's glyph drawing across it in ink, the
 * check for a payment that settled and a clock for one broadcast on chain.
 * At rest, for a payment seen before, the glyph is simply there. Landing
 * from the hold, the cream fills the ring the comet has closed before the
 * glyph draws.
 */
function Disc({ visual, lead, fill }: FaceProps) {
  const cream = useAnimatedStyle(() => ({ opacity: fill.get() }));
  return (
    <View style={styles.disc}>
      <Reanimated.View style={[styles.cream, cream]} />
      {visual.resting ? (
        <Glyph name={visual.glyph} size={56} color={palette.ink} />
      ) : (
        <DrawnGlyph
          name={visual.glyph}
          size={56}
          color={palette.ink}
          strokes={[{ duration: durations.draw, delay: lead }]}
        />
      )}
    </View>
  );
}

/**
 * On its way: an orbit round the visual's glyph, slate on a test network.
 * The arrow that left for a Lightning payment, and the rail's own glyph for
 * one to a Bitcoin address whose transaction is still being broadcast.
 */
function Moving({ visual }: FaceProps) {
  const bloom = useBloom();
  return (
    <>
      <Ring color={palette.husk} />
      <Orbit size={SIZE} stroke={STROKE} color={bloom.tone} />
      <Glyph name={visual.glyph} size={44} color={bloom.tone} />
    </>
  );
}

/**
 * A face another one comes up over, kept under it while it fades: the held
 * ring, with whether its orbit runs, or the orbit, with the glyph it ran
 * round. Kept as it was drawn, so the face after it never shows through.
 */
interface Kept {
  shape: 'held' | 'orbit';
  orbit: boolean;
  glyph: GlyphName;
}

const keptOf = (visual: ResultVisual): Kept | null =>
  visual.shape === 'held' || visual.shape === 'orbit'
    ? { shape: visual.shape, orbit: !!visual.orbit, glyph: visual.glyph }
    : null;

const sameKept = (a: Kept | null, b: Kept | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.shape === b.shape &&
    a.orbit === b.orbit &&
    a.glyph === b.glyph);

/**
 * Held: a steady honey ring, a halo breathing round it and the pause bars.
 * Nothing about it moves toward done, because nothing is known to be. While
 * the payment is still under way an orbit runs just inside the ring, in
 * cream against its honey, the motion that says money is moving (REDESIGN.md
 * 3.5), and never rests. An outcome that is unknown has none.
 */
function Held({ visual, lead }: FaceProps) {
  // Out and back once each 1600ms.
  const halo = useLoop(durations.halo, true);
  const haloStyle = useAnimatedStyle(() => {
    const out = wave(halo.get());
    return {
      opacity: 0.15 + 0.35 * out,
      transform: [{ scale: 1.04 + 0.08 * out }],
    };
  });
  return (
    <>
      <Reanimated.View style={[styles.layer, styles.halo, haloStyle]} />
      <Ring color={palette.honey} />
      {visual.orbit ? (
        <View style={[styles.layer, styles.centred]}>
          <View style={styles.inside}>
            <Orbit
              size={HELD_ORBIT_SIZE}
              stroke={HELD_ORBIT.stroke}
              color={palette.cream}
              alpha={HELD_ORBIT.alpha}
            />
          </View>
        </View>
      ) : null}
      <DrawnGlyph
        name="pause"
        size={48}
        color={palette.honey}
        strokes={after(lead, PAUSE)}
      />
    </>
  );
}

/** Failed: a radish outline, and a bang drawing in. */
function Broken({ lead }: FaceProps) {
  return (
    <>
      <Ring color={palette.radish} />
      <DrawnGlyph
        name="bang"
        size={48}
        color={palette.radish}
        strokes={after(lead, BANG)}
      />
    </>
  );
}

/**
 * The hold's look, for a mark growing out of it (REDESIGN.md 7, T7): the
 * soft disc the hold sat on, honey where it was warned, its husk ring, and
 * the comet carrying on round it on the hold's own clock, closing into the
 * whole ring for a payment that went through.
 */
function Departing({
  origin,
  closing,
  style,
}: {
  origin: Arrival;
  closing: SharedValue<number>;
  style: ReturnType<typeof useAnimatedStyle>;
}) {
  const bloom = useBloom();
  return (
    <Reanimated.View
      pointerEvents="none"
      style={[styles.layer, styles.centred, style]}
    >
      <View
        style={[
          styles.ground,
          { backgroundColor: origin.warned ? palette.honeySoft : bloom.soft },
        ]}
      />
      <Ring color={palette.husk} stroke={DEPART.ring} />
      <Comet
        size={SIZE}
        stroke={DEPART.ring}
        head={DEPART.head}
        color={bloom.tone}
        clock={origin.clock}
        closing={closing}
      />
    </Reanimated.View>
  );
}

/** One of the mark's faces, on a layer of its own. */
interface Layer {
  key: string;
  face: ReactNode;
  entering?: EntryExitAnimationFunction;
  exiting?: EntryExitAnimationFunction;
}

const FACES: Record<ResultVisual['shape'], (props: FaceProps) => ReactNode> = {
  disc: Disc,
  orbit: Moving,
  held: Held,
  broken: Broken,
};

/**
 * How a payment ended, as a 120pt mark grown from the control it was sent
 * with (REDESIGN.md 6, Send, and 7, T7). Given an `arrival`, the mark sets
 * out from the hold's centre looking as the hold did, its comet carrying on,
 * and travels to where it rests, growing from the hold's 88pt to its own on
 * the pane spring; a payment that went through closes the comet's lap into
 * the whole ring, fills it with cream and draws its check, and any other
 * face takes over from the hold's look by a crossfade as the mark lands.
 * Every beat of the landing counts from the moment the mark is placed, so
 * one placed late lands late and whole. `onArrived` is called once the
 * hold's look is gone, or as the mark goes if it goes first, so no arrival
 * outlives its mark. Without an arrival, or under Reduce Motion, the mark
 * pops in where it rests. A failure shakes as it lands. A mark at rest
 * (`visual.resting`), for a payment seen before, is simply there. The held
 * ring, seen to complete (`visual.resolves`), fades as the disc grows out
 * of it and its check draws, rather than cutting to the disc in a frame.
 * The orbit of a payment broadcasting on chain resolves into its disc the
 * same way, and gives way to a held ring or a failure by a crossfade, the
 * failure shaking as it comes.
 *
 * The mark carries the words: `accessibilityLabel` for what happened,
 * `accessibilityValue` for the status, and `accessibilityHint` for the
 * engine's message, which a long press also shows through Whisper. With
 * `onPress` it is a control, such as a failure that returns to the payment.
 * `ref` is the mark, which the screen moves a screen reader to as it lands.
 */
export function ResultMark({
  visual,
  accessibilityLabel,
  accessibilityValue,
  accessibilityHint,
  onPress,
  arrival = null,
  onArrived,
  ref,
}: {
  visual: ResultVisual;
  accessibilityLabel: string;
  accessibilityValue: string;
  accessibilityHint: string;
  onPress?: () => void;
  /** What the mark grows out of, read as it mounts; null to pop in at rest. */
  arrival?: Arrival | null;
  /** The hold's look is gone, or the mark went first: it is its own. */
  onArrived?: () => void;
  ref?: Ref<ComponentRef<typeof View>>;
}) {
  const live = usePaneActive();
  const refusal = useShake();
  const { play } = refusal;
  const broken = visual.shape === 'broken';
  const done = visual.shape === 'disc';
  const Face = FACES[visual.shape];

  // What the mark grows out of, settled as it mounts: a mark at rest, or
  // one under Reduce Motion, grows out of nothing and pops in where it rests.
  const [origin] = useState(() =>
    arrival && !visual.resting && !motionReduced() ? arrival : null,
  );
  const [beats] = useState<ArrivalBeats | null>(() =>
    origin ? arrivalBeats(done) : null,
  );
  const [arriving, setArriving] = useState(origin !== null);
  // Placed where it rests, its beats under way: a mark growing out of the
  // hold draws its face from then, so every beat of the landing counts from
  // the one moment, however late the placing.
  const [landed, setLanded] = useState(origin === null);
  // A glyph's lead counts from its face's mount: the landing's for the face
  // that grew out of the hold, and the check's own for the disc a held ring
  // resolves into later, while the ring keeps the lead it had.
  const [grew] = useState(visual.shape);
  const leadFor = (shape: ResultVisual['shape']) =>
    beats && shape === grew ? beats.check : shape === 'disc' ? CHECK_LEAD : 0;

  // A failure shakes as it lands: at once where it pops in, as the hold's
  // look gives way where it grows out of the hold (`land`), and at once where
  // a mark already set out becomes one, as an orbit does whose payment the
  // history shows failed.
  useEffect(() => {
    if (broken && (!beats || setOut.current)) play();
  }, [broken, play, beats]);

  // The travel: unseen until the mark knows where it rests (`placed`), from
  // the hold's centre to there (`travel`), the comet's lap closing into the
  // ring (`closing`) and the cream filling it (`fill`) for a payment that
  // went through, and the hold's look giving way to any other face
  // (`departing`, `faceIn`).
  const placed = useSharedValue(origin ? 0 : 1);
  const travel = useSharedValue(origin ? 0 : 1);
  const toX = useSharedValue(0);
  const toY = useSharedValue(0);
  const closing = useSharedValue(0);
  const fill = useSharedValue(origin && done ? 0 : 1);
  const departing = useSharedValue(1);
  const faceIn = useSharedValue(origin && !done ? 0 : 1);
  const anchor = useRef<HostInstance>(null);
  const setOut = useRef(false);
  const watch = useRef<() => void>(() => {});
  const latest = useRef(onArrived);
  useLayoutEffect(() => {
    latest.current = onArrived;
  });
  // The landing's timers, and whether the hold's look has given way.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const ended = useRef(false);

  /**
   * The mark sets out, placed where it rests (`measured`) or, past
   * PLACE_LATEST without a reading, drawn there at once, and its beats run.
   */
  const land = useCallback(
    (measured: boolean) => {
      if (setOut.current || !beats) return;
      setOut.current = true;
      placed.set(1);
      travel.set(measured ? steady(withSpring(1, springs.pane)) : 1);
      setLanded(true);
      // The hold's look is gone, and the mark is its own, at `gone`; a
      // failure shakes as it lands.
      timers.current = [
        setTimeout(() => {
          ended.current = true;
          setArriving(false);
          latest.current?.();
        }, beats.gone),
        ...(broken ? [setTimeout(play, beats.arrive)] : []),
      ];
      // The landing is the face the mark grew as: a disc reached later, as an
      // orbit's broadcast is, grows out of the face that landed instead.
      if (grew === 'disc') {
        closing.set(
          withTiming(1, { duration: CLOSE_MS, easing: curves.standard }),
        );
        fill.set(
          withDelay(
            beats.fill,
            withTiming(1, { duration: FILL_MS, easing: curves.enter }),
          ),
        );
        return;
      }
      const fade = { duration: durations.crossfade, easing: curves.standard };
      departing.set(withDelay(beats.arrive, withTiming(0, fade)));
      faceIn.set(withDelay(beats.arrive, withTiming(1, fade)));
    },
    [
      beats,
      grew,
      broken,
      play,
      placed,
      travel,
      closing,
      fill,
      departing,
      faceIn,
    ],
  );

  /** Reads where the mark rests, following it while anything still moves it. */
  const place = useCallback(() => {
    if (!origin) return;
    watch.current();
    watch.current = watchCentre(
      () => anchor.current,
      at => {
        toX.set(at.x);
        toY.set(at.y);
        land(true);
      },
    );
  }, [origin, toX, toY, land]);

  useLayoutEffect(() => {
    if (!origin) return;
    place();
    const latestBy = setTimeout(() => land(false), PLACE_LATEST);
    return () => {
      clearTimeout(latestBy);
      watch.current();
    };
  }, [origin, place, land]);

  // Gone before the hold's look has given way, as a held ring tapped back
  // to compose within the half second is, the mark says so all the same, so
  // no arrival outlives its mark.
  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
      if (beats && !ended.current) latest.current?.();
    },
    [beats],
  );

  const travelStyle = useAnimatedStyle(() => {
    if (!origin) return { opacity: 1, transform: [] };
    const pose = travelPose(travel.get(), origin.from, {
      x: toX.get(),
      y: toY.get(),
    });
    return {
      opacity: placed.get(),
      transform: [
        { translateX: pose.translateX },
        { translateY: pose.translateY },
        { scale: pose.scale },
      ],
    };
  }, [origin]);
  const departingStyle = useAnimatedStyle(() => ({
    opacity: departing.get(),
  }));
  const faceStyle = useAnimatedStyle(() => ({ opacity: faceIn.get() }));

  // The held ring or the orbit on screen, for the face after it to come up
  // over: it stays where it is, under that face, while it fades, and then
  // goes. Left to fade as a layer leaving, it was drawn over the disc on iOS,
  // its pause and orbit showing through the done disc as it filled (P14,
  // 05r). A disc it resolves into grows out of it; a held ring or a failure
  // after an orbit fades up over it. A disc it does not resolve into, such
  // as a paid mark at rest, takes its place at once.
  const now = keptOf(visual);
  const [kept, setKept] = useState<Kept | null>(now);
  const moving =
    kept !== null &&
    kept.shape !== visual.shape &&
    (visual.shape !== 'disc' || !!visual.resolves);
  if (!moving && !sameKept(kept, now)) setKept(now);
  const latestKept = useRef(now);
  useLayoutEffect(() => {
    latestKept.current = now;
  });
  const gone = useSharedValue(0);
  useEffect(() => {
    if (!moving) {
      gone.set(0);
      return;
    }
    const ms = resolveOutMs();
    gone.set(
      withTiming(1, {
        duration: ms,
        easing: curves.exit,
        reduceMotion: ReduceMotion.Never,
      }),
    );
    const timer = setTimeout(() => setKept(latestKept.current), ms);
    return () => clearTimeout(timer);
  }, [moving, gone]);
  const keptStyle = useAnimatedStyle(() => ({ opacity: 1 - gone.get() }));

  const faceProps = { visual, lead: leadFor(visual.shape), fill };
  // Each shape is a layer of its own, the one drawn last on top. Moving on,
  // the kept face keeps its layer, under its own key so it is not drawn
  // again, and the next face's comes after it. A mark growing out of the
  // hold draws them once it is placed (`landed`).
  const KeptFace = kept ? FACES[kept.shape] : null;
  const layers: Layer[] =
    moving && kept && KeptFace
      ? [
          {
            key: kept.shape,
            face: (
              <KeptFace
                {...faceProps}
                visual={{
                  ...visual,
                  shape: kept.shape,
                  orbit: kept.orbit,
                  glyph: kept.glyph,
                }}
                lead={leadFor(kept.shape)}
              />
            ),
          },
          {
            key: visual.shape,
            face: <Face {...faceProps} />,
            entering: visual.shape === 'disc' ? popIn(RESOLVE_FROM) : fadeIn(),
          },
        ]
      : [
          {
            key: visual.shape,
            face: <Face {...faceProps} />,
            entering: visual.resolves ? popIn(RESOLVE_FROM) : undefined,
            exiting: visual.shape === 'held' ? fadeOut() : undefined,
          },
        ];
  return (
    <Whisper label={accessibilityHint}>
      {/* The anchor never moves: it is where the mark rests, which the
          travelling view inside it is measured against. */}
      <View
        ref={anchor}
        collapsable={false}
        onLayout={place}
        style={styles.mark}
      >
        <Reanimated.View
          entering={
            visual.resting || origin ? undefined : popIn(CONTROL / SIZE)
          }
          style={[styles.layer, travelStyle]}
        >
          <Reanimated.View style={[styles.mark, refusal.style]}>
            <Pressable
              ref={ref}
              accessibilityRole={onPress ? 'button' : 'none'}
              accessibilityLabel={accessibilityLabel}
              accessibilityValue={{ text: accessibilityValue }}
              accessibilityHint={accessibilityHint}
              accessible
              onPress={
                live && onPress
                  ? () => {
                      haptics.tick();
                      onPress();
                    }
                  : undefined
              }
              style={styles.face}
            >
              {arriving && origin ? (
                <Departing
                  origin={origin}
                  closing={closing}
                  style={departingStyle}
                />
              ) : null}
              {landed
                ? layers.map(layer => (
                    <Reanimated.View
                      key={layer.key}
                      entering={layer.entering}
                      exiting={layer.exiting}
                      style={[
                        styles.layer,
                        styles.centred,
                        moving && layer.key === kept?.shape && keptStyle,
                        arriving && faceStyle,
                      ]}
                    >
                      {layer.face}
                    </Reanimated.View>
                  ))
                : null}
              <Reanimated.View
                pointerEvents="none"
                style={[styles.layer, styles.tint, refusal.tint]}
              />
            </Pressable>
          </Reanimated.View>
        </Reanimated.View>
      </View>
    </Whisper>
  );
}

const styles = StyleSheet.create({
  mark: { width: SIZE, height: SIZE },
  face: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  layer: { position: 'absolute', top: 0, left: 0, width: SIZE, height: SIZE },
  centred: { alignItems: 'center', justifyContent: 'center' },
  inside: { width: HELD_ORBIT_SIZE, height: HELD_ORBIT_SIZE },
  disc: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cream: {
    ...StyleSheet.absoluteFill,
    borderRadius: SIZE / 2,
    backgroundColor: palette.cream,
  },
  ground: { ...StyleSheet.absoluteFill, borderRadius: SIZE / 2 },
  halo: { borderRadius: SIZE / 2, borderWidth: 2, borderColor: palette.honey },
  tint: { borderRadius: SIZE / 2, backgroundColor: palette.radishWash },
});
