/**
 * The glyphs, each in every mode, tone, variant and event it has, drawn on
 * their own in the middle of the screen. A glyph that changes is shown
 * changing, as the same instance updated a step at a time, since a change
 * is where most of their worklets run.
 */
import React, { useEffect } from 'react';
import type { PropsWithChildren, ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { copy } from '../chicory/src/design/copy';
import { palette } from '../chicory/src/design/palette';
import { Bloom } from '../chicory/src/glyphs/Bloom';
import type { BloomEvent, BloomMode, BloomTone } from '../chicory/src/glyphs/Bloom';
import { CopyChip } from '../chicory/src/glyphs/CopyChip';
import { ExpiryRing } from '../chicory/src/glyphs/ExpiryRing';
import { HoldButton } from '../chicory/src/glyphs/HoldButton';
import { Odometer } from '../chicory/src/glyphs/Odometer';
import type { OdometerVariant } from '../chicory/src/glyphs/Odometer';
import { PulseDot } from '../chicory/src/glyphs/PulseDot';
import type { PulseState } from '../chicory/src/glyphs/PulseDot';
import { QrBloom } from '../chicory/src/glyphs/QrBloom';
import type { QrState } from '../chicory/src/glyphs/QrBloom';
import { StatusRing } from '../chicory/src/glyphs/StatusRing';
import type { RingSize } from '../chicory/src/glyphs/StatusRing';
import { Vessel } from '../chicory/src/glyphs/Vessel';
import { Whisper, WhisperProvider } from '../chicory/src/glyphs/Whisper';
import { ringVisual } from '../chicory/src/scenes/activity/visual';
import { Comet } from '../chicory/src/scenes/send/Comet';
import { Pane } from '../chicory/src/stage/panes/Pane';
import { StageProvider, useStageStore } from '../chicory/src/stage/StageContext';
import { colors, space } from '../chicory/src/theme';
import {
  NOW,
  everyActivity,
  hex,
  requestOf,
  snapshotOf,
} from './fixtures';
import type { Lfbw } from './fixtures';
import { decided, present, spliced } from './fakes';
import { counter, sequence, useCount } from './shots';
import type { Counter, Shot, Take } from './shots';

/** A glyph alone, on a stage of its own and under a whisper provider. */
function Bench({ children }: PropsWithChildren) {
  const stage = useStageStore();
  return (
    <StageProvider value={stage}>
      <WhisperProvider>
        <View style={styles.bench}>{children}</View>
      </WhisperProvider>
    </StageProvider>
  );
}

const benched = (take: Take): Take => ({
  ...take,
  view: <Bench>{take.view}</Bench>,
});

/** A glyph drawn and left alone. */
const glyph = (name: string, view: () => ReactElement): Shot => ({
  name,
  make: () => benched({ view: view() }),
});

/** A glyph drawn as `views`, in turn. */
const changing = (name: string, views: () => ReactElement[]): Shot => ({
  name,
  make: () => benched(sequence(...views())),
});

/** A glyph drawn, then touched by `steps`. */
const touched = (name: string, make: () => Take): Shot => ({
  name,
  make: () => benched(make()),
});

// The bloom.

const MODES: BloomMode[] = ['still', 'breathe', 'chase', 'ratchet'];
const TONES: BloomTone[] = ['live', 'test', 'dormant'];
const EVENTS: BloomEvent['kind'][] = ['burst', 'wilt', 'fold', 'fall', 'shake'];

/** The status row's mark, pulled open and let go, over and over. */
function Pulled() {
  const pull = useSharedValue(0);
  useEffect(() => {
    pull.set(withRepeat(withTiming(1, { duration: 500 }), -1, true));
  }, [pull]);
  const opening = useDerivedValue(() => pull.get());
  return <Bloom size={96} opening={opening} />;
}

const counted = (lit: number) => <Bloom size={120} lit={lit} />;

const blooms: Shot[] = [
  ...MODES.flatMap(mode =>
    TONES.map(tone =>
      glyph(`bloom, ${mode} in ${tone}`, () => (
        <Bloom size={96} mode={mode} tone={tone} />
      )),
    ),
  ),
  glyph('bloom as the mark', () => <Bloom size={28} detail="mark" />),
  glyph('bloom as the mark, a backup to save', () => (
    <Bloom size={28} detail="mark" halo />
  )),
  glyph('bloom breathing its centre, setup under way', () => (
    <Bloom size={96} mode="breathe" breath="center" open={0.6} />
  )),
  glyph('bloom as a closed bud', () => (
    <Bloom size={120} open={0.08} mode="breathe" />
  )),
  ...EVENTS.map(kind =>
    changing(`bloom, ${kind}`, () => [
      <Bloom size={96} />,
      <Bloom size={96} event={{ kind, key: 1 }} />,
    ]),
  ),
  changing('bloom counting the words of a phrase', () =>
    [0, 6, 12, 13, 24, 25].map(counted),
  ),
  glyph('bloom pulled open', () => <Pulled />),
  changing('bloom unfolding as it leaves', () => [
    <Bloom size={96} open={0.3} unfoldOnExit={600} />,
    <View />,
  ]),
];

// The odometer.

const { totalSats, availableSats, pendingSats } = snapshotOf().balance;
const VARIANTS: OdometerVariant[] = [
  'hero',
  'amount',
  'amountDetail',
  'line',
  'row',
];

const hero = (over: Partial<React.ComponentProps<typeof Odometer>> = {}) => (
  <Odometer sats={totalSats} unit="sats" variant="hero" {...over} />
);

const odometers: Shot[] = [
  ...VARIANTS.map(variant =>
    glyph(`odometer, ${variant}`, () => (
      <Odometer sats={totalSats} unit="sats" variant={variant} />
    )),
  ),
  glyph('odometer, hero in BTC', () => hero({ unit: 'btc' })),
  glyph('odometer, hero in ₿', () => hero({ symbol: true })),
  glyph('odometer, hero in ₿, hidden', () =>
    hero({ symbol: true, masked: true }),
  ),
  glyph('odometer, hero stepped down for the whole supply', () =>
    hero({ sats: 2_100_000_000_000_000, unit: 'btc' }),
  ),
  glyph('odometer, a received row', () => (
    <Odometer sats={4_200} unit="sats" variant="row" sign="+" />
  )),
  glyph('odometer, a sent row, hidden', () => (
    <Odometer sats={4_200} unit="sats" variant="row" sign="-" masked />
  )),
  glyph('odometer, a received row in ₿', () => (
    <Odometer sats={4_200} unit="sats" symbol variant="row" sign="+" />
  )),
  glyph('odometer, a sent detail in ₿', () => (
    <Odometer sats={4_200} unit="sats" symbol variant="amountDetail" sign="-" />
  )),
  changing('odometer, rolling', () =>
    [availableSats, totalSats, totalSats + 1_234_567, 0].map(sats =>
      hero({ sats }),
    ),
  ),
  changing('odometer, swapping unit', () =>
    (['sats', 'btc', 'sats'] as const).map(unit => hero({ unit })),
  ),
  // Each tap on the balance: sats, then ₿, then BTC, and sats again.
  changing('odometer, rolling through its faces', () =>
    (
      [
        ['sats', false],
        ['sats', true],
        ['btc', false],
        ['sats', false],
      ] as const
    ).map(([unit, symbol]) => hero({ unit, symbol })),
  ),
  changing('odometer, hiding and showing', () =>
    [false, true, false].map(masked => hero({ masked })),
  ),
  changing('odometer, going stale', () =>
    [false, true].map(isStale => hero({ stale: isStale })),
  ),
  changing('odometer, counting up a receipt', () =>
    [0, 10_000].map(sats => (
      <Odometer sats={sats} unit="sats" variant="amount" duration={900} />
    )),
  ),
  // Places grow as the count reaches them, never a leading 0 or a
  // separator before the first digit.
  changing('odometer, counting up from 0 to a balance', () =>
    [0, 65_446].map(sats => hero({ sats })),
  ),
  changing('odometer, counting up a receipt with its sign', () =>
    [0, 888, 5_000].map(sats => (
      <Odometer
        sats={sats}
        unit="sats"
        variant="amount"
        sign="+"
        duration={700}
      />
    )),
  ),
  changing('odometer, a new place rolling in and away', () =>
    [9_999, 10_000, 9_999].map(sats => hero({ sats })),
  ),
];

// The vessel.

/** Every reason money waits in the vessel (vesselVisual). */
const WAITS: Array<[string, Partial<Lfbw>]> = [
  ['money arriving', {}],
  ['below the channel floor', decided('wait', 'below-floor')],
  ['moving into the channel', decided('splice-in')],
  ['opening a channel', decided('open')],
  ['opening a dual-funded channel', decided('open-v2')],
  ['waiting on fees', decided('wait', 'fee-too-high')],
  ['a failed move, with its retry', decided('failed')],
  ['splicing', decided('wait', 'splicing')],
  ['a channel confirming', decided('wait', 'channel-pending')],
  ['unconfirmed', decided('wait', 'unconfirmed')],
  ['a conflicted splice', spliced('conflicted')],
  ['a reverted splice', spliced('reverted')],
  ['unpaired funding', { unpairedFunding: { at: NOW } }],
];

const vessel = (
  lfbw: Partial<Lfbw>,
  over: Partial<React.ComponentProps<typeof Vessel>> = {},
) => (
  <View style={styles.wide}>
    <Vessel
      availableSats={availableSats}
      pendingSats={pendingSats}
      lfbw={snapshotOf({ lfbw }).wallet.lfbw}
      unit="sats"
      {...over}
    />
  </View>
);

const TOUCH = { nativeEvent: { pageX: 0, pageY: 0 } };

const vessels: Shot[] = [
  ...WAITS.map(([why, lfbw]) => glyph(`vessel, ${why}`, () => vessel(lfbw))),
  glyph('vessel, below the channel floor in BTC', () =>
    vessel(decided('wait', 'below-floor'), { unit: 'btc' }),
  ),
  glyph('vessel, everything spendable', () =>
    vessel({}, { availableSats: totalSats, pendingSats: 0 }),
  ),
  glyph('vessel, hidden', () => vessel(decided('failed'), { masked: true })),
  glyph('vessel, stale', () => vessel({}, { stale: true })),
  glyph('vessel, on a test network', () => vessel({}, { test: true })),
  glyph('vessel, a channel confirming on a test network', () =>
    vessel(decided('wait', 'channel-pending'), { test: true }),
  ),
  glyph('vessel, out of reach while the primary is away', () =>
    vessel(
      {},
      {
        availableSats: 0,
        pendingSats: 0,
        totalSats: 84_488,
        connected: false,
      },
    ),
  ),
  glyph('vessel, held back with the primary connected', () =>
    vessel({}, { availableSats: 0, pendingSats: 0, totalSats: 84_488 }),
  ),
  glyph('vessel, part out of reach and part arriving', () =>
    vessel(decided('wait', 'channel-pending'), {
      availableSats: 28_929,
      pendingSats: 30_000,
      totalSats: 153_963,
    }),
  ),
  glyph('vessel, a channel reserve, which is not out of reach', () =>
    vessel({}, { availableSats: 87_504, pendingSats: 0, totalSats: 88_488 }),
  ),
  touched('vessel, opened by a tap', () => {
    const label = copy.home.split(availableSats, pendingSats);
    return {
      view: vessel(decided('wait', 'below-floor')),
      steps: [
        drive => drive.fire(label, 'onResponderGrant', TOUCH),
        drive => drive.fire(label, 'onResponderRelease', TOUCH),
      ],
    };
  }),
  touched('vessel in ₿, opened by a tap', () => {
    const label = copy.home.split(availableSats, pendingSats);
    return {
      view: vessel(decided('wait', 'below-floor'), { symbol: true }),
      steps: [
        drive => drive.fire(label, 'onResponderGrant', TOUCH),
        drive => drive.fire(label, 'onResponderRelease', TOUCH),
      ],
    };
  }),
  changing('vessel, money moving into the channel, with its ripple', () => [
    vessel(decided('splice-in')),
    vessel(decided('splice-in'), {
      availableSats: availableSats + 7_500,
      pendingSats: pendingSats - 7_500,
    }),
  ]),
  // The pill swells from its hairline with its hatch drawn full height.
  changing('vessel, swelling into money out of reach', () => [
    vessel({}, { availableSats: totalSats, pendingSats: 0 }),
    vessel({}, { availableSats: 28_929, pendingSats: 0, totalSats: 120_963 }),
  ]),
  changing('vessel, a wait that changes', () => [
    vessel({}),
    vessel(decided('wait', 'fee-too-high')),
    vessel(decided('splice-in')),
    vessel(decided('wait', 'below-floor')),
    vessel({}, { availableSats: totalSats, pendingSats: 0 }),
  ]),
];

// The connection dot.

const PULSES: PulseState[] = ['live', 'reconnecting', 'failed', 'hidden'];

const dots: Shot[] = [
  ...PULSES.map(state =>
    glyph(`pulse dot, ${state}`, () => <PulseDot state={state} pingKey={1} />),
  ),
  changing('pulse dot, pinging', () =>
    [1, 2, 3].map(pingKey => <PulseDot state="live" pingKey={pingKey} />),
  ),
  changing('pulse dot, losing and finding the connection', () =>
    (['live', 'reconnecting', 'failed', 'live'] as const).map(state => (
      <PulseDot state={state} pingKey={1} />
    )),
  ),
];

// The status ring.

const ring = (name: string, size: RingSize = 120, test = false) => (
  <StatusRing
    size={size}
    visual={ringVisual(everyActivity()[name])}
    test={test}
  />
);

/** One payment for each ring the fixtures draw, the first that draws it. */
function ringNames(): string[] {
  const seen = new Set<string>();
  return Object.entries(everyActivity())
    .filter(([, item]) => {
      const look = JSON.stringify(ringVisual(item));
      if (seen.has(look)) return false;
      seen.add(look);
      return true;
    })
    .map(([name]) => name);
}

const TRANSITIONS: Array<[string, string[]]> = [
  ['completing', ['sent pending', 'sent completed']],
  ['failing', ['sent pending', 'sent failed']],
  ['held', ['sent pending', 'sent uncertain']],
  ['expiring', ['request pending', 'request expired']],
  [
    'filling',
    ['request pending', 'request partly paid', 'request paid, confirming'],
  ],
];

const rings: Shot[] = [
  ...ringNames().map(name => glyph(`ring, ${name}`, () => ring(name, 40))),
  ...['sent completed', 'sent uncertain', 'sent failed'].flatMap(name =>
    ([96, 120] as const).map(size =>
      glyph(`ring at ${size}, ${name}`, () => ring(name, size)),
    ),
  ),
  glyph('ring on a test network', () => ring('sent pending', 120, true)),
  ...TRANSITIONS.map(([how, names]) =>
    changing(`ring ${how}`, () => names.map(name => ring(name))),
  ),
];

// The copy chip.

const TXID = hex(400);
const CHIP = copy.receive.copyValue(copy.receive.transaction);
const chip = () => <CopyChip label={copy.receive.transaction} value={TXID} />;

const chips: Shot[] = [
  glyph('copy chip', chip),
  touched('copy chip, copied', () => ({
    view: chip(),
    steps: [drive => drive.press(CHIP)],
  })),
  touched('copy chip, opened in full', () => ({
    view: chip(),
    steps: [drive => drive.fire(CHIP, 'onLongPress')],
  })),
];

// The hold.

const SEND = copy.send.sendSats(4_200);
const noop = () => {};
const hold = (over: Partial<React.ComponentProps<typeof HoldButton>> = {}) => (
  <HoldButton accessibilityLabel={SEND} onCommit={noop} {...over} />
);

const holds: Shot[] = [
  glyph('hold', () => hold()),
  glyph('hold, with warnings', () => hold({ warning: true })),
  glyph('hold, disabled', () => hold({ disabled: true })),
  glyph('hold, sending', () => hold({ busy: true })),
  glyph('hold, on a test network', () => hold({ test: true })),
  touched('hold, held', () => ({
    view: hold(),
    steps: [drive => drive.hold(SEND, 'down')],
  })),
  touched('hold, let go early', () => ({
    view: hold(),
    steps: [drive => drive.hold(SEND, 'down'), drive => drive.hold(SEND, 'up')],
  })),
  touched('hold, committing', () => ({
    view: hold(),
    steps: [
      drive => drive.hold(SEND, 'down'),
      drive => drive.hold(SEND, 'complete'),
    ],
  })),
];

// The comet.

const comet = (color: string) => <Comet size={88} stroke={4} color={color} />;

/** The comet with its ring closing `to` (0 to 1), as a result lands on it. */
function Closing({ to }: { to: number }) {
  const closing = useSharedValue(0);
  useEffect(() => {
    closing.set(withTiming(to, { duration: 320 }));
  }, [closing, to]);
  return <Comet size={88} stroke={4} color={palette.bloom} closing={closing} />;
}

const comets: Shot[] = [
  glyph('comet, in flight', () => comet(palette.bloom)),
  glyph('comet, on a test network', () => comet(palette.slate)),
  changing('comet, closing the ring', () =>
    [0, 0.5, 1].map(to => <Closing to={to} />),
  ),
];

// The expiry ring.

const expiry = (
  left: number,
  over: Partial<React.ComponentProps<typeof ExpiryRing>> = {},
) => (
  <ExpiryRing
    size={96}
    createdAt={Date.now() - 60_000 + left}
    expiresAt={Date.now() + left}
    {...over}
  />
);

const expiries: Shot[] = [
  glyph('expiry ring, a minute left', () => expiry(60_000)),
  glyph('expiry ring, running late', () => expiry(9_000)),
  glyph('expiry ring, nearly out', () => expiry(2_500)),
  glyph('expiry ring, running out', () => expiry(800)),
  glyph('expiry ring, run out', () => expiry(-1)),
  glyph('expiry ring, around a card', () =>
    expiry(30_000, { shape: 'rect', width: 240, height: 140, radius: 20 }),
  ),
  glyph('expiry ring, on a test network', () => expiry(30_000, { test: true })),
];

// The code.

const qr = (state: QrState) => (
  <QrBloom
    value={present(requestOf()).uri}
    size={224}
    state={state}
    accessibilityLabel={copy.receive.qr}
  />
);

const codes: Shot[] = [
  glyph('code, revealed', () => qr('shown')),
  changing('code, expiring', () => [qr('shown'), qr('expired')]),
  changing('code, paid', () => [qr('shown'), qr('paid')]),
  changing('code, scattered', () => [qr('shown'), qr('scattered')]),
  changing('code, replaced after it expired', () => [
    qr('expired'),
    qr('shown'),
  ]),
];

// The whisper.

const HEARD = copy.health.reconnecting;

function InPane({ active }: { active: Counter }) {
  const gone = useCount(active) > 0;
  return (
    <Pane active={!gone}>
      <Whisper label={HEARD}>
        <PulseDot state="reconnecting" />
      </Whisper>
    </Pane>
  );
}

const whispered = () => (
  <Whisper label={HEARD}>
    <PulseDot state="reconnecting" />
  </Whisper>
);

const whispers: Shot[] = [
  glyph('whisper, waiting to be asked', whispered),
  touched('whisper, shown', () => ({
    view: whispered(),
    steps: [drive => drive.whisper(HEARD)],
  })),
  touched('whisper, its pane gone out of use', () => {
    const active = counter();
    return {
      view: <InPane active={active} />,
      steps: [drive => drive.whisper(HEARD), active.next],
    };
  }),
];

export const GLYPHS: Shot[] = [
  ...blooms,
  ...odometers,
  ...vessels,
  ...dots,
  ...rings,
  ...chips,
  ...holds,
  ...comets,
  ...expiries,
  ...codes,
  ...whispers,
];

const styles = StyleSheet.create({
  bench: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    backgroundColor: colors.background,
  },
  wide: { alignSelf: 'stretch' },
});
