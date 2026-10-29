import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffChannels, watch } from '../lib/watch.mjs';
import { appendMessage, channelPath } from '../lib/channel.mjs';

const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmack-')); fs.mkdirSync(path.join(d, 'archive')); return d; };
const at = (minute) => new Date(`2026-10-29T11:${String(minute).padStart(2, '0')}:00Z`);
const post = (dir, channel, from, text, minute = 0) => appendMessage(dir, channel, { at: at(minute), from, text });

test('a new message is printed once', () => {
  const dir = tmp();
  post(dir, 'general', 'a', 'm1', 1);
  const { state } = diffChannels(dir, {});
  post(dir, 'general', 'a', 'm2', 2);
  const first = diffChannels(dir, state);
  assert.deepEqual(first.lines, ['#general 11:02Z a > m2']);
  assert.deepEqual(diffChannels(dir, first.state).lines, []);
});

test('a prune prints the last 10', () => {
  const dir = tmp();
  post(dir, 'general', 'a', 'old', 1);
  const { state } = diffChannels(dir, {});
  fs.writeFileSync(channelPath(dir, 'general'), '');
  for (let i = 0; i < 12; i++) post(dir, 'general', 'a', `n${i}`, i + 2);
  const { lines } = diffChannels(dir, state);
  assert.equal(lines.length, 10);
  assert.equal(lines[0], '#general 11:04Z a > n2');
});

test('a new channel file is picked up', () => {
  const dir = tmp();
  post(dir, 'general', 'a', 'm1', 1);
  const { state } = diffChannels(dir, {});
  post(dir, 'design', 'b', 'draft:\n- one', 3);
  assert.deepEqual(diffChannels(dir, state).lines, ['#design 11:03Z b > draft:\n  - one']);
});

test('own messages are skipped but still advance the state', () => {
  const dir = tmp();
  post(dir, 'general', 'a', 'm1', 1);
  const { state } = diffChannels(dir, {}, { skip: 'me' });
  post(dir, 'general', 'me', 'mine', 2);
  post(dir, 'general', 'a', 'theirs', 3);
  const result = diffChannels(dir, state, { skip: 'me' });
  assert.deepEqual(result.lines, ['#general 11:03Z a > theirs']);
  assert.deepEqual(diffChannels(dir, result.state, { skip: 'me' }).lines, []);
});

test('watch primes silently and prints what arrives during the wait', () => {
  const dir = tmp();
  post(dir, 'general', 'a', 'before', 1);
  let written = '';
  const out = { write: (s) => { written += s; } };
  watch({ dir, out, once: true, sleep: () => post(dir, 'general', 'a', 'during', 2) });
  assert.equal(written, '#general 11:02Z a > during\n');
});
