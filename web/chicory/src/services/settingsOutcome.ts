import { useCallback, useRef, useState } from 'react';

/**
 * Saving a setting and reconnecting with it are two different outcomes.
 *
 * Ported from the browser app's `settings-update` contract: once a change has
 * committed, a failed reconnect must never be reported as an unsaved setting.
 * The user needs to know their primary node *was* changed even when the wallet
 * cannot reach it yet, or they will change it again.
 */
export type OutcomePhase = 'idle' | 'pending' | 'success' | 'warning' | 'error';

export interface SettingsOutcome {
  phase: OutcomePhase;
  message: string;
}

const IDLE: SettingsOutcome = { phase: 'idle', message: '' };

export function useSettingsOutcome() {
  const [outcome, setOutcome] = useState<SettingsOutcome>(IDLE);
  // Only the newest attempt may report. A slow first save must not overwrite
  // the result of the save that replaced it.
  const epoch = useRef(0);

  const run = useCallback(
    async (
      pending: string,
      action: () => Promise<SettingsOutcome | void>,
    ): Promise<void> => {
      const current = ++epoch.current;
      setOutcome({ phase: 'pending', message: pending });
      try {
        const result = await action();
        if (epoch.current !== current) return;
        setOutcome(result || { phase: 'success', message: 'Saved.' });
      } catch (error) {
        if (epoch.current !== current) return;
        setOutcome({
          phase: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'That change could not be saved.',
        });
      }
    },
    [],
  );

  const reset = useCallback(() => {
    epoch.current += 1;
    setOutcome(IDLE);
  }, []);

  return { outcome, run, reset, busy: outcome.phase === 'pending' };
}
