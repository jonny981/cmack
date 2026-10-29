import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTeamDir, ensureTeamDir, initTeamDir } from '../lib/team.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmack-'));

test('findTeamDir prefers CMACK_DIR', () => {
  assert.equal(findTeamDir({ cwd: tmp(), env: { CMACK_DIR: '/x' }, home: '/h' }), '/x');
});

test('findTeamDir walks up to the nearest .cmack', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.cmack'));
  const cwd = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(cwd, { recursive: true });
  assert.equal(findTeamDir({ cwd, env: {}, home: '/h' }), path.join(root, '.cmack'));
});

test('findTeamDir falls back to ~/.cmack', () => {
  const home = tmp();
  assert.equal(findTeamDir({ cwd: tmp(), env: {}, home }), path.join(home, '.cmack'));
});

test('ensureTeamDir creates the folder and archive', () => {
  const dir = path.join(tmp(), '.cmack');
  assert.equal(ensureTeamDir(dir), dir);
  assert.ok(fs.statSync(path.join(dir, 'archive')).isDirectory());
});

test('initTeamDir creates .cmack in cwd', () => {
  const cwd = tmp();
  const dir = initTeamDir(cwd);
  assert.equal(dir, path.join(cwd, '.cmack'));
  assert.ok(fs.statSync(dir).isDirectory());
});
