import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { validatePrimaryUri } from '@beignet/wallet-core';
import type { Network, WalletSnapshot } from '@beignet/wallet-core';
import { RecoveryPhraseBody } from '../components/RecoveryPhrase';
import type { PhraseLanding } from '../components/RecoveryPhrase';
import { announce } from '../design/announce';
import { copy } from '../design/copy';
import { Glyph } from '../design/glyphs';
import { haptics } from '../design/haptics';
import { palette } from '../design/palette';
import { useFocus } from '../motion/focus';
import {
  dropOut,
  fadeIn,
  fadeOut,
  riseIn,
  smooth,
  stagger,
} from '../motion/presets';
import { durations, springs } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';
import { unlockGlyph } from '../scenes/phases/visual';
import { EmptyWallet } from '../scenes/settings/EmptyWallet';
import { DiagnosticsPanel } from '../scenes/settings/Diagnostics';
import { useFieldScan } from '../scenes/settings/fieldScan';
import {
  AutoPayGlyph,
  HapticsGlyph,
  ShackleGlyph,
  useShackle,
} from '../scenes/settings/glyphMotion';
import { ShareSlider } from '../scenes/settings/ShareSlider';
import { autoPayLimit } from '../scenes/send/autoPay';
import { Odometer } from '../glyphs/Odometer';
import { steady } from '../motion/steady';
import {
  ActionRow,
  DISC,
  DisclosureRow,
  GlyphDisc,
  GroupHeader,
  HubItem,
  LeadTitle,
  NoteLine,
  ROW_GLYPH,
  ROW_HEIGHT,
  RowContent,
  ToggleLine,
  ToggleRow,
  haloOut,
  hubStyles,
  useDip,
  useRevealOnOpen,
} from '../scenes/settings/hub';
import {
  answering,
  cardBloom,
  cardStatus,
  cardWords,
  drainState,
  drainWords,
  hubItems,
  networkWords,
  nextOpen,
  primaryWords,
} from '../scenes/settings/hubModel';
import type {
  HubEdge,
  HubEntry,
  HubGroup,
  HubRow,
} from '../scenes/settings/hubModel';
import { WalletCard } from '../scenes/settings/WalletCard';
import {
  Action,
  Chevron,
  CopyLine,
  DrawnGlyph,
  Field,
  HaloRing,
  Line,
  Link,
  NetworkChoice,
  Note,
  Row,
  SettingsNetwork,
  nodeAddressText,
  testNetwork,
  unbroken,
  useAccent,
  useGlyphSize,
  wholeWords,
} from '../scenes/settings/ui';
import { duringSystemPrompt } from '../stage/systemPrompt';
import { usePaneActive } from '../stage/panes/Pane';
import { useHapticsPreference } from '../services/hapticsPreference';
import {
  setAutoPayPreference,
  useAutoPay,
} from '../services/autoPayPreference';
import type { WalletAdapter } from '../services/wallet';
import { NETWORKS, defaultProfile, loadNetworkPreferences } from '../services/networks';
import type { NetworkProfile } from '../services/networks';
import { NetworkSettings } from './NetworkSettings';
import { useSettingsOutcome } from '../services/settingsOutcome';
import type { SettingsOutcome } from '../services/settingsOutcome';
import {
  BIOMETRY_NAMES,
  isLockEnabled,
  requireUnlock,
  setLockEnabled,
  supportedBiometry,
} from '../services/lock';
import type { BiometryKind } from '../services/lock';
import {
  FULL_BACKUP_MIN_PASSPHRASE,
  exportFullBackup,
  fullBackupAvailable,
} from '../services/fullBackup';
import { APP_VERSION } from '../version';
import { space, type } from '../theme';
import type { Unit } from '../theme';

// The new wallet sheet and the picker are drawn in the Settings language
// too, and the suites find them here.
export { CreateWalletScreen } from '../scenes/settings/CreateWallet';
export { WalletPicker } from '../scenes/settings/WalletPicker';

const words = copy.settings;

/** Each group's header, in the words a screen reader hears. */
const GROUP_TITLES: Record<HubGroup, string> = {
  wallet: words.wallet.heading,
  phone: words.phone.heading,
  funds: words.funds.heading,
  help: words.help.heading,
};

/**
 * A setting's outcome is felt and said once, as it lands: success, a
 * caveat, or a refusal with its reason, each with its haptic and its words
 * read out, since it may land well after the tap. The screen keeps the
 * outcome while the row that shows it is closed and opened again, so this
 * is the screen's to do and never the drawing's: opening the row again
 * replays nothing.
 */
function useOutcomeFeedback(outcome: SettingsOutcome) {
  useEffect(() => {
    if (outcome.phase === 'success') haptics.success();
    if (outcome.phase === 'warning') haptics.warning();
    if (outcome.phase === 'error') haptics.error();
    if (
      outcome.phase === 'success' ||
      outcome.phase === 'warning' ||
      outcome.phase === 'error'
    ) {
      announce(outcome.message);
    }
  }, [outcome]);
}

/**
 * A setting's result, as the browser app reports it: in flight, saved, saved
 * with a caveat, or refused with the reason. It rises in with its glyph
 * drawing each time it is drawn; it is felt and said once, by the screen
 * (`useOutcomeFeedback`).
 */
function Outcome({ outcome }: { outcome: SettingsOutcome }) {
  if (outcome.phase === 'idle') return null;
  return (
    <Note
      key={`${outcome.phase}:${outcome.message}`}
      tone={outcome.phase}
      announce={false}
    >
      {outcome.message}
    </Note>
  );
}

/**
 * What Network & servers opens: the network this wallet is on and the way
 * to another. Choosing a network only proposes it; the switch is its own
 * press, with the line about what the other network keeps. The servers
 * behind each network open below, in place, behind Edit servers, and the
 * networks give the editor their room while it is open. The editor leaves
 * out each network's default primary node, which only seeds a new wallet:
 * this wallet's own node changes under Primary node, and nowhere else.
 */
