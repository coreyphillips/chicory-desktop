import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AccessibilityActionEvent, LayoutChangeEvent } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import type { PanGestureConfig } from 'react-native-gesture-handler';
import Reanimated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { parseSats, validatePrimaryUri } from '@beignet/wallet-core';
import type { PrimaryStatus, WalletSnapshot } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { dropOut, riseIn } from '../../motion/presets';
import { springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { usePaneActive } from '../../stage/panes/Pane';
import { radius, space, type } from '../../theme';
import type { Unit } from '../../theme';
import { amountText } from './EmptyWallet';
import { useFieldScan } from './fieldScan';
import { StatusMark } from './hub';
import type { StatusLook } from './hubModel';
import {
  fillOf,
  fillTargetShown,
  hostLabel,
  looksLikePorchLink,
  moved,
  restingOffset,
  shiftOf,
  slotAt,
} from './primariesModel';
import type { Fill } from './primariesModel';
import {
  Action,
  CopyLine,
  Field,
  Line,
  Link,
  Note,
  nodeAddressText,
  testNetwork,
  useAccent,
  useGlyphSize,
  wholeWords,
} from './ui';

const words = copy.settings;

/** The space between two nodes in the list. */
export const ROW_GAP = space.xs;
/** The fill bar's height. */
const TRACK = 4;
/** The grip's frame: the touch target, with its slop, is 48 across. */
const GRIP_WIDTH = 40;
const GRIP_HEIGHT = 48;
const GRIP_SLOP = { left: 8 };
/** The rank's column. */
const RANK_WIDTH = 20;
/** How far a held row grows. */
const LIFT = 1.02;
/** This far up or down on the grip takes the row; less is a touch. */
const TAKES: [number, number] = [-4, 4];

/**
 * Where a ranked primary's setup is, in words: ready, setting up or failed
 * (REDESIGN.md 6, Wallet health). Never the engine's own value.
 */
export function entrySetupWord(entry: {
  setup: string;
  setupError?: string;
}): string {
  const p = words.primary;
  if (entry.setup === 'ready') return p.setupReady;
  if (entry.setupError || entry.setup === 'failed') return p.setupFailed;
  return entry.setup ? p.setupPending : p.waiting;
}

/** The mark beside a ranked primary: live, sought, or stopped short. */
export function entryLook(entry: {
  connected: boolean;
  setup: string;
  setupError?: string;
}): StatusLook {
  if (entry.setupError || entry.setup === 'failed') return 'stopped';
  return entry.connected ? 'live' : 'seeking';
}

/** What the rows share while one of them is dragged. */
interface Drag {
  /** The index of the row under the finger, or -1. */
  active: SharedValue<number>;
  /** The slot it would land in. */
  slot: SharedValue<number>;
  /** How far the finger has taken it. */
  dragY: SharedValue<number>;
  /** 0 at rest, 1 held. */
  lift: SharedValue<number>;
  /** Each row's height, in drawn order. */
  heights: SharedValue<number[]>;
  /** The row that has just landed, gliding the rest of its way. */
  settleIndex: SharedValue<number>;
  settleY: SharedValue<number>;
  felt: (kind: 'tap' | 'tick' | 'soft') => void;
  land: (from: number, to: number) => void;
}

/**
 * One node in the list: its grip, its rank, its host, the mark of its
 * connection and the bolt when the next receive goes to it; under that the
 * bar of how full it is and the figures the bar stands for; and, open, its
 * address, its channels and the way to remove it. Dragged by the grip it
 * lifts and follows the finger while the others make way; let go, it glides
 * into its slot. A screen reader hears the row as one line and moves it up
 * or down with an action.
 */
function NodeRow({
  entry,
  index,
  total,
  fill,
  unit,
  symbol,
  open,
  busy,
  drag,
  onToggle,
  onMeasure,
  children,
}: {
  entry: PrimaryStatus;
  index: number;
  total: number;
  fill: Fill;
  unit: Unit;
  symbol: boolean;
  open: boolean;
  busy: boolean;
  drag: Drag;
  onToggle: (pubkey: string) => void;
  onMeasure: (pubkey: string, height: number) => void;
  children?: ReactNode;
}) {
  const p = words.primaries;
  const live = usePaneActive();
  const { reduced } = useMotionPrefs();
  const { accent } = useAccent();
  const gripSize = useGlyphSize(18);
  const boltSize = useGlyphSize(14);
  const target = total > 1 && entry.isReceiveTarget;
  const draggable = live && !busy && total > 1;
  const {
    active,
    slot,
    dragY,
    lift,
    heights,
    settleIndex,
    settleY,
    felt,
    land,
  } = drag;

  const pan = usePanGesture(
    useMemo<PanGestureConfig>(
      () => ({
        enabled: draggable,
        activeOffsetY: TAKES,
        hitSlop: GRIP_SLOP,
        onActivate: () => {
          'worklet';
          cancelAnimation(dragY);
          settleIndex.set(-1);
          active.set(index);
          slot.set(index);
          dragY.set(0);
          lift.set(reduced ? 1 : withSpring(1, springs.snap));
          scheduleOnRN(felt, 'tap');
        },
        onUpdate: event => {
          'worklet';
          if (active.get() !== index) return;
          dragY.set(event.translationY);
          const next = slotAt(
            index,
            event.translationY,
            heights.get(),
            ROW_GAP,
          );
          if (next !== slot.get()) {
            slot.set(next);
            scheduleOnRN(felt, 'tick');
          }
        },
        onFinalize: () => {
          'worklet';
          if (active.get() !== index) return;
          scheduleOnRN(felt, 'soft');
          scheduleOnRN(land, index, slot.get());
        },
      }),
      [
        draggable,
        reduced,
        index,
        active,
        slot,
        dragY,
        lift,
        heights,
        settleIndex,
        felt,
        land,
      ],
    ),
  );

  const place = useAnimatedStyle(() => {
    const at = active.get();
    const scale = 1 + (LIFT - 1) * lift.get();
    if (at === index) {
      return {
        zIndex: 2,
        transform: [{ translateY: dragY.get() }, { scale }],
      };
    }
    if (at >= 0) {
      const size = (heights.get()[at] ?? 0) + ROW_GAP;
      return {
        zIndex: 0,
        transform: [
          {
            translateY: withSpring(
              shiftOf(index, at, slot.get(), size),
              springs.snap,
            ),
          },
          { scale: 1 },
        ],
      };
    }
    if (settleIndex.get() === index) {
      return {
        zIndex: 2,
        transform: [{ translateY: settleY.get() }, { scale }],
      };
    }
    return { zIndex: 0, transform: [{ translateY: 0 }, { scale: 1 }] };
  });
  const held = useAnimatedStyle(() => ({ opacity: lift.get() }));
  // The bar settles on its level as a liquid does.
  const level = useSharedValue(fill.level);
  useEffect(() => {
    level.set(reduced ? fill.level : withSpring(fill.level, springs.soft));
  }, [fill.level, reduced, level]);
  const bar = useAnimatedStyle(() => ({
    transform: [{ scaleX: Math.max(0, Math.min(1, level.get())) }],
  }));

  const measure = useCallback(
    (event: LayoutChangeEvent) =>
      onMeasure(entry.pubkey, event.nativeEvent.layout.height),
    [onMeasure, entry.pubkey],
  );
  const actions = [
    ...(index > 0 ? [{ name: 'moveUp', label: p.moveUp }] : []),
    ...(index < total - 1 ? [{ name: 'moveDown', label: p.moveDown }] : []),
  ];
  const act = (event: AccessibilityActionEvent) => {
    const name = event.nativeEvent.actionName;
    const to =
      name === 'moveUp' ? index - 1 : name === 'moveDown' ? index + 1 : -1;
    if (to < 0 || to >= total) return;
    haptics.tick();
    land(index, to);
  };

  const balance = amountText(entry.balanceSat, unit, symbol);
  const hasBar = total > 1 || entry.channelCount > 0;
  const of = hasBar ? p.of(amountText(fill.of, unit, symbol)) : p.noChannel;
  const said = [
    p.rank(entry.rank),
    hostLabel(entry.uri),
    entry.connected ? words.primary.connected : words.primary.connecting,
    hasBar
      ? `${copy.amount.spoken(entry.balanceSat)} ${p.of(
          copy.amount.spoken(fill.of),
        )}`
      : p.noChannel,
    target ? p.receiveTarget : '',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Reanimated.View style={[styles.row, place]} onLayout={measure}>
      <Reanimated.View pointerEvents="none" style={[styles.heldFill, held]} />
      <View style={styles.head}>
        <GestureDetector gesture={pan}>
          <View
            collapsable={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.grip, !draggable && styles.gripStill]}
          >
            <Glyph name="grip" size={gripSize} color={palette.dust} />
          </View>
        </GestureDetector>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={said}
          accessibilityHint={open ? p.hideDetails : p.showDetails}
          accessibilityState={{ expanded: open, disabled: !live }}
          accessibilityActions={live && !busy ? actions : undefined}
          onAccessibilityAction={live && !busy ? act : undefined}
          onPress={
            live
              ? () => {
                  haptics.tick();
                  onToggle(entry.pubkey);
                }
              : undefined
          }
          style={({ pressed }) => [styles.facts, pressed && styles.pressed]}
        >
          <Text style={styles.rank}>{entry.rank}</Text>
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.name}>
            {hostLabel(entry.uri)}
          </Text>
          {target ? (
            <Glyph name="bolt" size={boltSize} color={accent} />
          ) : null}
          <StatusMark look={entryLook(entry)} />
        </Pressable>
      </View>
      <View style={styles.body}>
        <View style={styles.track}>
          <Reanimated.View
            style={[
              styles.fill,
              { backgroundColor: fill.full ? palette.sage : accent },
              bar,
            ]}
          />
        </View>
        <View style={styles.figures}>
          <Text style={styles.balance}>{balance}</Text>
          <Text {...wholeWords(of)} style={styles.of}>
            {of}
          </Text>
        </View>
        {entry.setupError ? (
          <Note tone="error" announce={false}>
            {entry.setupError}
          </Note>
        ) : null}
        {open ? (
          <Reanimated.View
            entering={riseIn()}
            exiting={dropOut(8)}
            style={styles.details}
          >
            {children}
          </Reanimated.View>
        ) : null}
      </View>
    </Reanimated.View>
  );
}

