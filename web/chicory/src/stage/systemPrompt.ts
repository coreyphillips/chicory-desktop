/**
 * Prompts the system draws over the app at the app's own asking: the paste
 * permission, the camera permission, Face ID. iOS makes the app inactive
 * while one is up, which is also how the app switcher begins, and the
 * privacy cover goes up for that. Behind a prompt the app asked for, the
 * screen stays: the person needs to see what they are pasting into, or what
 * the camera is for.
 *
 * `duringSystemPrompt` wraps the call that raises such a prompt. The span
 * outlasts the call by a moment, because the app turns active again a little
 * after the answer comes back. Going to the background always covers,
 * prompt or not.
 */
export const PROMPT_SETTLE_MS = 600;

let open = 0;

export async function duringSystemPrompt<T>(
  raise: () => Promise<T>,
): Promise<T> {
  open += 1;
  try {
    return await raise();
  } finally {
    setTimeout(() => {
      open -= 1;
    }, PROMPT_SETTLE_MS);
  }
}

/** Whether a prompt the app asked for may be up now. */
export function systemPromptOpen(): boolean {
  return open > 0;
}
