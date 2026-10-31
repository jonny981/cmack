import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureTeamDir } from '../lib/team.mjs';
import { readClaims, claim, release, releaseAll } from '../lib/claims.mjs';

const dir = () => ensureTeamDir(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmack-')), '.cmack'));
const at = new Date('2026-10-31T13:40:12Z');

test('a claim is recorded with its holder and when, one line per thing', () => {
  const d = dir();
  assert.deepEqual(claim(d, { thing: 'main', holder: 'lead', now: at }), { ok: true, holder: 'lead', since: '2026-10-31T13:40Z' });
  assert.deepEqual(readClaims(d), [{ thing: 'main', holder: 'lead', since: '2026-10-31T13:40Z' }]);
  assert.equal(fs.readFileSync(path.join(d, 'claims.txt'), 'utf8'), 'main\tlead\t2026-10-31T13:40Z\n');
});

test('a claim on a held thing is refused with the holder, and the holder may claim again', () => {
  const d = dir();
  claim(d, { thing: 'main', holder: 'lead', now: at });
  assert.deepEqual(claim(d, { thing: 'main', holder: 'builder' }), { ok: false, holder: 'lead', since: '2026-10-31T13:40Z' });
  assert.deepEqual(claim(d, { thing: 'main', holder: 'lead' }), { ok: true, holder: 'lead', since: '2026-10-31T13:40Z' });
  assert.equal(readClaims(d).length, 1);
});

test('release gives back who held it, and nothing when it was free', () => {
  const d = dir();
  claim(d, { thing: 'main', holder: 'lead', now: at });
  claim(d, { thing: 'feat/auth', holder: 'builder', now: at });
  assert.equal(release(d, 'main'), 'lead');
  assert.equal(release(d, 'main'), null);
  assert.deepEqual(readClaims(d), [{ thing: 'feat/auth', holder: 'builder', since: '2026-10-31T13:40Z' }]);
});

test('releaseAll drops every claim a seat holds and names them', () => {
  const d = dir();
  claim(d, { thing: 'main', holder: 'lead', now: at });
  claim(d, { thing: 'docs', holder: 'lead', now: at });
  claim(d, { thing: 'feat/auth', holder: 'builder', now: at });
  assert.deepEqual(releaseAll(d, 'lead'), ['main', 'docs']);
  assert.deepEqual(releaseAll(d, 'lead'), []);
  assert.deepEqual(readClaims(d).map((c) => c.thing), ['feat/auth']);
});

test('a thing is one line: whitespace collapses, and an empty thing is refused', () => {
  const d = dir();
  assert.equal(claim(d, { thing: '  the  auth\tfix ', holder: 'lead', now: at }).ok, true);
  assert.deepEqual(readClaims(d).map((c) => c.thing), ['the auth fix']);
  assert.throws(() => claim(d, { thing: '  ', holder: 'lead' }), /claim needs a thing/);
});
