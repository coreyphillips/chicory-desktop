type State = {
  disabled?: boolean | null;
  busy?: boolean | null;
  expanded?: boolean | null;
  selected?: boolean | null;
  checked?: boolean | 'mixed' | null;
};

/**
 * Translate React Native's accessibilityState, which react-native-web drops,
 * to what a browser announces.
 *
 * It runs on the finished DOM props, so it only ever adds an announcement. An
 * `aria-disabled` going in would also set `disabled` on a real button, which
 * takes it out of the tab order and ends a hold under way.
 */
export function stateAsAria(dom: Record<string, unknown>, role?: string): Record<string, unknown> {
  if (!('accessibilityState' in dom)) return dom;
  const { accessibilityState, ...clean } = dom;
  const state = accessibilityState as State | null | undefined;
  // A state on an element with no role would make the browser expose it.
  if (!state || role === 'none' || role === 'presentation') return clean;
  const add = (name: string, value: unknown) => {
    if (value !== undefined && value !== null && clean[name] === undefined) clean[name] = value;
  };
  if (state.disabled) add('aria-disabled', true);
  if (state.busy) add('aria-busy', true);
  add('aria-expanded', state.expanded);
  // A button cannot be selected or checked, only pressed.
  add(role === 'button' ? 'aria-pressed' : 'aria-selected', state.selected);
  add(role === 'button' ? 'aria-pressed' : 'aria-checked', state.checked);
  return clean;
}
