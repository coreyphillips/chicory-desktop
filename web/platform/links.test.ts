import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type { StageState } from '../chicory/src/stage/scene.ts';

// Only Linking is used here, and React Native itself does not load in Node.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react-native') return { shortCircuit: true,
      url: 'data:text/javascript,export const Linking = { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) };' };
    return next(specifier, context);
  },
});
const { normalizePaymentLink } = await import('../chicory/src/services/links.ts');
const { initialStage, stageReducer } = await import('../chicory/src/stage/scene.ts');
const { commandAccepted } = await import('./desktop.ts');

const INVOICE = 'lnbcrt50u1pexample';

test('only bitcoin: and lightning: links reach Send, with the lightning prefix the parser does not read removed', () => {
  assert.equal(normalizePaymentLink(`lightning:${INVOICE}`), INVOICE);
  assert.equal(normalizePaymentLink(`LIGHTNING:${INVOICE}`), INVOICE);
  assert.equal(normalizePaymentLink('  bitcoin:bcrt1qexample?amount=0.001  '), 'bitcoin:bcrt1qexample?amount=0.001');
  for (const value of ['javascript:alert(1)', 'https://example.com', 'file:///etc/passwd', '', null, undefined])
    assert.equal(normalizePaymentLink(value), '', String(value));
});

test('menus, shortcuts and links act only on a ready wallet that is not being switched, paying or covered', () => {
  const ready = { ready: true, choosing: false, busy: false, overlay: null };
  assert.equal(commandAccepted(ready), true);
  assert.equal(commandAccepted({ ...ready, ready: false }), false, 'no wallet open: dropped, not queued');
  assert.equal(commandAccepted({ ...ready, choosing: true }), false, 'a wallet switch in progress');
  assert.equal(commandAccepted({ ...ready, busy: true }), false, 'a payment under way');
  assert.equal(commandAccepted({ ...ready, overlay: { name: 'scan' } }), false, 'a scan or sheet open');
});

test('a link only fills Send: it never gets camera provenance, so auto-pay cannot act on it', () => {
  const linked = stageReducer(initialStage(), { type: 'link', request: INVOICE });
  assert.equal(linked.scene.name, 'send');
  assert.equal((linked.scene as { prefill?: string }).prefill, INVOICE);
  assert.equal((linked.scene as { scanned?: boolean }).scanned, undefined, 'only the camera marks a request as scanned');
  // The same request read by the camera from home is the only scanned path.
  const scanning = stageReducer(initialStage(), { type: 'overlay', overlay: { name: 'scan', target: 'home' } } as never);
  const scanned = stageReducer(scanning, { type: 'scanned', value: INVOICE, source: 'camera' });
  assert.equal((scanned.scene as { scanned?: boolean }).scanned, true);
  for (const source of ['photo', 'clipboard'] as const) {
    const manual = stageReducer(scanning, { type: 'scanned', value: INVOICE, source });
    assert.equal(manual.scene.name, 'send');
    assert.equal((manual.scene as { prefill?: string }).prefill, INVOICE);
    assert.equal((manual.scene as { scanned?: boolean }).scanned, undefined);
  }
  // A scanned code delivered without the scan overlay open changes nothing.
  const idle = initialStage();
  assert.equal(stageReducer(idle, { type: 'scanned', value: INVOICE, source: 'camera' }), idle);
});

test('a link that lands mid-payment is dropped, and a repeated link refills Send without paying', () => {
  const paying: StageState = stageReducer(stageReducer(initialStage(), { type: 'link', request: INVOICE }), { type: 'busy', busy: true });
  const during = stageReducer(paying, { type: 'link', request: 'lnbcrt1otherinvoice' });
  assert.equal(during, paying, 'the payment on screen is never replaced');
  const open = stageReducer(initialStage(), { type: 'link', request: INVOICE });
  const again = stageReducer(open, { type: 'link', request: INVOICE });
  assert.equal(again.scene.name, 'send');
  assert.equal((again.scene as { prefill?: string }).prefill, INVOICE);
  assert.equal((again.scene as { scanned?: boolean }).scanned, undefined);
  assert.notEqual(again.scene.key, open.scene.key, 'a fresh Send, so no review from the first carries over');
});
