import { editableTarget } from './keyboard.ts';

type FocusNode = {
  tagName?: string;
  isConnected?: boolean;
  inert?: boolean;
  focus?: (options?: FocusOptions) => void;
  blur?: () => void;
  contains?: (node: unknown) => boolean;
  closest?: (selector: string) => unknown;
  hasAttribute?: (name: string) => boolean;
  setAttribute?: (name: string, value: string) => void;
  removeAttribute?: (name: string) => void;
};
type FocusDocument = { activeElement: unknown };
type ModalitySource = {
  addEventListener: (type: string, listener: () => void, capture?: boolean) => void;
};
const hidden = (node: FocusNode) => !!node.closest?.('[inert], [aria-hidden="true"]');

/**
 * Whether the person is moving through the app with the keyboard: a key press
 * says they are and a pointer press says they are not. Before either, as the
 * window opens, they are not.
 */
let keyboardInUse = false;

/** Follows key and pointer presses on `source`, the window unless a test passes its own. */
export function watchInputModality(
  source: ModalitySource | undefined = typeof window === 'undefined' ? undefined : window,
) {
  source?.addEventListener('keydown', () => { keyboardInUse = true; }, true);
  source?.addEventListener('pointerdown', () => { keyboardInUse = false; }, true);
}
watchInputModality();

/** Move browser focus after a scene transition without interrupting typing. */
export function focusBrowserNode(value: unknown, owner: FocusDocument = document): boolean {
  const node = value as FocusNode | null | undefined;
  if (!node?.focus || node.isConnected === false || hidden(node)) return false;
  const active = owner.activeElement as FocusNode | null;
  if (active === node || node.contains?.(active)) return true;
  // Inputs that have already taken focus own it. Balance polls and delayed
  // heading entrances must not take a person's caret out of an active field.
  if (active && active.isConnected !== false && editableTarget(active) && !hidden(active)) return false;
  const interactive = /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/i.test(node.tagName ?? '');
  if (!interactive && node.hasAttribute && !node.hasAttribute('tabindex'))
    node.setAttribute?.('tabindex', '-1');
  // A move the app makes for a screen reader draws no focus ring unless the
  // person is on the keyboard. Chromium draws one for focus moved before any
  // click or key press, so the first landing, the balance as the app opens,
  // wore a ring until the next click.
  const options: FocusOptions & { focusVisible?: boolean } = keyboardInUse
    ? { preventScroll: true }
    : { preventScroll: true, focusVisible: false };
  node.focus(options);
  return true;
}

/** Inactive browser panes cannot remain in the tab order beneath a scene. */
export function setBrowserInert(value: unknown, inactive: boolean, owner: FocusDocument = document) {
  const node = value as FocusNode | null | undefined;
  if (!node) return;
  node.inert = inactive;
  if (inactive) node.setAttribute?.('inert', '');
  else node.removeAttribute?.('inert');
  if (inactive && node.contains?.(owner.activeElement))
    (owner.activeElement as FocusNode | null)?.blur?.();
}
