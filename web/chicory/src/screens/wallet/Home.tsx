import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  PixelRatio,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import type {
  AccessibilityActionEvent,
  HostInstance,
  LayoutChangeEvent,
} from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import type { PanGestureConfig } from 'react-native-gesture-handler';
import Reanimated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { Activity, WalletSnapshot } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { haptics } from '../../design/haptics';
import { Odometer } from '../../glyphs/Odometer';
import { Vessel } from '../../glyphs/Vessel';
import { popIn } from '../../motion/effects';
import { drawIn, dropOut, fadeIn } from '../../motion/presets';
import { ENTRY_GRACE_MS, useSureEntry } from '../../motion/sureEntry';
import { steady } from '../../motion/steady';
import { curves, durations, overlap, springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { ActionCircle } from '../../scenes/home/ActionCircle';
import type { Point } from '../../scenes/home/ActionCircle';
import {
  LAUNCH_DROP,
  PULL_TRIGGER,
  circleOpacity,
  figureShown,
  heroPose,
  landedAt,
  launchPose,
  launchTravel,
  miniLanding,
  pullOffset,
  vesselOpacity,
} from '../../scenes/home/motion';
import type { HeroFrame, Launch } from '../../scenes/home/motion';
import { isTestNetwork } from '../../scenes/home/visual';
import {
  HOME,
  PANE_SETTLE_MS,
  PRIMARY_CONTROL,
  heroBox,
  veilOpacity,
} from '../../stage/layout';
import type { BuildBeats, ControlLook } from '../../stage/layout';
import { useLaunch } from '../../stage/panes/Launch';
import type { Launch as Landing } from '../../stage/panes/Launch';
import type { Panes } from '../../stage/panes/Pane';
import { usePaneActive } from '../../stage/panes/Pane';
import { usePrimary } from '../../stage/panes/Primary';
import type { Unit } from '../../theme';

/** The pull's haptic, as the pan's worklets hand it back to JS. */
const feelPull = () => haptics.soft();

/** What the stale gate does to the action circles: they shrink to this. */
const GATED = 0.94;

/** The action row's height: the Scan circle's, the largest in it. */
const ROW_HEIGHT = HOME.row;

/**
 * Home: the balance, the pill of what is spendable and what is on its way,
 * and the three things you do with it (REDESIGN.md 6, Wallet health). There
 * are no words on it. The balance is the hero, the vessel under it says what
 * is waiting and why, and the action row is three circles: Send, Scan and
 * Receive.
 *
 * Tapping the hero rolls it from sats to `₿` to BTC and back to sats
 * (`nextFace`), and a long press hides it; a screen reader has both as
 * actions. Pulling the pane down opens the status row's mark petal by petal,
 * through the canvas's `pull`, and letting go once it is in full flower
 * starts a refresh. An old balance gates the actions, which say so and
 * refresh when tapped rather than act.
 *
 * On the canvas `progress` carries the panes: `hero` shrinks the balance into
 * a mini strip, fading the vessel first, which rests in the band under the
 * status row that Send and Receive leave clear (MINI_STRIP), or in the row
 * itself under Activity and a payment's detail. The balance is one element
 * all the way there, its unit holding a readable size as the figures shrink,
 * so it is never drawn twice. While Send or Receive is open it shows what
 * can be spent (`spendable`): a different figure rather than money moving,
 * so it changes in place, where money moving rolls. `bar` carries the action
 * row away: the circles not tapped shrink and are gone before the scene's
 * content enters, and the tapped one travels and grows toward the scene it
 * opens, whole until it hands over to the scene's own control. Drawn on its own it rests at home. The activity it once
 * previewed is the sheet's now; `onActivity` and `onDetail` stay for the
 * callers that still pass them.
 */
export function HomeScreen({
  snapshot,
  hidden = false,
  unit = 'sats',
  symbol = false,
  stale = false,
  gated = stale,
  onSend,
  onReceive,
  onScan,
  onToggleUnit,
  onToggleHidden,
  onRefresh,
  countUp,
  spendable = false,
  progress,
  launching = 'none',
  lands = null,
  landless = false,
  arrived = 0,
  build,
}: {
  snapshot: WalletSnapshot;
  hidden?: boolean;
  unit?: Unit;
  /**
   * Sats are drawn as `₿2,000` (`unitAffixes`). The balance is still read
   * out in sats.
   */
  symbol?: boolean;
  stale?: boolean;
  /**
   * Whether the old balance holds the actions back: they shrink and turn
   * dust, and a tap shakes them. As `stale` unless the wallet is still
   * opening on its last figures, when the actions stay open and Send and
   * Receive wait inside for the live read.
   */
  gated?: boolean;
  onSend: () => void;
  onReceive: () => void;
  /** Opens the scan, growing from `origin`, where the circle is. */
  onScan?: (origin?: Point) => void;
  onActivity: () => void;
  onDetail: (item: Activity) => void;
  onToggleUnit?: () => void;
  onToggleHidden?: () => void;
  /** Refreshes the wallet, for the pull and for a tap on a gated action. */
  onRefresh?: () => void;
  /**
   * How long after it mounts the hero counts up from 0 to the total, on the
   * steady clock, as the canvas builds in (REDESIGN.md 7, R-1). Left out,
   * it simply shows.
   */
  countUp?: number;
  /**
   * The hero shows what can be spent now rather than the total, as it does
   * while Send or Receive is open.
   */
  spendable?: boolean;
  /**
   * The canvas's panes, which move the hero and the action row, and take
   * the pull for the mark to open with.
   */
  progress?: Pick<Panes, 'hero' | 'bar'> &
    Partial<Pick<Panes, 'pull' | 'veil'>>;
  /** The scene the canvas is heading to, when one of the circles opens it. */
  launching?: Launch;
  /**
   * The look of the control the launching circle lands on, which it takes
   * on as it travels (`launchLook` in stage/layout).
   */
  lands?: ControlLook | null;
  /**
   * The scene opens with no control for the circle to land on, as Send does
   * on a held request's ring or a paid one's mark: the circle that opened
   * it goes with the other two rather than travel to where nothing is drawn.
   */
  landless?: boolean;
  /** A count that rises with each read that brought money in. */
  arrived?: number;
  /**
   * The beats of the canvas's build as it arrives (REDESIGN.md 7, R-1 and
   * R-3), read as Home mounts: the balance fades up as it counts, the
   * vessel draws, and the actions pop in one after another.
   */
  build?: BuildBeats;
}) {
  // On the canvas, Home stays drawn while other scenes show, so its controls
  // only get their handlers while its pane is the one in use.
  const live = usePaneActive();
  const { reduced } = useMotionPrefs();
  // The balance is where a screen reader lands as the canvas comes home.
  const primary = usePrimary();
  const resting = useSharedValue(1);
  const hero = progress?.hero ?? resting;
  const bar = progress?.bar ?? resting;
  const frame = useSharedValue<HeroFrame>({ y: 0, height: 0 });
  // Where the mini strip lands: in the band Send and Receive leave clear, or
  // in the status row. It moves on the pane spring when the target changes,
  // so the strip never jumps between the two.
  const landingAt = useSharedValue(miniLanding(launching));
  // The pane follows the finger and springs back on its own; the canvas's
  // pull is only ever the finger, and 0 once it lets go.
  const drag = useSharedValue(0);
  const pull = progress?.pull;
  const armed = useSharedValue(false);
  const pop = useSharedValue(1);
  const gate = useSharedValue(gated ? GATED : 1);
  // Where the row's middle and the Send and Receive circles are across it,
  // so a launching circle knows how far it has to travel to the centre, and,
  // on the canvas, where each circle rests in the window, so it travels to
  // where the scene it opens draws its own control (`landing`).
  const middle = useSharedValue(0);
  const sendAt = useSharedValue(0);
  const receiveAt = useSharedValue(0);
  const landing = useLaunch();
  const sendRest = useWindowPlace();
  const receiveRest = useWindowPlace();
  const test = isTestNetwork(snapshot.wallet.network);
  const { balance } = snapshot;

  // The stale gate shrinks the circles. It is kept here rather than in each
  // circle, which is drawn anew as the gate closes, so the change is seen.
  useEffect(() => {
    const to = gated ? GATED : 1;
    gate.set(reduced ? to : withSpring(to, springs.snap));
  }, [gated, reduced, gate]);

  useEffect(() => {
    const to = miniLanding(launching);
    landingAt.set(reduced ? to : withSpring(to, springs.pane));
  }, [launching, reduced, landingAt]);

  // Money arriving lifts the balance as it rolls to the new figure.
  useEffect(() => {
    if (!arrived || reduced) return;
    pop.set(
      withSequence(
        withTiming(1.06, { duration: durations.exit, easing: curves.enter }),
        withSpring(1, springs.reveal),
      ),
    );
  }, [arrived, reduced, pop]);

  const refresh = live ? onRefresh : undefined;
  // Held across renders, so a poll or a pane that starts or ends a move,
  // which draw Home again, never hands the pan a new configuration, even
  // mid-pull.
  const config = useMemo<PanGestureConfig>(() => {
    const follow = (dy: number) => {
      'worklet';
      drag.set(Math.max(0, dy));
      pull?.set(Math.max(0, dy));
      const ready = dy >= PULL_TRIGGER;
      if (ready !== armed.get()) {
        armed.set(ready);
        if (ready) scheduleOnRN(feelPull);
      }
    };
    return {
      enabled: !!refresh,
      // Only a pull down starts it, and a sideways swipe never does.
      activeOffsetY: 12,
      failOffsetX: [-20, 20],
      onActivate: event => {
        'worklet';
        follow(event.translationY);
      },
      onUpdate: event => {
        'worklet';
        follow(event.translationY);
      },
      onDeactivate: event => {
        'worklet';
        if (armed.get() && !event.canceled && refresh) scheduleOnRN(refresh);
        armed.set(false);
        pull?.set(0);
        drag.set(withSpring(0, springs.pane));
      },
    };
  }, [refresh, drag, pull, armed]);
  const pan = usePanGesture(config);

  const stackStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: pullOffset(drag.get()) }],
  }));
  const heroMotion = useAnimatedStyle(() => {
    const pose = heroPose(hero.get(), frame.get(), landingAt.get());
    return {
      transform: [{ translateY: pose.translateY }, { scale: pose.scale }],
    };
  });
  const vesselStyle = useAnimatedStyle(() => ({
    opacity: vesselOpacity(hero.get()),
  }));
  // Under Reduce Motion the balance and its vessel fade out and back in
  // around their jump to the mini strip, rather than travelling.
  const veil = progress?.veil;
  const veiled = useAnimatedStyle(() => ({
    opacity: veilOpacity(veil?.get() ?? 1),
  }));
  // Reduce Motion keeps the circles where they are while the row fades,
  // under the veil with the balance.
  const flying: Launch = reduced ? 'none' : launching;
  // With no control to land on, no circle travels: all three go as the two
  // not tapped do.
  const travels = !landless;
  const size = PRIMARY_CONTROL * (lands?.scale ?? 1);
  const row = {
    bar,
    gate,
    middle,
    veil,
    landing,
    launching: flying,
    travels,
    size,
  };
  const sendLaunch = useLaunchStyle(row, 'send', sendAt, sendRest.place);
  const scanLaunch = useLaunchStyle(row, null);
  const receiveLaunch = useLaunchStyle(
    row,
    'receive',
    receiveAt,
    receiveRest.place,
  );
  // How far each circle has taken on the look of the control it becomes.
  const sendToward = useDerivedValue(
    () => (flying === 'send' ? launchTravel(1 - bar.get()) : 0),
    [flying],
  );
  const receiveToward = useDerivedValue(
    () => (flying === 'receive' ? launchTravel(1 - bar.get()) : 0),
    [flying],
  );
  const morphOf = (toward: SharedValue<number>) =>
    lands ? { look: lands, toward } : undefined;
  // The circle hands over to the scene's control once it is on it, not on
  // a clock: the move can start late, and the spring's tail is long.
  const flyingAt = flying === 'receive' ? receiveAt : sendAt;
  const flyingRest = flying === 'receive' ? receiveRest.place : sendRest.place;
  useAnimatedReaction(
    () => {
      if (!landing || flying === 'none' || !travels) return false;
      const from = flyingRest.get();
      const measured = from.y > 0;
      const across = measured
        ? landing.x.get() - from.x
        : middle.get() - flyingAt.get();
      const down = measured ? landing.y.get() - from.y : LAUNCH_DROP;
      const growth = (size - HOME.circle) / 2;
      return landedAt(1 - bar.get(), Math.hypot(across, down) + growth);
    },
    (now, before) => {
      if (!landing || !now || before !== false) return;
      landing.handover.set(
        steady(
          withTiming(1, { duration: durations.exit, easing: curves.standard }),
        ),
      );
    },
    [landing, flying, travels, size],
  );

  // How each part enters as the canvas builds in, read once as Home mounts,
  // and how the figures roll out as it leaves (R-6).
  const [arrive] = useState(() => ({
    hero: build ? fadeIn(build.hero) : undefined,
    vessel: build ? drawIn(build.sheet) : undefined,
    actions: [0, 1, 2].map(at =>
      build ? popIn(0.6, build.actions + at * build.actionStep) : undefined,
    ),
  }));
  const [heroOut] = useState(() => dropOut(overlap.rise));
  // Each part is sure to show once its beat is well past, however the
  // entrance fares (`useSureEntry`).
  const lateBy = (beat: number) => beat + ENTRY_GRACE_MS;
  const heroEntry = useSureEntry(arrive.hero, lateBy(build?.hero ?? 0));
  const vesselEntry = useSureEntry(arrive.vessel, lateBy(build?.sheet ?? 0));
  const sendEntry = useSureEntry(
    arrive.actions[0],
    lateBy(build?.actions ?? 0),
  );
  const scanEntry = useSureEntry(
    arrive.actions[1],
    lateBy(build ? build.actions + build.actionStep : 0),
  );
  const receiveEntry = useSureEntry(
    arrive.actions[2],
    lateBy(build ? build.actions + 2 * build.actionStep : 0),
  );

  // The width the balance has, which it fits its size to (REDESIGN.md 3.3).
  const [room, setRoom] = useState<number | undefined>(undefined);
  const measureHero = (event: LayoutChangeEvent) => {
    const { y, width, height } = event.nativeEvent.layout;
    frame.set({ y, height });
    setRoom(width);
  };
  // The hero keeps the tallest line box it has drawn, so a step down to a
  // smaller size, as BTC takes, never moves the vessel and the actions
  // under it (REDESIGN.md 2.3: layout moves by transform only). A new text
  // size starts afresh.
  const { fontScale } = useWindowDimensions();
  const [tallest, setTallest] = useState({ fontScale, height: 0 });
  const heroHeight = Math.max(
    heroBox(fontScale, PixelRatio.get()),
    tallest.fontScale === fontScale ? tallest.height : 0,
  );
  const measureFigures = (event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setTallest(last =>
      last.fontScale === fontScale && last.height >= height
        ? last
        : { fontScale, height },
    );
  };
  // The scale the hero is drawn at, which its unit holds its size against.
  const heroScale = useDerivedValue(
    () => heroPose(hero.get(), frame.get(), landingAt.get()).scale,
  );
  const figuresStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pop.get() }],
  }));
  // Which figure the hero shows: the total, or what can be spent. Each is an
  // odometer of its own, both drawn in the one place and only one ever
  // seen, so a change of either rolls and a change between them is a new
  // figure in place. That change is made on the UI thread in the first
  // frame the hero moves toward the scene that wants it (`figureShown`):
  // under the move, never before it starts, where the full balance would
  // read as money gone, and never after it ends. Neither figure mounts or
  // fades for it, so it never blinks.
  const want = spendable ? 1 : 0;
  const figureAt = useSharedValue(want);
  useAnimatedReaction(
    () => ({ hero: hero.get(), landing: landingAt.get() }),
    (now, before) => {
      const next = figureShown(figureAt.get(), want, now, before);
      if (next !== figureAt.get()) figureAt.set(next);
    },
    [want],
  );
  // Drawn on its own nothing moves it, so it changes at once. On the canvas
  // a move that never came leaves it changed by when one would have landed.
  const onCanvas = !!progress;
  useEffect(() => {
    if (!onCanvas) {
      figureAt.set(want);
      return;
    }
    const late = setTimeout(() => figureAt.set(want), FIGURE_LATEST);
    return () => clearTimeout(late);
  }, [want, onCanvas, figureAt]);
  const totalShown = useAnimatedStyle(() => ({
    opacity: figureAt.get() === 1 ? 0 : 1,
  }));
  const spendableShown = useAnimatedStyle(() => ({
    opacity: figureAt.get() === 1 ? 1 : 0,
  }));
  const measureRow = (event: LayoutChangeEvent) =>
    middle.set(event.nativeEvent.layout.width / 2);
  const centreOf = (at: SharedValue<number>) => (event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    at.set(x + width / 2);
  };
  const whileLive = <T extends unknown[]>(action?: (...args: T) => void) =>
    live ? action : undefined;

  const switchUnit =
    live && onToggleUnit
      ? () => {
          haptics.tick();
          onToggleUnit();
        }
      : undefined;
  const toggleMask =
    live && onToggleHidden
      ? () => {
          haptics.tick();
          onToggleHidden();
        }
      : undefined;
  const heroActions = [
    ...(switchUnit ? [{ name: 'unit', label: copy.home.switchUnit }] : []),
    ...(toggleMask
      ? [
          {
            name: 'mask',
            label: hidden ? copy.home.showBalance : copy.home.hideBalance,
          },
        ]
      : []),
  ];
  const onHeroAction = heroActions.length
    ? (event: AccessibilityActionEvent) => {
        if (event.nativeEvent.actionName === 'unit') switchUnit?.();
        if (event.nativeEvent.actionName === 'mask') toggleMask?.();
      }
    : undefined;
  const label = hidden
    ? copy.home.balanceHidden
    : copy.home.totalBalance(balance.totalSats, unit);

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.fill}>
        <Reanimated.View style={[styles.stack, stackStyle]}>
          <Reanimated.View style={[styles.middle, veiled]}>
            <Reanimated.View
              testID="home-hero"
              onLayout={measureHero}
              style={[styles.hero, { minHeight: heroHeight }, heroMotion]}
            >
              <Pressable
                ref={primary}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityHint={copy.home.unitHint}
                accessibilityValue={
                  stale ? { text: copy.health.stale } : undefined
                }
                accessibilityActions={heroActions}
                onAccessibilityAction={onHeroAction}
                onPress={switchUnit}
                onLongPress={toggleMask}
                delayLongPress={400}
                onLayout={measureFigures}
                style={styles.balance}
              >
                <Reanimated.View
                  style={figuresStyle}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                >
                  <Reanimated.View
                    key={heroEntry.key}
                    testID="home-figures"
                    entering={heroEntry.entering}
                    exiting={heroOut}
                  >
                    <Reanimated.View testID="home-total" style={totalShown}>
                      <Odometer
                        sats={balance.totalSats}
                        countUp={countUp}
                        unit={unit}
                        symbol={symbol}
                        masked={hidden}
                        stale={stale}
                        variant="hero"
                        room={room}
                        scaled={heroScale}
                        accessibilityLabel={label}
                      />
                    </Reanimated.View>
                    <Reanimated.View
                      testID="home-spendable"
                      style={[styles.over, spendableShown]}
                    >
                      <Odometer
                        sats={balance.availableSats}
                        unit={unit}
                        symbol={symbol}
                        masked={hidden}
                        stale={stale}
                        variant="hero"
                        room={room}
                        scaled={heroScale}
                        accessibilityLabel={label}
                      />
                    </Reanimated.View>
                  </Reanimated.View>
                </Reanimated.View>
              </Pressable>
            </Reanimated.View>
            <Reanimated.View style={[styles.vessel, vesselStyle]}>
              <Reanimated.View
                key={vesselEntry.key}
                entering={vesselEntry.entering}
              >
                <Vessel
                  availableSats={balance.availableSats}
                  pendingSats={balance.pendingSats}
                  totalSats={balance.totalSats}
                  lfbw={snapshot.wallet.lfbw}
                  connected={snapshot.primary.connected}
                  unit={unit}
                  symbol={symbol}
                  masked={hidden}
                  stale={stale}
                  test={test}
                />
              </Reanimated.View>
            </Reanimated.View>
          </Reanimated.View>
          {/* Each circle sits in a slot as tall as the row, so the three
              share one top edge and VoiceOver, which orders what shares a
              row by where it starts, reads them left to right: Send, Scan,
              Receive (REDESIGN.md 9). Each circle fades on its own. An
              entry's key says only where its entrance stands, the same for
              all three, so each slot's key names its action too. */}
          <View testID="home-bar" onLayout={measureRow} style={styles.bar}>
            <Reanimated.View
              key={`send:${sendEntry.key}`}
              testID="home-slot"
              entering={sendEntry.entering}
              style={styles.slot}
              onLayout={event => {
                centreOf(sendAt)(event);
                sendRest.measure();
              }}
            >
              <View ref={sendRest.ref} collapsable={false}>
                <Reanimated.View style={sendLaunch}>
                  <ActionCircle
                    glyph="send"
                    size={HOME.circle}
                    label={copy.home.send}
                    hint={copy.home.sendHint}
                    stale={gated}
                    onAct={whileLive(onSend)}
                    onRefresh={refresh}
                    morph={morphOf(sendToward)}
                  />
                </Reanimated.View>
              </View>
            </Reanimated.View>
            <Reanimated.View
              key={`scan:${scanEntry.key}`}
              testID="home-slot"
              entering={scanEntry.entering}
              style={styles.slot}
            >
              <Reanimated.View style={scanLaunch}>
                <ActionCircle
                  glyph="scan"
                  size={ROW_HEIGHT}
                  label={copy.home.scan}
                  hint={copy.home.scanHint}
                  primary
                  test={test}
                  stale={gated}
                  onAct={whileLive(onScan)}
                  onRefresh={refresh}
                />
              </Reanimated.View>
            </Reanimated.View>
            <Reanimated.View
              key={`receive:${receiveEntry.key}`}
              testID="home-slot"
              entering={receiveEntry.entering}
              style={styles.slot}
              onLayout={event => {
                centreOf(receiveAt)(event);
                receiveRest.measure();
              }}
            >
              <View ref={receiveRest.ref} collapsable={false}>
                <Reanimated.View style={receiveLaunch}>
                  <ActionCircle
                    glyph="receive"
                    size={HOME.circle}
                    label={copy.home.receive}
                    hint={
                      balance.unresolvedOfflineSlots
                        ? `${copy.home.receiveHint} An offline request still holds inbound capacity. Ordinary payments use the remaining capacity.`
                        : copy.home.receiveHint
                    }
                    stale={gated}
                    onAct={whileLive(onReceive)}
                    onRefresh={refresh}
                    morph={morphOf(receiveToward)}
                  />
                </Reanimated.View>
              </View>
            </Reanimated.View>
          </View>
        </Reanimated.View>
      </View>
    </GestureDetector>
  );
}