function NetworkPanel({
  snapshot,
  busy,
  switchError,
  onNetwork,
}: {
  snapshot: WalletSnapshot;
  busy: boolean;
  switchError: string;
  onNetwork: (profile: NetworkProfile) => Promise<void>;
}) {
  const current = snapshot.wallet.network;
  const [editing, setEditing] = useState(false);
  // Switching networks used to mean opening a settings sub-form, filling in
  // server fields and pressing apply. The network itself is the thing people
  // want to change, so it is the first thing here; the servers stay behind
  // the editor.
  const [target, setTarget] = useState<Network>(current);
  const [switching, setSwitching] = useState(false);
  // The network the editor opens on, when a switch sent it there.
  const [shown, setShown] = useState<Network | undefined>(undefined);
  useEffect(() => {
    setTarget(current);
  }, [current]);
  async function switchTo(network: Network) {
    if (switching || network === current) return;
    setSwitching(true);
    try {
      const preferences = await loadNetworkPreferences();
      const profile = preferences.profiles[network];
      // A network nobody has given a server (testnet and regtest ship
      // without one) cannot be switched to. Its servers open instead, where
      // the server goes and the editor says what is missing.
      if (!profile.electrum.host.trim()) {
        setTarget(current);
        setShown(network);
        setEditing(true);
        return;
      }
      await onNetwork(profile);
    } catch {
      // The reason is held by the session, which outlives this screen: a
      // switch replaces it with a full-page wait, so anything set here would
      // be unmounted before it could be read.
      setTarget(current);
    } finally {
      setSwitching(false);
    }
  }
  return (
    <>
      {editing ? null : (
        <NetworkChoice
          options={NETWORKS}
          value={target}
          disabled={switching || busy}
          onChange={setTarget}
        />
      )}
      {!editing && target !== current ? (
        <Reanimated.View
          entering={riseIn()}
          exiting={dropOut(8)}
          style={styles.stack}
        >
          <Note glyph={testNetwork(target) ? 'flask' : 'info'}>
            {words.wallet.switchNote(target)}
          </Note>
          <Action
            label={words.wallet.switchTo(target)}
            glyph="swap"
            busy={switching}
            onPress={() => switchTo(target)}
          />
        </Reanimated.View>
      ) : null}
      {switchError ? <Note tone="error">{switchError}</Note> : null}
      <Row
        glyph="cog"
        label={words.wallet.editServers}
        expanded={editing}
        onPress={() => {
          setShown(undefined);
          setEditing(!editing);
        }}
      />
      {editing ? (
        <Reanimated.View entering={riseIn()} exiting={dropOut(8)}>
          <NetworkSettings
            initialNetwork={current}
            showNetwork={shown}
            busy={busy}
            defaultPrimary={false}
            onApply={onNetwork}
          />
        </Reanimated.View>
      ) : null}
    </>
  );
}

/**
 * Where the primary node's setup is, in words: ready, setting up or failed
 * (REDESIGN.md 6, Wallet health), and waiting while the engine has reported
 * nothing. Never the engine's own value, which is a lowercase code.
 */
export function setupWord(primary: WalletSnapshot['primary']): string {
  const p = words.primary;
  if (primary.setup === 'ready') return p.setupReady;
  if (primary.setupError || primary.setup === 'failed') return p.setupFailed;
  return primary.setup ? p.setupPending : p.waiting;
}

/**
 * What Primary node opens: the node trusted for instant funding, how its
 * setup went and why it stopped if it did, its address, and a change that
 * reports saving and reconnecting as two separate outcomes. Whether it is
 * connected is the row's value, above.
 *
 * Its address can be scanned. The scan opens over Settings, which stays
 * drawn and in place beneath it, and a code read fills the field, where a
 * screen reader lands (`useFieldScan`); nothing is saved until Save is
 * pressed. A draft half typed goes with the row as it closes, as a row
 * that opens in place lets go of what it held; the outcome of a save is
 * the screen's and stays.
 */
