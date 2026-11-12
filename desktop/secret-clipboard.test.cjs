'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CLEAR_AFTER_MS, MAX_SECRET_LENGTH, secretClipboard } = require('./secret-clipboard.cjs');

function system() {
  const timers = [];
  const board = {
    text: 'something else', cleared: 0,
    readText() { return this.text; },
    writeText(text) { this.text = text; },
    clear() { this.text = ''; this.cleared += 1; },
  };
  const options = {
    schedule: (run, after) => { const timer = { run, after, cancelled: false }; timers.push(timer); return timer; },
    cancel: (timer) => { timer.cancelled = true; },
  };
  return { board, timers, secrets: secretClipboard(board, options), fire: () => timers.filter(t => !t.cancelled).forEach(t => t.run()) };
}

test('a secret is on the clipboard for a minute, then gone', () => {
  const { board, timers, secrets, fire } = system();
  assert.equal(secrets.copy('twelve words'), true);
  assert.equal(board.text, 'twelve words');
  assert.equal(timers[0].after, CLEAR_AFTER_MS);
  assert.equal(CLEAR_AFTER_MS, 60_000);
  fire();
  assert.equal(board.text, '');
  assert.equal(board.cleared, 1);
});
test('whatever the owner copied since is left alone', () => {
  const { board, secrets, fire } = system();
  secrets.copy('twelve words');
  board.text = 'an address the owner copied';
  fire();
  assert.equal(board.text, 'an address the owner copied');
  assert.equal(board.cleared, 0);
});
test('clearing early, as on quit or a locked screen, ends the wait', () => {
  const { board, timers, secrets } = system();
  secrets.copy('twelve words');
  secrets.clear();
  assert.equal(board.text, '');
  assert.equal(timers[0].cancelled, true);
  // Nothing is held now, so a later clear leaves a new copy alone.
  board.text = 'something new';
  secrets.clear();
  assert.equal(board.text, 'something new');
});
test('copying again starts the minute again', () => {
  const { board, timers, secrets, fire } = system();
  secrets.copy('twelve words');
  secrets.copy('twelve words');
  assert.equal(timers[0].cancelled, true);
  assert.equal(timers.length, 2);
  fire();
  assert.equal(board.cleared, 1);
});
test('nothing is copied that is not a short string', () => {
  const { board, timers, secrets } = system();
  for (const value of ['', undefined, null, 12, {}, 'x'.repeat(MAX_SECRET_LENGTH + 1)]) assert.equal(secrets.copy(value), false);
  assert.equal(board.text, 'something else');
  assert.equal(timers.length, 0);
});
test('with nothing held, clearing touches nothing', () => {
  const { board, secrets } = system();
  secrets.clear();
  assert.equal(board.text, 'something else');
});
