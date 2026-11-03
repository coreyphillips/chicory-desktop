import React, { useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { AmountField } from '../../components/AmountField';
import { copy } from '../../design/copy';
import { palette } from '../../design/palette';
import { riseIn, sceneOut } from '../../motion/presets';
import { useLaunchLanding } from '../../stage/panes/Launch';
import { usePaneActive } from '../../stage/panes/Pane';
import { radius, space, type as typography } from '../../theme';
import { AmountCue, AmountFace } from './AmountCue';
import {
  CONTROL,
  CONTROL_ROW,
  ErrorPip,
  GlyphButton,
  TARGET,
} from './controls';
import type { Focus } from './focus';
import { useReceiveHost } from './host';
import type { AmountCue as Cue, Refused } from './model';
import { PRESETS } from './model';
import { OfflineSwitch } from './OfflineSwitch';
import { useBloom } from './tone';

/** The longest note a request carries. */
const NOTE_MAX = 180;

/**
 * The least a pinned step is given, so a slot squeezed flat still leaves the
 * amount room to scroll above the way on; past that the slot scrolls.
 */
const PINNED_MIN = CONTROL * 3;

/**
 * The amount to ask for (REDESIGN.md 6, Receive): the amount with its cue
 * over it and the preset chips, the pencil that opens a note, the moon that
 * makes the request payable offline when that is offered, and the control
 * that asks for a quote. No words: the cue, the switch and the controls
 * carry them for a screen reader.
 *
 * The pencil and the moon flank the cue, and the note opens under them,
 * where a keyboard leaves it in view. The row is a grid of three: the
 * pencil at the left edge and the moon's switch at the right, in slots of
 * one width either side of the cue, the pencil a bare glyph as the cue is
 * (P10, 18-receive-amount-large, where a filled disc at one edge weighed
 * against a bare sprout and nothing). The way on sits at the bottom with a
 * refusal beside it, as Send's does. In the scene (`room`) the step fits its
 * slot on any phone: the way on is pinned above the bottom inset and what
 * is entered scrolls above it when the phone is too short for it all.
 *
 * The amount shows an infinity while it is empty and the sender may choose,
 * and a dust 0 with a caret while one is needed. It turns radish past an
 * offline receive's cap and dust under its floor, and shakes when an amount
 * turns out to be needed after all, as the infinity gives way to the 0. An
 * amount the engine refuses, past what the primary node funds for one
 * receive say, turns radish and shakes as it is refused, and the way on is
 * dimmed until another amount is entered.
 */
export function FormStep({
  amount,
  onAmount,
  cue,
  cap,
  amountMessage,
  note,
  onNote,
  noteOpen,
  onNoteOpen,
  offlineOffered,
  offline,
  offlineRefused,
  onOffline,
  busy,
  stale,
  ready,
  error,
  shake,
  onContinue,
  onBlocked,
  onDismissRetry,
  focus,
  symbol = false,
}: {
  amount: string;
  onAmount: (next: string) => void;
  cue: Cue;
  cap?: number;
  /** What the engine said when it asked for an amount. */
  amountMessage: string;
  note: string;
  onNote: (next: string) => void;
  noteOpen: boolean;
  onNoteOpen: (open: boolean) => void;
  offlineOffered: boolean;
  offline: boolean;
  /** Counts the engine's refusals of an offline receive: each shakes the moon. */
  offlineRefused: number;
  onOffline: (next: boolean) => void;
  busy: boolean;
  stale: boolean;
  /** The amount is one that can be quoted. */
  ready: boolean;
  error: Refused | null;
  shake: number;
  onContinue: () => void;
  onBlocked: () => void;
  onDismissRetry?: () => void;
  focus: Focus;
  /** The amount's unit is drawn as `₿` before its digits. */
  symbol?: boolean;
}) {
  const live = usePaneActive();
  const { bloom } = useBloom();
  const { room } = useReceiveHost();
  const landing = useLaunchLanding();
  const showNote = noteOpen || note !== '';
  // A refused amount is radish until another is entered, and the way on
  // waits for that, dimmed (P10, 19-receive-refusal-pip).
  const refusedAmount = !!error?.amount;
  // Each time an amount turns out to be needed, the amount shakes once.
  const needed = cue.kind === 'required';
  const [asked, setAsked] = useState({ needed, times: 0 });
  if (asked.needed !== needed) {
    setAsked({ needed, times: asked.times + (needed ? 1 : 0) });
  }
  const tools = (
    <View style={styles.tools}>
      <View style={styles.side}>
        <GlyphButton
          glyph="pencil"
          label={copy.receive.addNote}
          size={TARGET}
          tone="bare"
          expanded={showNote}
          disabled={busy}
          onPress={() => onNoteOpen(!noteOpen)}
        />
      </View>
      <AmountCue cue={cue} cap={cap} message={amountMessage || undefined} />
      <View style={[styles.side, styles.end]}>
        {offlineOffered ? (
          <OfflineSwitch
            on={offline}
            cap={cap}
            disabled={busy}
            shake={offlineRefused}
            onToggle={onOffline}
          />
        ) : null}
      </View>
    </View>
  );
  const entry = (
    <>
      {tools}
      {showNote ? (
        <Reanimated.View entering={riseIn(8)} exiting={sceneOut()}>
          <TextInput
            accessibilityLabel={copy.receive.note}
            accessibilityHint={copy.receive.noteHint}
            value={note}
            onChangeText={live ? onNote : undefined}
            editable={!busy}
            maxLength={NOTE_MAX}
            maxFontSizeMultiplier={1.4}
            autoFocus={noteOpen && note === ''}
            autoCorrect={false}
            returnKeyType="done"
            selectionColor={bloom}
            style={styles.note}
          />
        </Reanimated.View>
      ) : null}
      <AmountField
        value={amount}
        onChangeText={onAmount}
        presets={PRESETS}
        busy={busy}
        hint={
          refusedAmount
            ? error?.message
            : cue.kind === 'any' && cue.empty
            ? copy.amount.any
            : undefined
        }
        empty={<AmountFace cue={cue} />}
        tone={
          cue.over || refusedAmount ? 'radish' : cue.under ? 'dust' : undefined
        }
        shake={asked.times}
        symbol={symbol}
      />
    </>
  );
  // The way on, with what went wrong beside it as Send has it, so a refusal
  // is never pushed past the bottom of the screen. The row holds still as
  // it arrives, as Send's does: Home's circle is landing on Continue, which
  // is measured where it is laid out, so a rise of its own had the circle
  // land low and snap up as it handed over (P12, 03i). A refusal's pip
  // rises in on its own. The row moves as the step is fitted to its slot,
  // which Continue's own layout does not see, so it is measured again then.
  const controls = (
    <View style={styles.controls} onLayout={landing.onLayout}>
      <View style={styles.side}>
        {onDismissRetry && (
          <GlyphButton
            glyph="close"
            label={copy.receive.dismissRetry}
            hint={copy.receive.dismissRetryHint}
            busy={busy}
            onPress={onDismissRetry}
          />
        )}
      </View>
      {/* Home's Receive circle lands exactly on it (REDESIGN.md 7, T2), and
          it is unseen until the circle hands over, so the two are never
          drawn apart. */}
      <View ref={landing.ref} onLayout={landing.onLayout} collapsable={false}>
        <Reanimated.View style={landing.style}>
          <GlyphButton
            glyph="receive"
            label={copy.receive.continue}
            hint={stale ? copy.receive.stale : undefined}
            size={CONTROL}
            tone="primary"
            disabled={!stale && (!ready || refusedAmount)}
            blocked={stale}
            busy={busy}
            shake={shake}
            onPress={onContinue}
            onBlocked={onBlocked}
            focusRef={focus}
          />
        </Reanimated.View>
      </View>
      <View style={styles.side}>
        {error ? <ErrorPip message={error.message} code={error.code} /> : null}
      </View>
    </View>
  );
  if (room === undefined) {
    return (
      <View style={styles.form}>
        {entry}
        {controls}
      </View>
    );
  }
  // In the scene, the step fits its slot: what is entered scrolls on a
  // short phone, and the way on stays pinned above the bottom inset.
  return (
    <View style={[styles.pinned, { height: Math.max(room, PINNED_MIN) }]}>
      <ScrollView
        testID="receive-entry"
        style={styles.entry}
        contentContainerStyle={styles.form}
        alwaysBounceVertical={false}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {entry}
      </ScrollView>
      {controls}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { flexGrow: 1, gap: space.lg },
  pinned: { gap: space.lg },
  entry: { flex: 1 },
  tools: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  // Either side of the cue, the same width, so the cue is centred whether
  // or not the moon is offered.
  side: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  end: { justifyContent: 'flex-end' },
  note: {
    ...typography.row,
    minHeight: 48,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: palette.mocha,
    color: palette.cream,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: CONTROL_ROW,
  },
});
