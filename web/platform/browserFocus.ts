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
const hidden = (node: FocusNode) => !!node.closest?.('[inert], [aria-hidden="true"]');

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
  node.focus({ preventScroll: true });
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
