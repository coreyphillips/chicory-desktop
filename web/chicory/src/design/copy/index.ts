import { activity } from './activity';
import { detail } from './detail';
import { health, home } from './home';
import { phase } from './phases';
import { receive } from './receive';
import { scan } from './scan';
import { keypad, send } from './send';
import { settings } from './settings';
import { amount, notice, scene } from './shared';

/**
 * Every word the app says without showing it (REDESIGN.md 9).
 *
 * Outside Settings the screen carries meaning in glyphs, rings, colour and
 * motion, so the words move here: into accessibility labels, values and hints,
 * into announcements, and into the Whisper pill a long press summons. Keeping
 * them in one object keeps a phrase identical wherever it is spoken, and lets
 * a test prove that nothing here leaked onto the screen.
 *
 * Each area keeps its words in a file of its own, so the surfaces can change
 * their words without touching one another's. Phrases the test suite already
 * asserts are kept verbatim.
 */
export const copy = {
  home,
  scene,
  health,
  activity,
  detail,
  amount: {
    ...amount,
    // The keypad's words, which send.ts keeps with the keypad.
    backspace: keypad.backspace,
    backspaceHint: keypad.backspaceHint,
  },
  send,
  keypad,
  receive,
  scan,
  phase,
  settings,
  notice,
};
