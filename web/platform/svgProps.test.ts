import test from 'node:test';
import assert from 'node:assert/strict';
import { svgWebProps } from './svgProps.ts';

test('a decorative or concealed native SVG is hidden from the browser accessibility tree', () => {
  const original = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', accessible: false, viewBox: '0 0 24 24', children: 'shape' };
  const translated = svgWebProps(original);
  assert.equal(translated['aria-hidden'], true);
  assert.equal(translated.viewBox, original.viewBox);
  assert.equal(translated.children, original.children);
  assert.equal('importantForAccessibility' in translated, false);
  assert.equal('accessibilityElementsHidden' in translated, false);
  assert.equal(original.accessibilityElementsHidden, true);
});
test('an accessible SVG preserves explicit browser labels and translates native roles', () => {
  assert.deepEqual(svgWebProps({ accessibilityLabel: 'Receiving', accessibilityRole: 'image' }), { 'aria-label': 'Receiving', role: 'img' });
  assert.equal(svgWebProps({ accessibilityLabel: 'native', 'aria-label': 'browser' })['aria-label'], 'browser');
});
