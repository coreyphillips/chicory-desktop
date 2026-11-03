import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopScene, desktopShortcut } from './desktop.ts';
import { activityWidth, desktopLayout } from './browserLayout.ts';

test('desktop layouts retain a readable payment workspace at supported window widths', () => {
  assert.equal(desktopLayout(899), false);
  assert.equal(desktopLayout(900), true);
  for (const viewport of [900, 1000, 1199, 1200, 1280, 1440, 1920, 2560]) {
    const workspace = viewport - (viewport >= 1200 ? 208 : 80);
    for (const expanded of [false, true]) {
      const side = activityWidth(workspace, expanded);
      assert.ok(side >= 312, `Activity remains readable at ${viewport}`);
      assert.ok(workspace - side >= 420, `Payment entry remains readable at ${viewport}`);
      assert.ok(side <= (expanded ? 520 : 420), 'Activity does not grow indefinitely');
    }
  }
});

test('desktop shortcuts never consume amount entry, IME, repeats or unrelated modifiers', () => {
  assert.equal(desktopShortcut({ key: '2' }), null);
  assert.equal(desktopShortcut({ key: '2', metaKey: true }), 'send');
  assert.equal(desktopShortcut({ key: '3', ctrlKey: true }), 'receive');
  assert.equal(desktopShortcut({ key: ',', metaKey: true }), 'settings');
  for (const override of [{ repeat: true }, { isComposing: true }, { altKey: true }, { shiftKey: true }])
    assert.equal(desktopShortcut({ key: '2', ctrlKey: true, ...override }), null);
  assert.equal(desktopShortcut({ key: 'Enter', ctrlKey: true }), null);
  assert.equal(desktopShortcut({ key: 'v', metaKey: true }), null);
});

test('native command navigation only recognizes the five wallet scenes', () => {
  assert.equal(desktopScene('send'), 'send');
  assert.equal(desktopScene('payment-link'), null);
  assert.equal(desktopScene('confirm-payment'), null);
  assert.equal(desktopScene('erase-wallet'), null);
});