function PrimaryPanel({
  snapshot,
  outcome,
  busy,
  onSave,
  onRetry,
}: {
  snapshot: WalletSnapshot;
  outcome: SettingsOutcome;
  busy: boolean;
  onSave: (
    uri: string,
    done: () => void,
    fallbackUri?: string,
  ) => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [fallback, setFallback] = useState(snapshot.primary.fallbackUri || '');
  // Closing the editor removes the field a screen reader was on, so it goes
  // back to the control that opened it.
  const [closed, setClosed] = useState(false);
  const close = () => {
    setEditing(false);
    setClosed(true);
  };
  const [primary, setPrimary] = useState(
    snapshot.primary.uri || defaultProfile(snapshot.wallet.network).primaryUri,
  );
  // The node field follows the wallet it describes: a wallet whose primary is
  // filled in once setup completes, or a different wallet altogether, must not
  // leave the previous address one tap from being saved.
  useEffect(() => {
    setPrimary(snapshot.primary.uri || defaultProfile(snapshot.wallet.network).primaryUri);
    setFallback(snapshot.primary.fallbackUri || '');
  }, [snapshot.primary.uri, snapshot.primary.fallbackUri]);
  const p = words.primary;
  const scan = useFieldScan({
    purpose: 'primary',
    validate: validatePrimaryUri,
    onCode: setPrimary,
    test: testNetwork(snapshot.wallet.network),
  });
  return (
    <>
      <Line label={p.setup} value={setupWord(snapshot.primary)} />
      {snapshot.primary.setupError ? (
        <Note tone="error">{snapshot.primary.setupError}</Note>
      ) : null}
      <Outcome outcome={outcome} />
      {editing ? (
        <Reanimated.View
          entering={riseIn()}
          exiting={dropOut(8)}
          style={styles.stack}
        >
          {/* Measured as the scan opens: a code read collapses into the
              field, and the disc grows out of the button. */}
          <View ref={scan.into} collapsable={false}>
            <Field
              label={p.address}
              value={primary}
              onChangeText={setPrimary}
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
              label={p.scan}
              glyph="scan"
              tone="quiet"
              focus={scan.landOn === 'control'}
              onPress={scan.open}
            />
          </View>
          {/@iroh:/i.test(primary) ? (
            <>
              <Note>{p.iroh}</Note>
              <Field
                label={p.fallback}
                value={fallback}
                onChangeText={setFallback}
                autoCapitalize="none"
                multiline
                mono
                editable={!busy}
              />
              <Note>{p.fallbackHint}</Note>
            </>
          ) : null}
          <Note>{p.keeps}</Note>
          <Action
            label={p.save}
            glyph="check"
            onPress={() =>
              onSave(
                primary.trim(),
                close,
                /@iroh:/i.test(primary) ? fallback.trim() : undefined,
              )
            }
            busy={busy}
            disabled={!primary.trim()}
          />
          <Link label={p.cancel} tone="steam" disabled={busy} onPress={close} />
        </Reanimated.View>
      ) : (
        <>
          <CopyLine
            label={p.address}
            value={snapshot.primary.uri || p.none}
            shown={
              snapshot.primary.uri
                ? nodeAddressText(snapshot.primary.uri)
                : undefined
            }
            copyLabel={p.copy}
            copiedLabel={p.copied}
          />
          <Link
            label={p.change}
            glyph="pencil"
            disabled={busy}
            focus={closed}
            onPress={() => {
              setEditing(true);
              setClosed(false);
              scan.land('field');
            }}
          />
          {!snapshot.primary.connected ? (
            <Action
              label={p.retry}
              glyph="refresh"
              tone="quiet"
              onPress={onRetry}
              busy={busy}
            />
          ) : null}
        </>
      )}
    </>
  );
}

/**
 * The app lock, when this device can offer one: a switch whose glyph is the
 * way this phone proves its owner, as the lock screen draws it
 * (`unlockGlyph`). Turning it on asks for the biometric at once
 * (`setLockEnabled`), and that prompt is one the app raised
 * (`duringSystemPrompt`), so Settings stays in view behind it rather than
 * going under the privacy cover; once it confirms, the glyph draws itself
 * in again and its disc fills. On desktop, turning it off asks as well.
 * Otherwise it would release recovery phrases without a prompt.
 *
 * It draws nothing in its row until the phone has said what it offers, so
 * a phone with Face ID never flashes the line for a phone with none.
 */
const AppLockRow = memo(function AppLockLine({
  edge,
  step,
}: {
  edge: HubEdge;
  step: number;
}) {
  const { accent } = useAccent();
  const size = useGlyphSize(ROW_GLYPH);
  // Not yet answered, then the phone's biometry, or null for none at all.
  const [kind, setKind] = useState<BiometryKind | null | undefined>();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Counts each time the lock turns on, so the glyph draws itself again.
  const [drawn, setDrawn] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([supportedBiometry(), isLockEnabled()])
      .then(([supported, on]) => {
        if (!active) return;
        setKind(supported);
        setEnabled(on);
      })
      .catch(() => {
        if (active) setKind(null);
      });
    return () => {
      active = false;
    };
  }, []);
  let line: ReactNode = <View style={styles.waiting} />;
  if (kind === null) {
    line = <NoteLine glyph="lock">{words.phone.noLock}</NoteLine>;
  } else if (kind) {
    const name = BIOMETRY_NAMES[kind];
    const glyph = unlockGlyph(kind);
    line = (
      <ToggleLine
        glyph={
          drawn > 0 ? (
            <DrawnGlyph key={drawn} name={glyph} size={size} color={accent} />
          ) : (
            <Glyph name={glyph} size={size} color={accent} />
          )
        }
        label={words.phone.require(name)}
        accessibilityLabel={words.phone.requireLabel(name)}
        value={enabled}
        disabled={busy}
        error={error}
        onValueChange={async next => {
          setBusy(true);
          setError('');
          try {
            await duringSystemPrompt(() => setLockEnabled(next));
            setEnabled(next);
            if (next) setDrawn(count => count + 1);
          } catch (e) {
            setError(e instanceof Error ? e.message : words.phone.lockFailed);
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  }
  return (
    <HubItem edge={edge} step={step}>
      {line}
    </HubItem>
  );
});

/**
 * Settings > Haptics (REDESIGN.md rule 7), the only thing that silences
 * them. Reading it here also applies it, until the app does so at launch.
 * Its phone buzzes as they come back on, as the phone itself does.
 */
const HapticsRow = memo(function HapticsLine({
  edge,
  step,
}: {
  edge: HubEdge;
  step: number;
}) {
  const { on, set } = useHapticsPreference();
  const { accent } = useAccent();
  const size = useGlyphSize(ROW_GLYPH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <ToggleRow
      edge={edge}
      step={step}
      glyph={<HapticsGlyph on={on} size={size} color={accent} />}
      label={words.phone.haptics}
      accessibilityLabel={words.phone.haptics}
      value={on}
      disabled={busy}
      error={error}
      onValueChange={async next => {
        setBusy(true);
        setError('');
        try {
          await set(next);
          // Turning them back on is felt at once, so it is known to work.
          if (next) haptics.tick();
        } catch (e) {
          setError(e instanceof Error ? e.message : words.phone.hapticsFailed);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
});

/**
 * Settings > Auto-pay (REDESIGN.md rule 5): a switch, off until it is
 * turned on, whose limit opens under it while it is on. Its glyph is the
 * scan frame round a bolt, which closes on the bolt as it turns on. On, the
 * row grows to show the share of the balance a scanned Lightning code may
 * spend and still pay itself: the share in large figures, popping at each
 * detent, the sats it stands for today rolling beside it, the slider in
 * detents of 5%, and what it does. The share is 50% the first time and kept
 * while it is off; the thumb grows out to it as the row opens. A save that
 * fails keeps what was there and says so under the switch.
 *
 * Switched on, the row is brought into view as it grows (`useRevealOnOpen`),
 * so a limit opened at the foot of the page is not opened out of sight; a
 * Settings opened with Auto-pay already on stays where it is.
 */
const AutoPayRow = memo(function AutoPayLine({
  edge,
  step,
  availableSats,
  unit,
  symbol,
  stale,
}: {
  edge: HubEdge;
  step: number;
  availableSats: number;
  unit: Unit;
  symbol: boolean;
  stale: boolean;
}) {
  const { on, share } = useAutoPay();
  const { accent } = useAccent();
  const { reduced } = useMotionPrefs();
  const size = useGlyphSize(ROW_GLYPH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The share under the thumb while it moves, and whether the switch was
  // turned on here: then the thumb grows out to the share, the readout with
  // it, and the grown row is brought into view. A Settings opened with
  // Auto-pay already on is drawn at rest, where it is.
  const [moving, setMoving] = useState<number | null>(null);
  const [turned, setTurned] = useState(false);
  const woke = turned && !reduced;
  const shown = moving ?? share;
  const { frame, onLayout } = useRevealOnOpen(on && turned);

  const save = async (next: { on: boolean; share: number }) => {
    setBusy(true);
    setError('');
    try {
      await setAutoPayPreference(next);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : words.phone.autoPayFailed);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <HubItem edge={edge} step={step} frame={frame} onLayout={onLayout}>
      <ToggleLine
        glyph={<AutoPayGlyph on={on} size={size} color={accent} />}
        label={words.phone.autoPay}
        accessibilityLabel={words.phone.autoPayLabel}
        value={on}
        disabled={busy}
        error={error}
        onValueChange={async next => {
          // Opened, the thumb grows out from 0 to the share it keeps.
          setTurned(next);
          setMoving(next && !reduced ? 0 : null);
          if (!(await save({ on: next, share }))) setMoving(null);
        }}
      />
      {on ? (
        <RowContent>
          <AutoPayLimit
            shown={shown}
            share={share}
            availableSats={availableSats}
            unit={unit}
            symbol={symbol}
            stale={stale}
            wake={woke}
            onPreview={setMoving}
            onChoose={async next => {
              setMoving(next);
              await save({ on: true, share: next });
              setMoving(null);
            }}
          />
        </RowContent>
      ) : null}
    </HubItem>
  );
});

/** How far the share's figures pop as it lands on a new detent. */
const SHARE_POP = 1.06;

/**
 * Auto-pay's limit: the share and the sats it stands for, the slider, and
 * what it does. The readout is drawn for the eye; a screen reader hears it
 * all as the slider's value.
 */
function AutoPayLimit({
  shown,
  share,
  availableSats,
  unit,
  symbol,
  stale,
  wake,
  onPreview,
  onChoose,
}: {
  shown: number;
  share: number;
  availableSats: number;
  unit: Unit;
  symbol: boolean;
  stale: boolean;
  wake: boolean;
  onPreview: (share: number) => void;
  onChoose: (share: number) => void;
}) {
  const { reduced } = useMotionPrefs();
  const scale = useSharedValue(1);
  const seen = useRef(shown);
  useEffect(() => {
    if (seen.current === shown) return;
    seen.current = shown;
    if (reduced) return;
    scale.set(
      steady(
        withSequence(
          withTiming(SHARE_POP, { duration: durations.tick }),
          withSpring(1, springs.snap),
        ),
      ),
    );
  }, [shown, reduced, scale]);
  const popping = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));
  const limit = autoPayLimit(availableSats, shown);
  const spoken = useCallback(
    (at: number) =>
      words.phone.autoPaySpoken(at, autoPayLimit(availableSats, at)),
    [availableSats],
  );
  return (
    <>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.limitReadout}
      >
        <Reanimated.View style={[styles.limitShare, popping]}>
          <Text style={styles.limitFigures} maxFontSizeMultiplier={1.6}>
            {words.phone.autoPayShare(shown)}
          </Text>
        </Reanimated.View>
        {shown === 0 ? (
          <Text style={styles.limitWords}>{words.phone.autoPayNothing}</Text>
        ) : (
          <View style={styles.limitSats}>
            <Text style={styles.limitWords}>{words.phone.autoPayUpTo}</Text>
            <Odometer
              sats={limit}
              unit={unit}
              symbol={symbol}
              stale={stale}
              variant="row"
              color={palette.steam}
            />
          </View>
        )}
      </View>
      <ShareSlider
        share={share}
        spoken={spoken}
        wake={wake}
        onPreview={onPreview}
        onChoose={onChoose}
      />
      <Text style={styles.limitNote}>{words.phone.autoPayNote}</Text>
    </>
  );
}

/**
 * Lock device wallet: it acts at once, whatever is open, since it is a way
 * out. Its lock's shackle closes as the finger lands and lifts back if the
 * finger slides away (`useShackle`).
 */
const LockRow = memo(function LockLine({
  edge,
  step,
  onDisconnect,
}: {
  edge: HubEdge;
  step: number;
  onDisconnect: () => void;
}) {
  const { accent } = useAccent();
  const size = useGlyphSize(ROW_GLYPH);
  const shackle = useShackle();
  return (
    <ActionRow
      edge={edge}
      step={step}
      label={words.wallet.lock}
      glyph={<ShackleGlyph size={size} color={accent} shut={shackle.shut} />}
      onPressIn={shackle.pressIn}
      onPressOut={shackle.pressOut}
      onPress={() => {
        shackle.release();
        return onDisconnect();
      }}
    />
  );
});

/**
 * What Erase wallet from this phone opens: the warning, felt as it opens
 * and where a screen reader lands, then the explicit button, behind the app
 * lock when one is on, because it deletes keys and channel state that a
 * phrase alone does not bring back. The lock's prompt is one the app raised
 * (`duringSystemPrompt`), so the warning stays in view behind it. Keep my
 * wallet closes the row, and a screen reader goes back to it.
 */
function ErasePanel({
  onErase,
  onKeep,
}: {
  onErase: () => Promise<void>;
  onKeep: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const e = words.erase;
  useEffect(() => {
    haptics.warning();
  }, []);
  return (
    <>
      <Note tone="warning" focus>
        {e.warning}
      </Note>
      {error ? <Note tone="error">{error}</Note> : null}
      <Action
        label={e.confirm}
        tone="danger"
        glyph="alert"
        busy={busy}
        onPress={async () => {
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            const confirmed = await duringSystemPrompt(() =>
              requireUnlock(e.prompt),
            );
            if (!confirmed) throw new Error(e.unconfirmed);
            await onErase();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : e.failed);
          } finally {
            setBusy(false);
          }
        }}
      />
      <Link label={e.keep} tone="steam" disabled={busy} onPress={onKeep} />
    </>
  );
}

/**
 * What Full backup to a file opens on desktop: the warning, landed on as it
 * opens, a passphrase typed twice, and Save full backup behind the app lock
 * when one is on, since the file holds every key. The main process asks where
 * to save it and writes it; the page never holds the file. The passphrase is
 * cleared once the backup is saved.
 */
function FullBackupPanel() {
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const b = words.fullBackup;
  const short = [...passphrase.normalize('NFKC')].length < FULL_BACKUP_MIN_PASSPHRASE;
  const mismatch = repeat.length > 0 && repeat !== passphrase;
  return (
    <>
      <Note tone="warning" focus>
        {b.warning}
      </Note>
      <Field
        label={b.passphrase}
        accessibilityHint={b.passphraseHint}
        value={passphrase}
        onChangeText={value => {
          setPassphrase(value);
          setSaved('');
          setError('');
        }}
        secureTextEntry
        autoCapitalize="none"
        editable={!busy}
      />
      <Field
        label={b.repeat}
        value={repeat}
        onChangeText={setRepeat}
        secureTextEntry
        autoCapitalize="none"
        editable={!busy}
      />
      {passphrase && short ? <Note>{b.short}</Note> : null}
      {mismatch ? <Note tone="error">{b.mismatch}</Note> : null}
      {error ? <Note tone="error">{error}</Note> : null}
      {saved ? <Note tone="success">{b.saved(saved)}</Note> : null}
      <Action
        label={b.save}
        glyph="share"
        busy={busy}
        disabled={short || repeat !== passphrase}
        onPress={async () => {
          if (busy) return;
          setBusy(true);
          setError('');
          setSaved('');
          try {
            const confirmed = await duringSystemPrompt(() =>
              requireUnlock(b.prompt),
            );
            if (!confirmed) throw new Error(b.unconfirmed);
            const result = await exportFullBackup(passphrase);
            if (result) {
              setSaved(result.file);
              setPassphrase('');
              setRepeat('');
              haptics.success();
            }
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : b.failed);
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

/**
 * The recovery phrase, which is one item wherever it is drawn.
 *
 * While it is still to be saved it leads the page (`lead`): honey, open,
 * and pinned so, outside the one-row-at-a-time of the rest, with its
 * shield on a honey disc whose halo breathes, and its heading the first on
 * the page. Once the hold confirms it, it moves to the top of the Wallet
 * group as the same item: its wash and outline fade to the plain frame and
 * its lower corners square off over the move, the halo shrinks into the
 * disc, the shield turns to a key and the heading to the row's label, each
 * crossfading where it stands, and what it held drops away. A screen
 * reader goes from the heading it landed on as the hold confirmed to the
 * row it became.
 *
 * As a row it opens in place, as the others do. Its frame and its line are
 * the same views in both places, so nothing is drawn anew as it moves.
 */
const RecoveryItem = memo(function RecoveryLine({
  lead,
  edge,
  step,
  open,
  back,
  onToggle,
  loadPhrase,
  onSaved,
}: {
  lead: boolean;
  edge: HubEdge;
  step: number;
  open: boolean;
  back: boolean;
  onToggle: (id: HubRow) => void;
  loadPhrase: () => Promise<string>;
  onSaved?: () => void;
}) {
  const live = usePaneActive();
  const { reduced } = useMotionPrefs();
  const { accent, soft } = useAccent();
  const size = useGlyphSize(ROW_GLYPH);
  const disc = useGlyphSize(DISC);
  const press = useDip();
  const [landing, setLanding] = useState<PhraseLanding>(null);
  // Whether it has led the page while drawn: once saved, it moves to its
  // row over a move rather than a crossfade, and a screen reader goes on
  // to the row it became.
  const [led, setLed] = useState(lead);
  useEffect(() => {
    if (lead) setLed(true);
  }, [lead]);
  // A row closed forgets where focus was to land, so opening it again
  // moves nothing.
  useEffect(() => {
    if (!lead && !open) setLanding(null);
  }, [lead, open]);
  const heading = useFocus(lead && landing === 'heading');
  const row = useFocus(!lead && (back || led));
  // As a row it is brought into view as it opens; leading, it is already
  // at the top of the page.
  const shown = useRevealOnOpen(!lead && open);
  const usable = live && !lead;
  const r = words.recovery;
  return (
    <HubItem
      edge={edge}
      step={step}
      tone={lead ? 'honey' : 'plain'}
      style={lead ? styles.lead : undefined}
      frame={shown.frame}
      onLayout={shown.onLayout}
    >
      <Pressable
        ref={row}
        accessible={!lead}
        accessibilityRole={lead ? 'none' : 'button'}
        accessibilityLabel={r.heading}
        accessibilityState={{ expanded: !lead && open, disabled: lead }}
        disabled={lead}
        onPressIn={usable ? press.down : undefined}
        onPressOut={usable ? press.up : undefined}
        onPress={
          usable
            ? () => {
                haptics.tick();
                onToggle('recovery');
              }
            : undefined
        }
        style={({ pressed }) => [hubStyles.row, pressed && hubStyles.pressed]}
      >
        <View style={{ width: disc, height: disc }}>
          {lead ? (
            <Reanimated.View
              exiting={haloOut(reduced)}
              style={StyleSheet.absoluteFill}
            >
              <HaloRing disc={disc} />
            </Reanimated.View>
          ) : null}
          <GlyphDisc
            fill={lead ? palette.honeySoft : open ? soft : palette.mocha}
            dip={press.dip}
            duration={led ? durations.move : durations.crossfade}
          >
            <Reanimated.View
              key={lead ? 'shield' : 'key'}
              entering={fadeIn()}
              exiting={fadeOut()}
              style={styles.glyphLayer}
            >
              <Glyph
                name={lead ? 'shieldAlert' : 'key'}
                size={size}
                color={lead ? palette.honey : accent}
              />
            </Reanimated.View>
          </GlyphDisc>
        </View>
        <Reanimated.View
          key={lead ? 'lead' : 'row'}
          entering={fadeIn()}
          exiting={fadeOut()}
          style={hubStyles.words}
        >
          {lead ? (
            <LeadTitle title={r.pending} heading={heading} />
          ) : (
            <Text {...wholeWords(r.heading)} style={hubStyles.label}>
              {r.heading}
            </Text>
          )}
        </Reanimated.View>
        {lead ? null : (
          <Reanimated.View entering={fadeIn()}>
            <Chevron open={open} />
          </Reanimated.View>
        )}
      </Pressable>
      {lead || open ? (
        <RowContent>
          <RecoveryPhraseBody
            loadPhrase={loadPhrase}
            onSaved={lead ? onSaved : undefined}
            landing={landing}
            onLanding={setLanding}
          />
        </RowContent>
      ) : null}
    </HubItem>
  );
});

/** A space a line never breaks at. */
const GLUE = '\u00A0';

/**
 * The app's version and, once the wallet reports it, the engine's, at the
 * foot of the page. Each version is one piece a line never breaks inside
 * (`unbroken`): P12 saw "Engine 0.22.0-" over "portable" at the largest text
 * size. The two sit on one line while they fit and wrap as two, each
 * keeping its words whole and shrinking rather than break one (`wholeWords`),
 * the dot between them kept at the end of the first. A screen reader hears
 * them as the one line they read as. It arrives with the last of the page,
 * and moves with it as rows open above it.
 */
function About({ engine, step }: { engine: string | null; step: number }) {
  const app = words.about.app(unbroken(APP_VERSION));
  const said = engine
    ? `${words.about.app(APP_VERSION)} · ${words.about.engine(engine)}`
    : words.about.app(APP_VERSION);
  const parts = engine
    ? [
        // The dot is glued to the version before it, not counted as a word.
        { text: `${app}${GLUE}·`, fit: wholeWords(app) },
        {
          text: words.about.engine(unbroken(engine)),
          fit: wholeWords(words.about.engine(engine)),
        },
      ]
    : [{ text: app, fit: wholeWords(app) }];
  return (
    <Reanimated.View
      entering={stagger(step)}
      layout={smooth()}
      style={styles.aboutFrame}
    >
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={said}
        style={styles.about}
      >
        {parts.map(part => (
          <Text key={part.text} {...part.fit} style={styles.aboutText}>
            {part.text}
          </Text>
        ))}
      </View>
    </Reanimated.View>
  );
}

/**
 * Settings, the one scene that keeps words (REDESIGN.md rule 2), as a
 * grouped hub (REDESIGN.md 6, Settings): the wallet's card on top, then
 * its rows in four groups, Wallet (the recovery phrase, the primary node,
 * the network and its servers), This phone (the app lock, haptics and
 * auto-pay), Funds and exits (emptying the wallet, locking it and erasing
 * it) and Help (diagnostics), and the versions at the foot. Every safety line stays,
 * inside the row it belongs to.
 *
 * A row opens in place, one at a time (`nextOpen`), and what it opens is
 * drawn only while it is open, so Settings arrives light and each row opens
 * fresh. The switches and Lock device wallet act at once and open nothing.
 * What closes itself, Keep my wallet or Keep my channel, closes its row and
 * hands a screen reader back to it.
 *
 * While the recovery phrase still has to be saved, it leads the page in
 * honey, open and pinned. Once the hold confirms it, it slides to the top
 * of the Wallet group, the same item throughout (`RecoveryItem`).
 *
 * A switch that failed comes back to Settings with its reason, which
 * Network & servers holds, so that row opens to show it; a wallet emptying,
 * or one whose emptying has not been confirmed (REDESIGN.md rule 4), opens
 * Empty wallet as the engine says it can empty one, as it was always shown
 * on the page before.
 *
 * The page is one flat list of keyed items (`hubItems`), each a row of its
 * group's card by where it sits, so an item moves as itself and everything
 * below a row that opens moves with it on one linear transition. The rows
 * that hold nothing of the wallet are drawn again only when what they show
 * changes, so the 12s read draws the card and an open row, and little else.
 *
 * On a test network the page draws in slate wherever it would draw bloom.
 */
export function SettingsScreen({
  snapshot,
  client,
  switchError,
  onDisconnect,
  onRefresh,
  onRead,
  onNetwork,
  onErase,
  backupPending = false,
  onBackupSaved,
  unit = 'sats',
  symbol = false,
  connecting = false,
  refreshing = false,
  stale = false,
}: {
  snapshot: WalletSnapshot;
  client: WalletAdapter;
  /** Why the last network switch failed. It outlives the screen that ran it. */
  switchError: string;
  onDisconnect: () => void;
  /**
   * Restarts and resyncs the wallet behind the pull to refresh's spinner,
   * for a change that moved it, such as a new primary node.
   */
  onRefresh: () => void;
  /**
   * Reads the wallet again quietly, with no spinner and no resync, for
   * Empty wallet following its progress. `onRefresh` stands in without one.
   */
  onRead?: () => unknown;
  onNetwork: (profile: NetworkProfile) => Promise<void>;
  /** Erase every device wallet from this phone. Device mode only. */
  onErase?: () => Promise<void>;
  /** The recovery phrase has not been confirmed as saved yet. */
  backupPending?: boolean;
  /** The owner held to confirm the phrase is written down. */
  onBackupSaved?: () => void;
  /** The unit the balance is shown in, which Empty wallet's amounts take. */
  unit?: Unit;
  /** Sats are drawn as `₿2,000` (`unitAffixes`). */
  symbol?: boolean;
  /** The engine is still starting, so the figures are the saved ones. */
  connecting?: boolean;
  /** A refresh is under way. */
  refreshing?: boolean;
  /** The balance is too old to spend against. */
  stale?: boolean;
}) {
  // null while the wallet is being asked; '' when it reports no version.
  const [engineVersion, setEngineVersion] = useState<string | null>(null);
  const [drainAvailable, setDrainAvailable] = useState(false);
  const { outcome, run, busy } = useSettingsOutcome();
  useOutcomeFeedback(outcome);

  // The row open now, one at a time, and the row a screen reader goes back
  // to as what it opened closes itself.
  const [open, setOpen] = useState<HubRow | null>(() =>
    switchError ? 'network' : null,
  );
  const [back, setBack] = useState<HubRow | null>(null);
  const toggle = useCallback((id: HubRow) => {
    setBack(null);
    setOpen(at => nextOpen(at, id));
  }, []);
  const close = useCallback((id: HubRow) => {
    setOpen(at => (at === id ? null : at));
    setBack(id);
  }, []);
  const keepWallet = useCallback(() => close('erase'), [close]);
  const keepChannel = useCallback(() => close('empty'), [close]);
  const loadPhrase = useCallback(() => client.getRecoveryPhrase(), [client]);

  useEffect(() => {
    let active = true;
    // A version label is a courtesy. It must never be able to take Settings
    // down, which is the one screen someone reaches for when things are wrong.
    Promise.resolve()
      .then(() => client.getConfig?.())
      .then(config => {
        if (active) {
          setEngineVersion(config?.engineVersion || '');
          setDrainAvailable(config?.drainAvailable === true);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [client]);

  // A switch that failed brings its reason back to Settings, in Network &
  // servers, which opens to show it.
  useEffect(() => {
    if (switchError) setOpen('network');
  }, [switchError]);

  // A drain under way, or one whose start is unconfirmed, opens Empty
  // wallet once, as soon as the engine says it can empty a wallet, unless
  // another row was opened first.
  const drain = drainState(snapshot.activity);
  const drainShown = useRef(false);
  useEffect(() => {
    if (!drainAvailable || !drain || drainShown.current) return;
    drainShown.current = true;
    setOpen(at => at ?? 'empty');
  }, [drainAvailable, drain]);

  async function savePrimary(
    uri: string,
    done: () => void,
    fallbackUri?: string,
  ) {
    await run(words.primary.saving, async () => {
      if (fallbackUri === undefined) await client.updatePrimary(uri);
      else await client.updatePrimary(uri, fallbackUri);
      done();
      onRefresh();
      // The change has committed. Whether the wallet has reconnected to it is a
      // separate question, answered by a fresh read rather than the snapshot
      // this screen rendered with, which still describes the old node. Saying
      // "saved" when it has not reconnected would invite a second change that
      // is not needed.
      let connected = false;
      try {
        const fresh = await client.snapshot();
        connected =
          fresh.primary.connected && fresh.wallet.lfbw?.setup !== 'failed';
      } catch {
        // The change is committed either way; an unreadable snapshot is a
        // warning, never an unsaved setting.
      }
      return connected
        ? { phase: 'success' as const, message: words.primary.updated }
        : { phase: 'warning' as const, message: words.primary.notReconnected };
    });
  }

  async function retry() {
    await run(words.primary.reconnecting, async () => {
      await client.retrySetup();
      onRefresh();
      return { phase: 'success' as const, message: words.primary.retried };
    });
  }

  const lead = backupPending && !!onBackupSaved;
  const erasable = !!onErase;
  const backupFile = fullBackupAvailable();
  const items = useMemo(
    () => hubItems({ lead, drain: drainAvailable, erase: erasable, fullBackup: backupFile }),
    [lead, drainAvailable, erasable, backupFile],
  );
  const live = answering({ snapshot, connecting, stale });
  const bloom = cardBloom({
    snapshot,
    refreshing,
    connecting,
    stale,
    backupPending,
  });
  const status = cardStatus(snapshot, live);
  const primary = primaryWords(snapshot, live);
  const network = networkWords(snapshot.wallet.network);
  const draining = drainWords(drain);
  // Emptying needs the primary node, so the row waits for it, unless a
  // drain is already shown in it or it is open to be closed.
  const emptyHeld =
    (busy || !snapshot.primary.connected) && !drain && open !== 'empty';

  const drawRow = (item: HubEntry): ReactNode => {
    const at = { edge: item.edge, step: item.step };
    switch (item.row) {
      case 'recovery':
        return (
          <RecoveryItem
            key="recovery"
            lead={item.kind === 'lead'}
            {...at}
            open={open === 'recovery'}
            back={back === 'recovery'}
            onToggle={toggle}
            loadPhrase={loadPhrase}
            onSaved={onBackupSaved}
          />
        );
      case 'primary':
        return (
          <DisclosureRow
            key="primary"
            id="primary"
            {...at}
            glyph="bolt"
            label={words.primary.heading}
            value={primary.words}
            look={primary.look}
            attention={primary.attention}
            said={primary.said}
            pip={primary.attention}
            open={open === 'primary'}
            back={back === 'primary'}
            onToggle={toggle}
          >
            {open === 'primary' ? (
              <PrimaryPanel
                snapshot={snapshot}
                outcome={outcome}
                busy={busy}
                onSave={savePrimary}
                onRetry={retry}
              />
            ) : null}
          </DisclosureRow>
        );
      case 'network':
        return (
          <DisclosureRow
            key="network"
            id="network"
            {...at}
            glyph="chain"
            label={words.wallet.servers}
            accessibilityLabel={words.wallet.serversLabel}
            value={network.words}
            look={network.look}
            said={network.said}
            open={open === 'network'}
            back={back === 'network'}
            onToggle={toggle}
          >
            {open === 'network' ? (
              <NetworkPanel
                snapshot={snapshot}
                busy={busy}
                switchError={switchError}
                onNetwork={onNetwork}
              />
            ) : null}
          </DisclosureRow>
        );
      case 'applock':
        return <AppLockRow key="applock" {...at} />;
      case 'haptics':
        return <HapticsRow key="haptics" {...at} />;
      case 'autopay':
        return (
          <AutoPayRow
            key="autopay"
            {...at}
            availableSats={snapshot.balance.availableSats}
            unit={unit}
            symbol={symbol}
            stale={stale}
          />
        );
      case 'empty':
        return (
          <DisclosureRow
            key="empty"
            id="empty"
            {...at}
            glyph="send"
            tone="honey"
            label={words.empty.link}
            value={draining?.words}
            look={draining?.look}
            attention={draining?.attention}
            said={draining?.said}
            disabled={emptyHeld}
            open={open === 'empty'}
            back={back === 'empty'}
            onToggle={toggle}
          >
            {open === 'empty' ? (
              <EmptyWallet
                key={snapshot.wallet.id}
                client={client}
                snapshot={snapshot}
                disabled={busy || !snapshot.primary.connected}
                onRead={onRead ?? onRefresh}
                unit={unit}
                symbol={symbol}
                onClose={keepChannel}
              />
            ) : null}
          </DisclosureRow>
        );
      case 'leave':
        return <LockRow key="leave" {...at} onDisconnect={onDisconnect} />;
      case 'fullBackup':
        return (
          <DisclosureRow
            key="fullBackup"
            id="fullBackup"
            {...at}
            glyph="shield"
            label={words.fullBackup.link}
            open={open === 'fullBackup'}
            back={back === 'fullBackup'}
            onToggle={toggle}
          >
            {open === 'fullBackup' ? <FullBackupPanel /> : null}
          </DisclosureRow>
        );
      case 'erase':
        return (
          <DisclosureRow
            key="erase"
            id="erase"
            {...at}
            glyph="alert"
            tone="radish"
            danger
            label={words.erase.link}
            open={open === 'erase'}
            back={back === 'erase'}
            onToggle={toggle}
          >
            {open === 'erase' && onErase ? (
              <ErasePanel onErase={onErase} onKeep={keepWallet} />
            ) : null}
          </DisclosureRow>
        );
      case 'diagnostics':
        return (
          <DisclosureRow
            key="diagnostics"
            id="diagnostics"
            {...at}
            glyph="gauge"
            label={words.diagnostics.heading}
            accessibilityHint={words.diagnostics.hint}
            open={open === 'diagnostics'}
            back={back === 'diagnostics'}
            onToggle={toggle}
          >
            {open === 'diagnostics' ? (
              <DiagnosticsPanel client={client} />
            ) : null}
          </DisclosureRow>
        );
      default:
        return null;
    }
  };

  const drawItem = (entry: HubEntry): ReactNode => {
    switch (entry.kind) {
      case 'card':
        return (
          <WalletCard
            key="card"
            name={snapshot.wallet.name}
            network={snapshot.wallet.network}
            {...bloom}
            live={live}
            status={status.words}
            look={status.look}
            said={cardWords({ snapshot, live })}
            step={entry.step}
          />
        );
      case 'header':
        return (
          <GroupHeader
            key={entry.key}
            title={GROUP_TITLES[entry.group!]}
            tone={entry.group === 'funds' ? 'honey' : 'plain'}
            step={entry.step}
          />
        );
      case 'about':
        return <About key="about" engine={engineVersion} step={entry.step} />;
      default:
        return drawRow(entry);
    }
  };

  return (
    <SettingsNetwork network={snapshot.wallet.network}>
      <View>{items.map(drawItem)}</View>
    </SettingsNetwork>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  // Auto-pay's limit: the share and its sats on one line that wraps at
  // large text, the share's figures large and tabular.
  limitReadout: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: space.sm,
  },
  limitShare: { transformOrigin: '0% 50%' },
  limitFigures: {
    ...type.title,
    color: palette.cream,
    fontVariant: ['tabular-nums'],
  },
  limitSats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xxs,
  },
  limitWords: { ...type.body, color: palette.steam },
  limitNote: { ...type.caption, color: palette.steam },
  // The recovery phrase to save sits apart from the card above it; as a
  // row it joins its group.
  lead: { marginTop: space.md },
  glyphLayer: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A row that waits for the phone to say what it offers keeps its place.
  waiting: { minHeight: ROW_HEIGHT },
  aboutFrame: { marginTop: space.lg },
  // One line while both fit, centred; past that each takes a line.
  about: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    columnGap: space.xxs,
  },
  aboutText: {
    ...type.meta,
    color: palette.steam,
    textAlign: 'center',
    flexShrink: 1,
  },
});
