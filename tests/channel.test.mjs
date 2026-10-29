import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KEEP, channelPath, archivePath, formatMessage, parseChannel, serialize,
  appendMessage, readChannel, listChannels,
} from '../lib/channel.mjs';

const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmack-')); fs.mkdirSync(path.join(d, 'archive')); return d; };
const at = (iso) => new Date(iso);
const messages = (content) => parseChannel(content).filter((b) => b.kind === 'message');

test('formatMessage writes one line for a one-line text', () => {
  assert.deepEqual(formatMessage({ at: at('2026-10-29T11:42:10Z'), from: 'claude', text: 'hello' }), ['11:42Z claude > hello']);
});

test('formatMessage indents continuation lines', () => {
  assert.deepEqual(
    formatMessage({ at: at('2026-10-29T11:42:10Z'), from: 'claude', text: 'two:\n- a\n- b\n\n' }),
    ['11:42Z claude > two:', '  - a', '  - b'],
  );
});

test('formatMessage refuses empty text', () => {
  assert.throws(() => formatMessage({ at: at('2026-10-29T11:42:10Z'), from: 'a', text: '' }));
  assert.throws(() => formatMessage({ at: at('2026-10-29T11:42:10Z'), from: 'a', text: '  \n' }));
});

const fixture = [
  '## 2026-10-28',
  '09:00Z alice > first',
  '## 2026-10-29',
  '11:42Z claude > two:',
  '  - a',
  '  - b',
  '11:44Z codex > ok',
  '',
].join('\n');

test('parseChannel round-trips through serialize', () => {
  const blocks = parseChannel(fixture);
  assert.equal(serialize(blocks), fixture);
  const m = blocks.filter((b) => b.kind === 'message');
  assert.equal(m.length, 3);
  assert.equal(m[0].date, '2026-10-28');
  assert.deepEqual([m[1].date, m[1].time, m[1].from, m[1].text], ['2026-10-29', '11:42', 'claude', 'two:\n- a\n- b']);
  assert.equal(m[1].raw, '11:42Z claude > two:\n  - a\n  - b');
});

test('parseChannel tolerates CRLF and trailing blank lines', () => {
  const m = messages('## 2026-10-29\r\n11:42Z a > x\r\n\r\n\r\n');
  assert.equal(m.length, 1);
  assert.equal(m[0].text, 'x');
});

test('appendMessage adds a date header when the day changes', () => {
  const dir = tmp();
  appendMessage(dir, 'general', { at: at('2026-10-29T23:59:00Z'), from: 'a', text: 'x' });
  appendMessage(dir, 'general', { at: at('2026-10-30T00:00:00Z'), from: 'a', text: 'y' });
  assert.equal(fs.readFileSync(channelPath(dir, 'general'), 'utf8'), '## 2026-10-29\n23:59Z a > x\n## 2026-10-30\n00:00Z a > y\n');
});

test('appendMessage keeps 150 messages and archives the rest', () => {
  const dir = tmp();
  for (let i = 0; i < 100; i++) appendMessage(dir, 'general', { at: at(`2026-10-28T10:${String(i % 60).padStart(2, '0')}:00Z`), from: 'a', text: `m${i}` });
  for (let i = 100; i < 151; i++) appendMessage(dir, 'general', { at: at(`2026-10-29T10:${String(i % 60).padStart(2, '0')}:00Z`), from: 'a', text: `m${i}` });
  const channel = parseChannel(fs.readFileSync(channelPath(dir, 'general'), 'utf8'));
  assert.equal(channel.filter((b) => b.kind === 'message').length, KEEP);
  assert.deepEqual(channel[0], { kind: 'date', date: '2026-10-28' });
  assert.equal(channel[1].text, 'm1');
  const archived = parseChannel(fs.readFileSync(archivePath(dir, 'general'), 'utf8'));
  assert.deepEqual(archived.map((b) => b.kind), ['date', 'message']);
  assert.equal(archived[1].text, 'm0');
  appendMessage(dir, 'general', { at: at('2026-10-29T11:00:00Z'), from: 'a', text: 'm151' });
  assert.equal(messages(fs.readFileSync(channelPath(dir, 'general'), 'utf8')).length, KEEP);
  assert.equal(messages(fs.readFileSync(archivePath(dir, 'general'), 'utf8')).length, 2);
});

test('appendMessage never splits a multi-line message at the prune boundary', () => {
  const dir = tmp();
  for (let i = 0; i < KEEP; i++) appendMessage(dir, 'general', { at: at('2026-10-29T10:00:00Z'), from: 'a', text: `m${i}` });
  appendMessage(dir, 'general', { at: at('2026-10-29T10:01:00Z'), from: 'a', text: 'three:\n- x\n- y' });
  const content = fs.readFileSync(channelPath(dir, 'general'), 'utf8');
  const m = messages(content);
  assert.equal(m.length, KEEP);
  assert.equal(m.at(-1).text, 'three:\n- x\n- y');
  assert.ok(content.split('\n').length > KEEP + 1);
  assert.equal(messages(fs.readFileSync(archivePath(dir, 'general'), 'utf8'))[0].text, 'm0');
});

test('readChannel returns the last n messages with headers', () => {
  const dir = tmp();
  appendMessage(dir, 'general', { at: at('2026-10-28T09:00:00Z'), from: 'a', text: 'one' });
  appendMessage(dir, 'general', { at: at('2026-10-29T11:42:00Z'), from: 'a', text: 'two' });
  appendMessage(dir, 'general', { at: at('2026-10-29T11:43:00Z'), from: 'a', text: 'three' });
  assert.equal(readChannel(dir, 'general', { count: 2 }), '## 2026-10-29\n11:42Z a > two\n11:43Z a > three\n');
  assert.equal(readChannel(dir, 'missing'), '');
});

test('listChannels lists channel files, not the archive folder', () => {
  const dir = tmp();
  appendMessage(dir, 'general', { at: at('2026-10-29T11:42:00Z'), from: 'a', text: 'x' });
  appendMessage(dir, 'design', { at: at('2026-10-29T11:50:00Z'), from: 'a', text: 'y' });
  fs.writeFileSync(channelPath(dir, 'empty'), '');
  for (let i = 0; i < KEEP + 1; i++) appendMessage(dir, 'general', { at: at('2026-10-29T12:00:00Z'), from: 'a', text: 'z' });
  assert.deepEqual(listChannels(dir), [
    { name: 'design', lastAt: '2026-10-29 11:50Z' },
    { name: 'empty', lastAt: null },
    { name: 'general', lastAt: '2026-10-29 12:00Z' },
  ]);
});
