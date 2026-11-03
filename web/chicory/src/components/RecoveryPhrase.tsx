import React, { useEffect, useLayoutEffect, useState } from 'react';
import { AppState, StyleSheet } from 'react-native';
import Reanimated, { LayoutAnimationConfig } from 'react-native-reanimated';
import { announce } from '../design/announce';
import { copy } from '../design/copy';
import { haptics } from '../design/haptics';
import { dropOut, riseIn } from '../motion/presets';
import { HoldConfirm } from '../scenes/settings/HoldConfirm';
import { RecoveryWords } from '../scenes/settings/RecoveryWords';
import { Action, Body, Note, Section } from '../scenes/settings/ui';
import { requireUnlock } from '../services/lock';
import { duringSystemPrompt } from '../stage/systemPrompt';
import { space } from '../theme';

const words = copy.settings.recovery;

/**
 * Where a screen reader lands once the control it was on goes away: the
 * words land it themselves, hiding them returns it to the reveal, and
 * saving them to the heading of whatever holds the phrase.
 */
export type PhraseLanding = 'reveal' | 'heading' | null;

/**
 * The recovery phrase, shown only when deliberately asked for: the line
 * about what it is, then the reveal, or the words with their safety lines.
 * Whatever holds it draws its heading: a section of its own
 * (`RecoveryPhrase`), or Settings' row.
 *
 * Three protections, in order of how much they actually buy:
 *  - When the app lock is on, revealing requires the device biometric or
 *    passcode. That is the one that matters if the phone is unlocked and in
 *    someone else's hands.
 *  - The words are cleared the moment the app stops being active, so they are
 *    not in the app switcher.
 *  - They are never copied to the clipboard and never written to app state
 *    that outlives the screen.
 *
 * Screenshot blocking is deliberately not claimed: neither platform offers it
 * through React Native core, and a partial version would be worse than none.
 *
 * With `onSaved` it is the backup still to be done (REDESIGN.md 6): once the
 * words are shown, a 900ms hold confirms they are written down. `landing` is
 * where a screen reader lands, which the holder keeps so it can land one on
 * its own heading, and `onLanding` moves it.
 */
export function RecoveryPhraseBody({
  initialPhrase,
  loadPhrase,
  onSaved,
  landing,
  onLanding,
}: {
  initialPhrase?: string;
  loadPhrase?: () => Promise<string>;
  onSaved?: () => void;
  landing: PhraseLanding;
  onLanding: (to: PhraseLanding) => void;
}) {
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // An exit animation keeps a view on screen until it ends, on a frame clock
  // that stops in the background, so words leaving that way could still be
  // there for the app switcher. The words are held with their exit skipped,
  // and go at once however they go. Only Hide and the saved hold let them
  // drop away: they ask for it here, and the words go one render later, once
  // their exit is no longer skipped.
  const [letGo, setLetGo] = useState<'reveal' | 'heading' | null>(null);
  useLayoutEffect(() => {
    if (!letGo) return;
    setPhrase('');
    onLanding(letGo);
    setLetGo(null);
  }, [letGo, onLanding]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        setPhrase('');
        setLetGo(null);
      }
    });
    return () => subscription.remove();
  }, []);
  async function reveal() {
    setBusy(true);
    setError('');
    try {
      // The biometric prompt is one the app raised, so the phrase stays in
      // view behind it rather than going under the privacy cover.
      const allowed = await duringSystemPrompt(() =>
        requireUnlock(words.prompt),
      );
      if (!allowed) {
        haptics.warning();
        setError(words.refused);
        return;
      }
      const value = initialPhrase || (await loadPhrase?.());
      if (!value) {
        throw new Error(words.unavailable);
      }
      setPhrase(value);
      onLanding(null);
    } catch (e) {
      haptics.error();
      setError(e instanceof Error ? e.message : words.unreadable);
    } finally {
      setBusy(false);
    }
  }
  const pending = !!onSaved;
  const shown = phrase ? phrase.trim().split(/\s+/) : [];
  return (
    <>
      <Body>{words.intro}</Body>
      {error ? <Note tone="error">{error}</Note> : null}
      {phrase ? (
        <LayoutAnimationConfig skipExiting={letGo === null}>
          <Reanimated.View
            entering={riseIn()}
            exiting={dropOut(8)}
            style={styles.stack}
          >
            <RecoveryWords words={shown} />
            <Note tone="warning" glyph="bolt">
              {words.channels}
            </Note>
            {onSaved ? (
              <HoldConfirm
                label={words.saved}
                hint={words.savedHint}
                onCommit={() => {
                  setLetGo('heading');
                  haptics.success();
                  announce(words.savedDone);
                  onSaved();
                }}
              />
            ) : null}
            <Action
              label={words.hide}
              glyph="eyeOff"
              tone="quiet"
              onPress={() => setLetGo('reveal')}
            />
          </Reanimated.View>
        </LayoutAnimationConfig>
      ) : (
        <Action
          label={words.reveal}
          glyph="eye"
          tone={pending ? 'primary' : 'quiet'}
          busy={busy}
          focus={landing === 'reveal'}
          accessibilityHint={busy ? words.revealing : undefined}
          onPress={reveal}
        />
      )}
    </>
  );
}

/**
 * The recovery phrase as a section of its own (`RecoveryPhraseBody` under
 * its heading), for the surfaces that are not Settings: the new wallet
 * sheet, a phase's setup panel and the phrase over a shell phase.
 *
 * With `onSaved` it is the backup still to be done (REDESIGN.md 6): the
 * section turns honey, and once the words are shown, a 900ms hold confirms
 * they are written down. `index` places it in a page of sections, and
 * `focus` lands a screen reader on its heading as it arrives.
 */
export function RecoveryPhrase({
  initialPhrase,
  loadPhrase,
  onSaved,
  index,
  focus = false,
}: {
  initialPhrase?: string;
  loadPhrase?: () => Promise<string>;
  onSaved?: () => void;
  index?: number;
  focus?: boolean;
}) {
  const [landing, setLanding] = useState<PhraseLanding>(
    focus ? 'heading' : null,
  );
  const pending = !!onSaved;
  return (
    <Section
      glyph={pending ? 'shieldAlert' : 'key'}
      title={pending ? words.pending : words.heading}
      tone={pending ? 'honey' : 'plain'}
      index={index}
      focus={landing === 'heading'}
    >
      <RecoveryPhraseBody
        initialPhrase={initialPhrase}
        loadPhrase={loadPhrase}
        onSaved={onSaved}
        landing={landing}
        onLanding={setLanding}
      />
    </Section>
  );
}

const styles = StyleSheet.create({ stack: { gap: space.md } });
