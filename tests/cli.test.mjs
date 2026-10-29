import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../lib/cli.mjs';
import { readChannel } from '../lib/channel.mjs';
import { readWake } from '../lib/wake.mjs';

const BIN = fileURLToPath(new URL('../bin/cmack.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmack-'));
const noSleep = () => {};

// One call of main with captured output; the pane is a cmux surface named by `surface`.
function cli(argv, { dir, surface = 'S1', run = () => '', cwd = dir } = {}) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, {
    env: { CMACK_DIR: dir, CMUX_SURFACE_ID: surface },
    cwd,
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    run,
    sleep: noSleep,
  });
  return { code, stdout, stderr };
}

test('init creates .cmack in cwd', () => {
  const cwd = tmp();
  let stdout = '';
  const code = main(['init'], { cwd, env: {}, stdout: { write: (s) => { stdout += s; } }, stderr: { write() {} } });
  assert.equal(code, 0);
  assert.equal(stdout, `${path.join(cwd, '.cmack')}\n`);
  assert.ok(fs.statSync(path.join(cwd, '.cmack', 'archive')).isDirectory());
});

test('join registers the pane and posts to general', () => {
  const dir = tmp();
  const { code, stdout } = cli(['join', 'codex'], { dir });
  assert.equal(code, 0);
  assert.equal(stdout, `joined ${dir} as codex (cmux S1)\n`);
  assert.deepEqual(readWake(dir), [{ name: 'codex', mux: 'cmux', target: 'S1' }]);
  assert.match(readChannel(dir, 'general'), /Z codex > codex joined\n$/);
});

test('join outside a pane fails with the hint', () => {
  const dir = tmp();
  let stderr = '';
  const code = main(['join', 'codex'], { env: { CMACK_DIR: dir }, cwd: dir, stdout: { write() {} }, stderr: { write: (s) => { stderr += s; } } });
  assert.equal(code, 2);
  assert.match(stderr, /not inside tmux or cmux; pass --mux and --target/);
});

test('send without --from uses the joined name', () => {
  const dir = tmp();
  cli(['join', 'codex'], { dir });
  const { code } = cli(['send', 'hello', 'there'], { dir });
  assert.equal(code, 0);
  assert.match(readChannel(dir, 'general'), /Z codex > hello there\n$/);
});

test('send outside a joined pane fails with exit 2 and the hint', () => {
  const dir = tmp();
  const { code, stderr } = cli(['send', 'hello'], { dir, surface: 'S9' });
  assert.equal(code, 2);
  assert.match(stderr, /not joined here; run cmack join <name> or pass --from <name>/);
  assert.equal(readChannel(dir, 'general'), '');
});

test('send reports an undelivered nudge on stderr and exits 0', () => {
  const dir = tmp();
  cli(['join', 'codex'], { dir, surface: 'S1' });
  cli(['join', 'grok'], { dir, surface: 'S2' });
  const run = () => { throw new Error('surface not found\nmore'); };
  const { code, stderr } = cli(['send', '-c', 'design', '@grok', 'hi'], { dir, surface: 'S1', run });
  assert.equal(code, 0);
  assert.equal(stderr, 'cmack: nudge to grok not delivered (surface not found); message posted\n');
  assert.match(readChannel(dir, 'design'), /Z codex > @grok hi\n$/);
});

test('read, channels and who print what the files hold', () => {
  const dir = tmp();
  cli(['join', 'codex'], { dir, surface: 'S1' });
  cli(['join', 'grok'], { dir, surface: 'S2' });
  cli(['send', '-c', 'design', 'a draft'], { dir });
  assert.match(cli(['read', 'design', '-n', '1'], { dir }).stdout, /^## \d{4}-\d{2}-\d{2}\n\d{2}:\d{2}Z codex > a draft\n$/);
  assert.match(cli(['channels'], { dir }).stdout, /^design\t\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z\ngeneral\t\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z\n$/);
  assert.equal(cli(['who'], { dir }).stdout, 'codex\tcmux\tS1\ngrok\tcmux\tS2\n');
});

test('help and an unknown command', () => {
  const dir = tmp();
  assert.equal(cli(['--help'], { dir }).code, 0);
  const unknown = cli(['frobnicate'], { dir });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /^usage: cmack/);
});

test('two concurrent sends both land', async () => {
  const dir = tmp();
  const env = { ...process.env, CMACK_DIR: dir };
  const one = (from, text) => new Promise((resolve) => spawn(process.execPath, [BIN, 'send', '--from', from, text], { env }).on('close', resolve));
  const codes = await Promise.all([one('a', 'one'), one('b', 'two')]);
  assert.deepEqual(codes, [0, 0]);
  const content = readChannel(dir, 'general');
  assert.match(content, /Z a > one\n/);
  assert.match(content, /Z b > two\n/);
});

// A sandbox can block the multiplexer socket (Codex does). Only commands that need the
// caller's identity may touch it; a read, a listing, and a send with --from must not.
const BLOCKED = () => { throw new Error('error connecting to /tmp/tmux-501/default (Operation not permitted)'); };
const tmuxEnv = (dir) => ({ CMACK_DIR: dir, TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%1' });
function cliTmux(argv, dir) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, { env: tmuxEnv(dir), cwd: dir, stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, run: BLOCKED, sleep: noSleep });
  return { code, stdout, stderr };
}

test('read and channels work when the multiplexer cannot be reached', () => {
  const dir = tmp();
  cli(['send', '--from', 'a', 'hello'], { dir });
  const read = cliTmux(['read'], dir);
  assert.equal(read.code, 0);
  assert.match(read.stdout, /Z a > hello\n$/);
  assert.equal(cliTmux(['channels'], dir).code, 0);
});

test('send with --from posts when the multiplexer cannot be reached', () => {
  const dir = tmp();
  const { code } = cliTmux(['send', '--from', 'a', 'hello'], dir);
  assert.equal(code, 0);
  assert.match(readChannel(dir, 'general'), /Z a > hello\n$/);
});

test('send without --from says not joined when the multiplexer cannot be reached', () => {
  const dir = tmp();
  const { code, stderr } = cliTmux(['send', 'hello'], dir);
  assert.equal(code, 2);
  assert.match(stderr, /not joined here/);
});

test('--help after a command prints usage and changes nothing', () => {
  const dir = tmp();
  cli(['join', 'codex'], { dir });
  const join = cli(['join', '--help'], { dir });
  assert.equal(join.code, 0);
  assert.match(join.stdout, /^usage: cmack/);
  assert.deepEqual(readWake(dir), [{ name: 'codex', mux: 'cmux', target: 'S1' }]);
  const send = cli(['send', '-h'], { dir });
  assert.equal(send.code, 0);
  assert.doesNotMatch(readChannel(dir, 'general'), /-h/);
});

test('three concurrent joins all land', async () => {
  const dir = tmp();
  const env = { ...process.env, CMACK_DIR: dir };
  const one = (name, n) => new Promise((resolve) => spawn(process.execPath, [BIN, 'join', name, '--mux', 'cmux', '--target', `S${n}`], { env }).on('close', resolve));
  const codes = await Promise.all([one('a', 1), one('b', 2), one('c', 3)]);
  assert.deepEqual(codes, [0, 0, 0]);
  assert.deepEqual(readWake(dir).map((e) => e.name).sort(), ['a', 'b', 'c']);
});
