import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureTeamDir, recordSeat } from '../lib/team.mjs';
import { join } from '../lib/wake.mjs';
import { claim } from '../lib/claims.mjs';
import { send } from '../lib/send.mjs';
import { age, board } from '../lib/board.mjs';

const dir = () => ensureTeamDir(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmack-')), '.cmack'));
const noSleep = () => {};
const run = () => '';

test('age reads to the minute, then hours or days', () => {
  assert.equal(age(5_000), '<1m');
  assert.equal(age(59_999), '<1m');
  assert.equal(age(12 * 60_000), '12m');
  assert.equal(age(3 * 3_600_000 + 59 * 60_000), '3h');
  assert.equal(age(2 * 86_400_000), '2d');
});

test('the board is one line per seat: up or down, what it holds, the last post and how long ago', () => {
  const d = dir();
  recordSeat(d, { name: 'lead', agent: 'codex', brief: 'run the team' });
  recordSeat(d, { name: 'builder', agent: 'claude', brief: 'build' });
  recordSeat(d, { name: 'reviewer', agent: 'grok', brief: 'review' });
  join(d, { name: 'lead', mux: 'cmux', target: 'S1' });
  join(d, { name: 'builder', mux: 'cmux', target: 'S2' });
  send({ dir: d, from: 'lead', text: '@builder take the auth fix first, one branch off main', now: new Date('2026-10-31T09:50:00Z'), run, sleep: noSleep });
  send({ dir: d, from: 'builder', channel: 'review', text: 'feat/auth is up, @reviewer\nsecond line', now: new Date('2026-10-31T10:12:00Z'), run, sleep: noSleep });
  send({ dir: d, from: 'reviewer', channel: 'review', text: 'on it', now: new Date('2026-10-30T18:00:00Z'), run, sleep: noSleep });
  claim(d, { thing: 'main', holder: 'builder', now: new Date('2026-10-31T10:13:00Z') });
  claim(d, { thing: 'docs', holder: 'builder', now: new Date('2026-10-31T10:14:00Z') });
  claim(d, { thing: 'the release', holder: 'jonny', now: new Date('2026-10-31T10:15:00Z') });
  assert.deepEqual(board(d, { now: new Date('2026-10-31T10:30:00Z'), run }), [
    'seat      agent   state  holds       last post',
    'lead      codex   up     -           40m  #general  @builder take the auth fix first, one branch off main',
    'builder   claude  up     main, docs  18m  #review   feat/auth is up, @reviewer',
    'reviewer  grok    down   -           16h  #review   on it',
    'the release is held by jonny since 2026-10-31T10:15Z',
  ]);
});

test('a seat that never posted says so, and a long first line is cut', () => {
  const d = dir();
  recordSeat(d, { name: 'lead', agent: 'codex' });
  recordSeat(d, { name: 'builder', agent: 'claude' });
  send({ dir: d, from: 'lead', text: 'x'.repeat(80), now: new Date('2026-10-31T10:00:00Z'), run, sleep: noSleep });
  assert.deepEqual(board(d, { now: new Date('2026-10-31T10:00:30Z'), run }), [
    'seat     agent   state  holds  last post',
    `lead     codex   down   -      <1m  #general  ${'x'.repeat(59)}…`,
    'builder  claude  down   -      never posted',
  ]);
});

test('a post that moved to the archive still counts as the seat\'s last post', () => {
  const d = dir();
  recordSeat(d, { name: 'lead', agent: 'codex' });
  recordSeat(d, { name: 'builder', agent: 'claude' });
  send({ dir: d, from: 'builder', channel: 'review', text: 'old review note', now: new Date('2026-10-30T08:00:00Z'), run, sleep: noSleep });
  send({ dir: d, from: 'builder', text: 'night post', now: new Date('2026-10-31T03:00:00Z'), run, sleep: noSleep });
  for (let i = 0; i < 150; i++) send({ dir: d, from: 'lead', text: `post ${i}`, now: new Date('2026-10-31T09:00:00Z'), run, sleep: noSleep });
  const lines = board(d, { now: new Date('2026-10-31T10:00:00Z'), run });
  assert.match(lines[2], /^builder  claude  down   -      7h  #general  night post$/);
});

test('the newest post wins across channels, whichever file is read first', () => {
  const d = dir();
  recordSeat(d, { name: 'lead', agent: 'codex' });
  send({ dir: d, from: 'lead', text: 'first', now: new Date('2026-10-31T09:50:00Z'), run, sleep: noSleep });
  send({ dir: d, from: 'lead', channel: 'review', text: 'second', now: new Date('2026-10-31T10:00:00Z'), run, sleep: noSleep });
  assert.match(board(d, { now: new Date('2026-10-31T10:01:00Z'), run })[1], /1m  #review  second$/);
  const e = dir();
  recordSeat(e, { name: 'lead', agent: 'codex' });
  send({ dir: e, from: 'lead', channel: 'review', text: 'first', now: new Date('2026-10-31T09:50:00Z'), run, sleep: noSleep });
  send({ dir: e, from: 'lead', text: 'second', now: new Date('2026-10-31T10:00:00Z'), run, sleep: noSleep });
  assert.match(board(e, { now: new Date('2026-10-31T10:01:00Z'), run })[1], /1m  #general  second$/);
});

test('a tmux seat is up only while its pane answers with the same process', () => {
  const d = dir();
  recordSeat(d, { name: 'lead', agent: 'codex' });
  join(d, { name: 'lead', mux: 'tmux', target: 'sock,%1,123' });
  assert.match(board(d, { run: () => '123 0 node' })[1], /^lead  codex  up  /);
  assert.match(board(d, { run: () => '999 0 node' })[1], /^lead  codex  down  /);
});

test('columns widen to the widest age and channel', () => {
  const d = dir();
  recordSeat(d, { name: 'lead', agent: 'codex' });
  recordSeat(d, { name: 'builder', agent: 'claude' });
  send({ dir: d, from: 'lead', channel: 'design-review', text: 'long ago', now: new Date('2026-05-01T10:00:00Z'), run, sleep: noSleep });
  send({ dir: d, from: 'builder', text: 'now', now: new Date('2026-10-31T10:00:00Z'), run, sleep: noSleep });
  assert.deepEqual(board(d, { now: new Date('2026-10-31T10:01:00Z'), run }).slice(1), [
    'lead     codex   down   -      183d  #design-review  long ago',
    'builder  claude  down   -      1m    #general        now',
  ]);
});