/**
 * The latest the hero changes figure on the canvas, should no move come to
 * change it under: well past where a move lands, as HANDOVER_LATEST is.
 */
const FIGURE_LATEST = 2 * PANE_SETTLE_MS;

/** A point in the window. */
type Place = { x: number; y: number };

/**
 * Where a view's centre rests in the window, read as it is laid out: `ref`
 * goes on the view and `measure` runs from its slot's layout.
 */
function useWindowPlace() {
  const ref = useRef<HostInstance>(null);
  const place = useSharedValue<Place>({ x: 0, y: 0 });
  const measure = useCallback(() => {
    ref.current?.measureInWindow((x, y, width, height) => {
      if (width && height) place.set({ x: x + width / 2, y: y + height / 2 });
    });
  }, [place]);
  return { ref, place, measure };
}

/**
 * One circle of the action row, shrunk by the stale `gate`, and posed and
 * faded on the way to `launching` (REDESIGN.md 7, T1 and T2). `own` is the
 * scene the circle opens, if any, and `at` its centre across the row, whose
 * middle is `middle`. On the canvas `rest` is where the circle rests in the
 * window, and the tapped one travels from there to `landing`, the scene's
 * own control, and hands over to it as `landing` says. Under Reduce Motion
 * each circle is under the veil (`veilOpacity`) with the balance.
 */