/**
 * What Primary nodes opens when the wallet ranks several primaries
 * (coreyphillips/beignet#1924): the nodes in rank order, each with a bar of
 * how full it is, dragged up or down by their grips and opened for their
 * address and the way to remove one; the fill target the list shares, once
 * there are two nodes, prefilled with the one saved or the default; and a
 * form to add another node, whose address can be scanned as the one-primary
 * panel's can (`useFieldScan`).
 *
 * The order drawn is the engine's, except for the moment between a drop and
 * the engine's answer, when it is the order the drop asked for; an order the
 * engine refuses springs back. Everything else drawn comes from the snapshot
 * the engine answered with.
 */
export function PrimariesPanel({
  snapshot,
  feedback,
  busy,
  unit = 'sats',
  symbol = false,
  onAdd,
  onRemove,
  onReorder,
  onThreshold,
  onRetry,
}: {
  snapshot: WalletSnapshot;
  /** The screen's outcome line, drawn where the one-primary panel draws its own. */
  feedback?: ReactNode;
  busy: boolean;
  unit?: Unit;
  symbol?: boolean;
  onAdd: (
    uri: string,
    done: () => void,
    fallbackUri?: string,
  ) => Promise<void>;
  onRemove: (pubkey: string) => Promise<void>;
  /** The new order, rank 1 first; resolves whether the engine took it. */
  onReorder: (order: string[]) => Promise<boolean>;
  onThreshold: (sats: number) => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const p = words.primaries;
  const { reduced } = useMotionPrefs();
  const ranked = useMemo(
    () => (snapshot.primaries ?? []).slice().sort((a, b) => a.rank - b.rank),
    [snapshot.primaries],
  );
  const byKey = useMemo(
    () => new Map(ranked.map(entry => [entry.pubkey, entry])),
    [ranked],
  );
  const engineOrder = useMemo(
    () => ranked.map(entry => entry.pubkey),
    [ranked],
  );
  const engineKey = engineOrder.join(' ');
  const engineRef = useRef(engineOrder);
  engineRef.current = engineOrder;

  // The order drawn: the engine's, or the one a drop asked for until the
  // engine answers.
  const [order, setOrder] = useState(engineOrder);
  useEffect(() => {
    setOrder(engineRef.current);
  }, [engineKey]);
  const rows = order
    .map(key => byKey.get(key))
    .filter((entry): entry is PrimaryStatus => entry !== undefined);
  const total = rows.length;
  const target = fillTargetShown(snapshot.primariesThresholdSat);

  const [openKey, setOpenKey] = useState<string | null>(null);
  // Removing is a second press: the first says what stays.
  const [removing, setRemoving] = useState<string | null>(null);
  const toggle = useCallback((key: string) => {
    setOpenKey(at => (at === key ? null : key));
    setRemoving(null);
  }, []);

  // The drag the rows share.
  const active = useSharedValue(-1);
  const slot = useSharedValue(-1);
  const dragY = useSharedValue(0);
  const lift = useSharedValue(0);
  const heights = useSharedValue<number[]>([]);
  const settleIndex = useSharedValue(-1);
  const settleY = useSharedValue(0);
  const measured = useRef<Record<string, number>>({});
  const orderRef = useRef(order);
  orderRef.current = order;
  const pushHeights = useCallback(() => {
    heights.set(orderRef.current.map(key => measured.current[key] ?? 0));
  }, [heights]);
  useLayoutEffect(pushHeights, [pushHeights, order]);
  const onMeasure = useCallback(
    (key: string, height: number) => {
      if (measured.current[key] === height) return;
      measured.current[key] = height;
      pushHeights();
    },
    [pushHeights],
  );

  // A drop: the row takes its slot in the drawn order as the state commits
  // and glides the rest of the way from where the finger left it (the layout
  // effect below, in the same commit); the engine is asked, and the engine's
  // order comes back if it refuses.
  const handoff = useRef<{ to: number; y: number } | null>(null);
  const latest = useRef({ onReorder, reduced });
  useLayoutEffect(() => {
    latest.current = { onReorder, reduced };
  });
  const land = useCallback(
    (from: number, to: number) => {
      const current = orderRef.current;
      if (to === from || to < 0 || to >= current.length) {
        lift.set(latest.current.reduced ? 0 : withSpring(0, springs.snap));
        active.set(-1);
        slot.set(-1);
        dragY.set(latest.current.reduced ? 0 : withSpring(0, springs.snap));
        return;
      }
      handoff.current = {
        to,
        y: dragY.get() - restingOffset(from, to, heights.get(), ROW_GAP),
      };
      const next = moved(current, from, to);
      setOrder(next);
      latest.current.onReorder(next).then(saved => {
        if (!saved) setOrder(engineRef.current);
      });
    },
    [active, slot, dragY, lift, heights],
  );
  useLayoutEffect(() => {
    const hand = handoff.current;
    if (!hand) return;
    handoff.current = null;
    active.set(-1);
    slot.set(-1);
    dragY.set(0);
    if (latest.current.reduced) {
      lift.set(0);
      settleIndex.set(-1);
      settleY.set(0);
      return;
    }
    settleIndex.set(hand.to);
    settleY.set(hand.y);
    lift.set(withSpring(0, springs.snap));
    settleY.set(
      withSpring(0, springs.snap, finished => {
        'worklet';
        if (finished) settleIndex.set(-1);
      }),
    );
  }, [order, active, slot, dragY, lift, settleIndex, settleY]);
  const felt = useCallback(
    (kind: 'tap' | 'tick' | 'soft') => haptics[kind](),
    [],
  );
  const drag = useMemo<Drag>(
    () => ({
      active,
      slot,
      dragY,
      lift,
      heights,
      settleIndex,
      settleY,
      felt,
      land,
    }),
    [active, slot, dragY, lift, heights, settleIndex, settleY, felt, land],
  );

  // The fill target's field follows the wallet it describes.
  const [threshold, setThreshold] = useState(String(target));
  useEffect(() => {
    setThreshold(String(target));
  }, [target]);
  const thresholdValue = threshold.trim();
  const thresholdValid =
    /^\d{1,16}$/.test(thresholdValue) && Number(thresholdValue) > 0;
  const thresholdChanged =
    thresholdValid &&
    Number(thresholdValue) !== (snapshot.primariesThresholdSat ?? null);

  // The add form.
  const [adding, setAdding] = useState(false);
  const [uri, setUri] = useState('');
  const [fallback, setFallback] = useState('');
  const closeAdd = () => {
    setAdding(false);
    setUri('');
    setFallback('');
  };
  const scan = useFieldScan({
    purpose: 'primary',
    validate: validatePrimaryUri,
    onCode: setUri,
    test: testNetwork(snapshot.wallet.network),
  });
  const iroh = /@iroh:/i.test(uri);
  const porch = looksLikePorchLink(uri);
  const anyAway = rows.some(entry => !entry.connected);

  return (
    <>
      {feedback}
      {total === 0 ? <Note>{words.primary.none}</Note> : null}
      <View style={styles.list}>
        {rows.map((entry, index) => (
          <NodeRow
            key={entry.pubkey}
            entry={entry}
            index={index}
            total={total}
            fill={fillOf(entry, {
              total,
              target,
              receivableSats: snapshot.balance.receivableSats,
            })}
            unit={unit}
            symbol={symbol}
            open={openKey === entry.pubkey}
            busy={busy}
            drag={drag}
            onToggle={toggle}
            onMeasure={onMeasure}
          >
            <CopyLine
              label={words.primary.address}
              value={entry.uri}
              shown={nodeAddressText(entry.uri)}
              copyLabel={words.primary.copy}
              copiedLabel={words.primary.copied}
            />
            <Line label={words.primary.setup} value={entrySetupWord(entry)} />
            <Line
              label={p.channelsLabel}
              value={
                entry.channelCount > 0
                  ? p.channels(entry.channelCount)
                  : p.noChannel
              }
            />
            {removing === entry.pubkey ? (
              <>
                <Note>{p.removeKeeps}</Note>
                <Action
                  label={p.confirmRemove}
                  glyph="close"
                  tone="danger"
                  busy={busy}
                  onPress={async () => {
                    await onRemove(entry.pubkey);
                    setRemoving(null);
                  }}
                />
                <Link
                  label={words.primary.cancel}
                  tone="steam"
                  disabled={busy}
                  onPress={() => setRemoving(null)}
                />
              </>
            ) : (
              <Link
                label={p.remove}
                glyph="close"
                tone="radish"
                disabled={busy}
                onPress={() => setRemoving(entry.pubkey)}
              />
            )}
          </NodeRow>
        ))}
      </View>
      {anyAway ? (
        <Action
          label={p.retryAll}
          glyph="refresh"
          tone="quiet"
          onPress={onRetry}
          busy={busy}
        />
      ) : null}
      {total > 1 ? (
        <>
          <Field
            label={p.threshold}
            value={threshold}
            onChangeText={setThreshold}
            keyboardType="number-pad"
            editable={!busy}
          />
          {thresholdChanged ? (
            <Action
              label={p.saveThreshold}
              glyph="check"
              tone="quiet"
              busy={busy}
              onPress={() => onThreshold(parseSats(thresholdValue))}
            />
          ) : null}
          <Note>{p.thresholdHint}</Note>
        </>
      ) : null}
      {adding ? (
        <Reanimated.View entering={riseIn()} exiting={dropOut(8)}>
          <View ref={scan.into} collapsable={false}>
            <Field
              label={words.primary.address}
              value={uri}
              onChangeText={setUri}
              autoCapitalize="none"
              multiline
              mono
              editable={!busy}
              focus={scan.landOn === 'field'}
            />
          </View>
          {scan.camera}
          <View ref={scan.from} collapsable={false}>
            <Action
              label={words.primary.scan}
              glyph="scan"
              tone="quiet"
              focus={scan.landOn === 'control'}
              onPress={scan.open}
            />
          </View>
          {iroh ? (
            <>
              <Note>{words.primary.iroh}</Note>
              <Field
                label={words.primary.fallback}
                value={fallback}
                onChangeText={setFallback}
                autoCapitalize="none"
                multiline
                mono
                editable={!busy}
              />
              <Note>{words.primary.fallbackHint}</Note>
            </>
          ) : null}
          {porch ? <Note>{words.primary.porch}</Note> : null}
          <Note>{p.addHint}</Note>
          <Action
            label={words.primary.save}
            glyph="check"
            onPress={() =>
              onAdd(uri.trim(), closeAdd, iroh ? fallback.trim() : undefined)
            }
            busy={busy}
            disabled={!uri.trim()}
          />
          <Link
            label={words.primary.cancel}
            tone="steam"
            disabled={busy}
            onPress={closeAdd}
          />
        </Reanimated.View>
      ) : (
        <Link
          label={p.add}
          glyph="plus"
          disabled={busy}
          onPress={() => {
            setAdding(true);
            scan.land('field');
          }}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  list: { gap: ROW_GAP },
  // A row reaches a little past the content either side, so a held row's
  // fill frames it.
  row: {
    marginHorizontal: -space.xs,
    paddingHorizontal: space.xs,
    paddingBottom: space.xs,
    borderRadius: radius.md,
  },
  heldFill: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.md,
    backgroundColor: palette.mocha,
  },
  head: { flexDirection: 'row', alignItems: 'center' },
  grip: {
    width: GRIP_WIDTH,
    height: GRIP_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gripStill: { opacity: 0.45 },
  facts: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: GRIP_HEIGHT,
    paddingRight: space.xxs,
  },
  pressed: { opacity: 0.6 },
  rank: {
    ...type.label,
    color: palette.steam,
    minWidth: RANK_WIDTH,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  name: { ...type.body, color: palette.cream, flex: 1 },
  // The bar and its figures line up under the host, past the grip and rank.
  body: {
    marginLeft: GRIP_WIDTH + space.xs + RANK_WIDTH + space.xs,
    gap: space.xs,
  },
  track: {
    height: TRACK,
    borderRadius: TRACK / 2,
    backgroundColor: palette.husk,
    overflow: 'hidden',
  },
  // A full bar scaled from its left end: never a width that changes.
  fill: {
    ...StyleSheet.absoluteFill,
    borderRadius: TRACK / 2,
    transformOrigin: '0% 50%',
  },
  figures: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: space.sm,
  },
  balance: {
    ...type.body,
    color: palette.cream,
    fontVariant: ['tabular-nums'],
  },
  of: {
    ...type.caption,
    color: palette.steam,
    flexShrink: 1,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  details: { gap: space.sm, paddingTop: space.xxs },
});
