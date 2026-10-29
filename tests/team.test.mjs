import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTeamDir, ensureTeamDir, readTeam, recordSeat } from '../lib/team.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmack-'));

test('findTeamDir prefers CMACK_DIR', () => {
  assert.equal(findTeamDir({ cwd: tmp(), env: { CMACK_DIR: '/x' } }), '/x');
});

test('findTeamDir walks up to the nearest .cmack', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.cmack'));
  const cwd = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(cwd, { recursive: true });
  assert.equal(findTeamDir({ cwd, env: {} }), path.join(root, '.cmack'));
});

test('findTeamDir is null when nothing above has a team', () => {
  assert.equal(findTeamDir({ cwd: tmp(), env: {} }), null);
});

test('ensureTeamDir creates the folder and archive', () => {
  const dir = path.join(tmp(), '.cmack');
  assert.equal(ensureTeamDir(dir), dir);
  assert.ok(fs.statSync(path.join(dir, 'archive')).isDirectory());
});

test('readTeam is empty before any seat is recorded', () => {
  assert.deepEqual(readTeam(ensureTeamDir(path.join(tmp(), '.cmack'))), []);
});

test('recordSeat keeps one line per name, in its place, with the brief on one line', () => {
  const dir = ensureTeamDir(path.join(tmp(), '.cmack'));
  recordSeat(dir, { name: 'lead', agent: 'codex', brief: 'first' });
  recordSeat(dir, { name: 'builder', agent: 'claude', brief: 'build\tit\nwell ' });
  assert.deepEqual(recordSeat(dir, { name: 'lead', agent: 'claude', brief: 'second' }), { name: 'lead', agent: 'claude', brief: 'second' });
  assert.deepEqual(readTeam(dir), [
    { name: 'lead', agent: 'claude', brief: 'second' },
    { name: 'builder', agent: 'claude', brief: 'build it well' },
  ]);
  assert.equal(fs.readFileSync(path.join(dir, 'team.txt'), 'utf8'), 'lead\tclaude\tsecond\nbuilder\tclaude\tbuild it well\n');
});

test('a hand-written row with only a name reads with an empty agent and brief', () => {
  const dir = ensureTeamDir(path.join(tmp(), '.cmack'));
  fs.writeFileSync(path.join(dir, 'team.txt'), 'reviewer\n');
  assert.deepEqual(readTeam(dir), [{ name: 'reviewer', agent: '', brief: '' }]);
  recordSeat(dir, { name: 'lead', agent: 'codex', brief: 'x' });
  assert.equal(fs.readFileSync(path.join(dir, 'team.txt'), 'utf8'), 'reviewer\t\t\nlead\tcodex\tx\n');
});

test('recordSeat with no agent or brief keeps what was recorded', () => {
  const dir = ensureTeamDir(path.join(tmp(), '.cmack'));
  recordSeat(dir, { name: 'lead', agent: 'codex', brief: 'run the team' });
  recordSeat(dir, { name: 'lead', agent: '', brief: '' });
  assert.deepEqual(readTeam(dir), [{ name: 'lead', agent: 'codex', brief: 'run the team' }]);
  recordSeat(dir, { name: 'lead', agent: '', brief: 'a new brief' });
  assert.deepEqual(readTeam(dir), [{ name: 'lead', agent: 'codex', brief: 'a new brief' }]);
});
