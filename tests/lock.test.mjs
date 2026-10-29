import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock } from '../lib/lock.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmack-'));
const lockOf = (dir) => path.join(dir, '.lock');

test('withLock runs fn and removes the lock', () => {
  const dir = tmp();
  assert.equal(withLock(dir, () => 42), 42);
  assert.equal(fs.existsSync(lockOf(dir)), false);
});

test('withLock removes the lock when fn throws', () => {
  const dir = tmp();
  assert.throws(() => withLock(dir, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(lockOf(dir)), false);
});

test('withLock waits for a held lock', () => {
  const dir = tmp();
  fs.writeFileSync(lockOf(dir), '');
  let retries = 0;
  const sleep = () => { if (++retries === 3) fs.unlinkSync(lockOf(dir)); };
  assert.equal(withLock(dir, () => 'ran', { sleep }), 'ran');
  assert.equal(retries, 3);
});

test('withLock breaks a stale lock', () => {
  const dir = tmp();
  fs.writeFileSync(lockOf(dir), '');
  const old = (Date.now() - 60_000) / 1000;
  fs.utimesSync(lockOf(dir), old, old);
  assert.equal(withLock(dir, () => 'ran', { staleMs: 10_000 }), 'ran');
});

test('withLock gives up after waitMs', () => {
  const dir = tmp();
  fs.writeFileSync(lockOf(dir), '');
  assert.throws(() => withLock(dir, () => 'never', { waitMs: 50 }), new RegExp(lockOf(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
