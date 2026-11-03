import assert from 'node:assert/strict';
import { test } from 'node:test';
import { focusBrowserNode, setBrowserInert } from './browserFocus.ts';

function node(tagName = 'DIV') {
  const attributes = new Map<string, string>();
  const result = {
    tagName, attributes, isConnected: true, inert: false, focused: 0, blurred: 0,
    options: undefined as FocusOptions | undefined,
    hidden: false,
    child: null as unknown,
    contains: (value: unknown) => value !== null && value === result.child,
    closest: (_selector: string) => result.hidden ? {} : null,
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string, value: string) => { attributes.set(name, value); },
    removeAttribute: (name: string) => { attributes.delete(name); },
    focus: (options?: FocusOptions) => { result.focused++; result.options = options; },
    blur: () => { result.blurred++; },
  };
  return result;
}

test('a browser heading becomes programmatically focusable without adding a tab stop or scrolling', () => {
  const target = node();
  assert.equal(focusBrowserNode(target, { activeElement: null }), true);
  assert.equal(target.attributes.get('tabindex'), '-1');
  assert.deepEqual(target.options, { preventScroll: true });
  assert.equal(target.focused, 1);
});

test('buttons, amount fields and existing tab order keep their focus semantics', () => {
  const button = node('BUTTON');
  focusBrowserNode(button, { activeElement: null });
  assert.equal(button.attributes.has('tabindex'), false);
  const amount = node();
  amount.attributes.set('tabindex', '0');
  focusBrowserNode(amount, { activeElement: null });
  assert.equal(amount.attributes.get('tabindex'), '0');
});

test('a delayed heading or amount focus cannot steal the caret from an active request or phrase input', () => {
  const target = node();
  const input = node('INPUT');
  assert.equal(focusBrowserNode(target, { activeElement: input }), false);
  assert.equal(target.focused, 0);
  const phrase = node('TEXTAREA');
  assert.equal(focusBrowserNode(target, { activeElement: phrase }), false);
  assert.equal(target.focused, 0);
});

test('focus can move away from a field hidden by a new scene, and inactive targets are never focused', () => {
  const target = node();
  const input = node('INPUT'); input.hidden = true;
  assert.equal(focusBrowserNode(target, { activeElement: input }), true);
  target.hidden = true;
  assert.equal(focusBrowserNode(target, { activeElement: null }), false);
  target.hidden = false; target.isConnected = false;
  assert.equal(focusBrowserNode(target, { activeElement: null }), false);
  assert.equal(target.focused, 1);
});

test('focus already inside a target stays where the person put it', () => {
  const target = node();
  const input = node('INPUT'); target.child = input;
  assert.equal(focusBrowserNode(target, { activeElement: input }), true);
  assert.equal(target.focused, 0);
});

test('inactive panes use DOM inert and release any focus they hide, then return normally', () => {
  const target = node();
  const button = node('BUTTON'); target.child = button;
  setBrowserInert(target, true, { activeElement: button });
  assert.equal(target.inert, true);
  assert.equal(target.attributes.has('inert'), true);
  assert.equal(button.blurred, 1);
  setBrowserInert(target, false, { activeElement: null });
  assert.equal(target.inert, false);
  assert.equal(target.attributes.has('inert'), false);
});
