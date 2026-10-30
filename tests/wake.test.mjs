import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWake, join, leave, whoAmI } from '../lib/wake.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmack-'));
const pane = (target) => ({ mux: 'tmux', target });

test('join writes one tab-separated line', () => {
  const dir = tmp();
  join(dir, { name: 'codex', ...pane('/tmp/tmux-1/default,%3,100') });
  assert.equal(fs.readFileSync(path.join(dir, 'wake.txt'), 'utf8'), 'codex\ttmux\t/tmp/tmux-1/default,%3,100\n');
  assert.deepEqual(readWake(dir), [{ name: 'codex', mux: 'tmux', target: '/tmp/tmux-1/default,%3,100' }]);
});

test('readWake is empty without a file', () => {
  assert.deepEqual(readWake(tmp()), []);
});

test('a second join with the same name replaces the line', () => {
  const dir = tmp();
  join(dir, { name: 'codex', ...pane('a') });
  join(dir, { name: 'codex', ...pane('b') });
  assert.deepEqual(readWake(dir), [{ name: 'codex', mux: 'tmux', target: 'b' }]);
});

test('a join on the same pane under a new name evicts the old name', () => {
  const dir = tmp();
  join(dir, { name: 'old', ...pane('a') });
  join(dir, { name: 'new', ...pane('a') });
  assert.deepEqual(readWake(dir), [{ name: 'new', mux: 'tmux', target: 'a' }]);
});

test('leave removes a line and reports whether it existed', () => {
  const dir = tmp();
  join(dir, { name: 'codex', ...pane('a') });
  assert.equal(leave(dir, 'nobody'), false);
  assert.equal(leave(dir, 'codex'), true);
  assert.deepEqual(readWake(dir), []);
});

test('whoAmI finds the name by pane', () => {
  const dir = tmp();
  join(dir, { name: 'codex', ...pane('a') });
  join(dir, { name: 'grok', mux: 'cmux', target: 'S1' });
  assert.equal(whoAmI(dir, { mux: 'cmux', target: 'S1' }), 'grok');
  assert.equal(whoAmI(dir, { mux: 'tmux', target: 'S1' }), null);
});

test('a name with a space or an at-sign is refused', () => {
  const dir = tmp();
  assert.throws(() => join(dir, { name: 'co dex', ...pane('a') }));
  assert.throws(() => join(dir, { name: '@codex', ...pane('a') }));
  assert.throws(() => join(dir, { name: '', ...pane('a') }));
});

test('a name starts and ends with a letter or digit', () => {
  const dir = tmp();
  assert.throws(() => join(dir, { name: 'bot_', ...pane('a') }));
  assert.throws(() => join(dir, { name: '--help', ...pane('a') }));
  assert.throws(() => join(dir, { name: '.hidden', ...pane('a') }));
  join(dir, { name: 'a.b-c_d', ...pane('a') });
  join(dir, { name: 'x', ...pane('b') });
});

test('leave with a pane removes the seat only while it is still on that pane', () => {
  const dir = tmp();
  join(dir, { name: 'lead', mux: 'cmux', target: 'S1' });
  join(dir, { name: 'lead', mux: 'cmux', target: 'S2' });
  assert.equal(leave(dir, 'lead', { mux: 'cmux', target: 'S1' }), false);
  assert.deepEqual(readWake(dir), [{ name: 'lead', mux: 'cmux', target: 'S2' }]);
  assert.equal(leave(dir, 'lead', { mux: 'cmux', target: 'S2' }), true);
  assert.deepEqual(readWake(dir), []);
});

test('join refuses the name all, which means every seat', () => {
  assert.throws(() => join(tmp(), { name: 'all', ...pane('a') }), /"all"/);
});