function useLaunchStyle(
  {
    bar,
    gate,
    middle,
    veil,
    landing,
    launching,
    travels,
    size,
  }: {
    bar: SharedValue<number>;
    gate: SharedValue<number>;
    middle: SharedValue<number>;
    veil?: SharedValue<number>;
    landing: Landing | null;
    launching: Launch;
    /** Whether the tapped circle travels, having a control to land on. */
    travels: boolean;
    /** How big the control the tapped circle grows into is drawn. */
    size: number;
  },
  own: Launch | null,
  at?: SharedValue<number>,
  rest?: SharedValue<Place>,
) {
  return useAnimatedStyle(() => {
    const away = 1 - bar.get();
    const tapped = travels && launching === own;
    const from = rest ? rest.get() : null;
    const measured = !!landing && !!from && from.y > 0;
    const toCentre = measured
      ? landing.x.get() - from.x
      : at
      ? middle.get() - at.get()
      : 0;
    const drop = measured ? landing.y.get() - from.y : undefined;
    const pose = launchPose(away, tapped, launching, toCentre, drop, size);
    const handover = landing ? landing.handover.get() : undefined;
    return {
      opacity:
        circleOpacity(away, tapped, launching, handover) *
        veilOpacity(veil ? veil.get() : 1),
      transform: [
        { translateX: pose.translateX },
        { translateY: pose.translateY },
        { scale: pose.scale * gate.get() },
      ],
    };
  }, [launching, own, landing, veil, travels, size]);
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  stack: {
    flex: 1,
    paddingHorizontal: HOME.edge,
    maxWidth: 640,
    width: '100%',
    alignSelf: 'center',
  },
  // The balance and its vessel, centred in what the action row leaves.
  middle: { flex: 1, justifyContent: 'center', gap: HOME.gap },
  // Scaled from its top edge, so the mini strip hangs from where it rises to.
  hero: {
    transformOrigin: 'top',
    alignItems: 'center',
    justifyContent: 'center',
  },
  balance: { alignItems: 'center', paddingVertical: HOME.heroPad },
  // What can be spent, drawn where the total is, the two centred alike.
  over: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  vessel: { paddingHorizontal: HOME.vesselInset },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    paddingBottom: HOME.rowBottom,
  },
  slot: {
    height: ROW_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
