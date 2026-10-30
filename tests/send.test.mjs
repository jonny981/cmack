import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mentions, send } from '../lib/send.mjs';
import { readChannel } from '../lib/channel.mjs';
import { join } from '../lib/wake.mjs';
import { recordSeat } from '../lib/team.mjs';

const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmack-')); fs.mkdirSync(path.join(d, 'archive')); return d; };
const noSleep = () => {};
function fakeRun(fail) {
  const run = (cmd, args) => { run.calls.push([cmd, args]); if (fail) throw new Error(`${fail}\nmore`); return ''; };
  run.calls = [];
  return run;
}
const at = new Date('2026-10-29T11:42:00Z');

test('mentions finds @name and a leading name:', () => {
  assert.deepEqual(mentions('codex: @grok look at this', ['codex', 'grok', 'devin']), ['codex', 'grok']);
});

test('mentions ignores an at-sign inside a word', () => {
  assert.deepEqual(mentions('mail alice@codex now', ['codex']), []);
});

test('mentions ignores an unknown name', () => {
  assert.deepEqual(mentions('use @media', ['codex']), []);
});

test('mentions survives trailing punctuation', () => {
  assert.deepEqual(mentions('@codex. thanks, @grok-', ['codex', 'grok']), ['codex', 'grok']);
});

test('send posts before it nudges', () => {
  const dir = tmp();
  join(dir, { name: 'codex', mux: 'cmux', target: 'S1' });
  const run = fakeRun('surface not found');
  const result = send({ dir, from: 'claude', text: '@codex review please', now: at, run, sleep: noSleep });
  assert.equal(readChannel(dir, 'general'), '## 2026-10-29\n11:42Z claude > @codex review please\n');
  assert.deepEqual(result.nudged, [{ name: 'codex', ok: false, reason: 'surface not found' }]);
});

test('send never nudges the sender', () => {
  const dir = tmp();
  join(dir, { name: 'claude', mux: 'cmux', target: 'S1' });
  const run = fakeRun();
  assert.deepEqual(send({ dir, from: 'claude', text: '@claude note to self', now: at, run, sleep: noSleep }).nudged, []);
  assert.deepEqual(run.calls, []);
});

test('send nudges with the fixed line in the named channel', () => {
  const dir = tmp();
  join(dir, { name: 'codex', mux: 'cmux', target: 'S1' });
  const run = fakeRun();
  const result = send({ dir, from: 'claude', channel: 'design', text: '@codex thoughts?', now: at, run, sleep: noSleep });
  assert.deepEqual(result.nudged, [{ name: 'codex', ok: true }]);
  assert.deepEqual(run.calls[0], ['cmux', ['send', '--surface', 'S1', '# cmack: claude mentioned you in #design']]);
});

test('send refuses a bad channel name', () => {
  const dir = tmp();
  assert.throws(() => send({ dir, from: 'claude', channel: 'Bad Name', text: 'x', now: at, run: fakeRun(), sleep: noSleep }), /channel/);
  assert.equal(fs.existsSync(path.join(dir, 'Bad Name.md')), false);
});

test('send refuses a sender name with a space and writes nothing', () => {
  const dir = tmp();
  assert.throws(() => send({ dir, from: 'Jonny N', text: 'hello', now: at, run: fakeRun(), sleep: noSleep }), /name/);
  assert.equal(readChannel(dir, 'general'), '');
});

test('a newline in the sender name never reaches the multiplexer', () => {
  const dir = tmp();
  join(dir, { name: 'codex', mux: 'cmux', target: 'S1' });
  const run = fakeRun();
  assert.throws(() => send({ dir, from: 'x\nrm -rf ~ #', text: '@codex hi', now: at, run, sleep: noSleep }));
  assert.deepEqual(run.calls, []);
  assert.equal(readChannel(dir, 'general'), '');
});

test('a mention of a recorded seat that is down is reported as down', () => {
  const dir = tmp();
  recordSeat(dir, { name: 'lead', agent: 'codex', brief: 'run it' });
  join(dir, { name: 'grok', mux: 'cmux', target: 'S2' });
  const run = fakeRun();
  const { nudged } = send({ dir, from: 'grok', text: '@lead done', now: at, run, sleep: noSleep });
  assert.deepEqual(nudged, [{ name: 'lead', ok: false, reason: 'down' }]);
  assert.equal(run.calls.length, 0);
});

test('mentions: @all names everyone', () => {
  assert.deepEqual(mentions('@all stand-up in five', ['codex', 'grok']), ['codex', 'grok']);
});

test('mentions: @all expands to the names given as everyone, in their order, after the names already found', () => {
  assert.deepEqual(mentions('@grok then @all', ['codex', 'grok', 'devin'], ['devin', 'codex']), ['grok', 'devin', 'codex']);
});

test('send with @all nudges every seat that is up, never the sender, and reports no down seat', () => {
  const dir = tmp();
  join(dir, { name: 'claude', mux: 'cmux', target: 'S1' });
  join(dir, { name: 'codex', mux: 'cmux', target: 'S2' });
  join(dir, { name: 'grok', mux: 'cmux', target: 'S3' });
  recordSeat(dir, { name: 'devin' });
  const run = fakeRun();
  const result = send({ dir, from: 'claude', text: '@all builder joined', now: at, run, sleep: noSleep });
  assert.deepEqual(result.nudged, [{ name: 'codex', ok: true }, { name: 'grok', ok: true }]);
  assert.deepEqual(run.calls.map((c) => c[1][2]), ['S2', 'S2', 'S3', 'S3']);
});
