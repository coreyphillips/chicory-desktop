import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chicoryAccessibility } from './accessibility.vite.ts';
import { stateAsAria } from './accessibilityProps.ts';

test('a state reaches the browser and the native prop does not', () => {
  assert.deepEqual(stateAsAria({ id: 'a', accessibilityState: { disabled: true, busy: true, expanded: false } }, 'button'),
    { id: 'a', 'aria-disabled': true, 'aria-busy': true, 'aria-expanded': false });
  assert.deepEqual(stateAsAria({ accessibilityState: undefined }, 'button'), {});
  assert.deepEqual(stateAsAria({ accessibilityState: null }), {});
});
test('a state that is off says nothing, except one that has two sides', () => {
  assert.deepEqual(stateAsAria({ accessibilityState: { disabled: false, busy: false } }, 'button'), {});
  assert.deepEqual(stateAsAria({ accessibilityState: { expanded: false } }, 'button'), { 'aria-expanded': false });
  assert.deepEqual(stateAsAria({ accessibilityState: { checked: false } }, 'switch'), { 'aria-checked': false });
});
test('a button says it is pressed, since it cannot be selected or checked', () => {
  assert.deepEqual(stateAsAria({ accessibilityState: { selected: true } }, 'button'), { 'aria-pressed': true });
  assert.deepEqual(stateAsAria({ accessibilityState: { selected: false } }, 'button'), { 'aria-pressed': false });
  assert.deepEqual(stateAsAria({ accessibilityState: { checked: 'mixed' } }, 'button'), { 'aria-pressed': 'mixed' });
  assert.deepEqual(stateAsAria({ accessibilityState: { selected: true } }, 'tab'), { 'aria-selected': true });
  assert.deepEqual(stateAsAria({ accessibilityState: { checked: true } }, 'radio'), { 'aria-checked': true });
});
test('what a control set for itself stands', () => {
  assert.deepEqual(stateAsAria({ 'aria-pressed': false, accessibilityState: { selected: true } }, 'button'), { 'aria-pressed': false });
  assert.deepEqual(stateAsAria({ 'aria-disabled': true, accessibilityState: { disabled: false } }, 'button'), { 'aria-disabled': true });
});
test('an element with no role is left with none', () => {
  for (const role of ['none', 'presentation'])
    assert.deepEqual(stateAsAria({ accessibilityState: { disabled: true, expanded: false } }, role), {});
});
test('a state never turns into native disabled, which would take a control out of the tab order', () => {
  const dom = stateAsAria({ tabIndex: '0', accessibilityState: { disabled: true } }, 'button');
  assert.equal(dom.disabled, undefined);
  assert.equal(dom.tabIndex, '0');
});
test('props without a state are passed through untouched', () => {
  const dom = { id: 'a', role: 'button' };
  assert.equal(stateAsAria(dom, 'button'), dom);
});

const file = (name: string) => `node_modules/react-native-web/dist/modules/${name}/index.js`;
const transform = chicoryAccessibility().transform as unknown as (code: string, id: string) => string | null;

test('the rewrite fits the installed react-native-web', () => {
  const forwarded = transform(readFileSync(file('forwardedProps'), 'utf8'), `/app/${file('forwardedProps')}`);
  assert.match(forwarded ?? '', /accessibilityProps = \{\n {2}accessibilityState: true,/);
  const dom = transform(readFileSync(file('createDOMProps'), 'utf8'), `/app/${file('createDOMProps')}?v=1`);
  assert.match(dom ?? '', /return stateAsAria\(domProps, role\);/);
  assert.match(dom ?? '', /^import \{ stateAsAria \} from /);
  assert.equal(transform('export default 1;', '/app/node_modules/other/index.js'), null);
});
test('a react-native-web that no longer fits stops the build', () => {
  assert.throws(() => transform('export default 1;', `/app/${file('forwardedProps')}`), /react-native-web version/);
  assert.throws(() => transform('export default 1;', `/app/${file('createDOMProps')}`), /react-native-web version/);
});
