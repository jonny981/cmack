import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { defaultRun } from '../lib/mux.mjs';
import { sleepMs } from '../lib/lock.mjs';

const SERVER = ['-L', 'cmack-test'];
const tmux = (...args) => defaultRun('tmux', [...SERVER, ...args]);
const until = (check, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; sleepMs(50); } return false; };

// This test reads its own throwaway pane; the product never reads a pane.
test('a real nudge lands in a real tmux pane', (t) => {
  try { defaultRun('tmux', ['-V']); } catch { t.skip('tmux is not installed'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmack-'));
  // The pane runs cat directly, with no shell: an occupied pane, like one an agent CLI holds.
  tmux('-f', '/dev/null', 'new-session', '-d', '-x', '80', '-y', '24', 'cat');
  try {
    const [socket, pane, pid] = tmux('display-message', '-p', '#{socket_path}\t#{pane_id}\t#{pid}').trim().split('\t');
    assert.ok(until(() => tmux('display-message', '-p', '-t', pane, '#{pane_current_command}').trim() === 'cat'), 'cat did not start in the pane');
    const env = { TMUX: `${socket},${pid},0`, TMUX_PANE: pane, CMACK_DIR: dir };
    const quiet = { write() {} };
    assert.equal(main(['join', 'bob'], { env, run: defaultRun, stdout: quiet, stderr: quiet }), 0);
    assert.equal(fs.readFileSync(path.join(dir, 'wake.txt'), 'utf8'), `bob\ttmux\t${socket},${pane},${tmux('display-message', '-p', '-t', pane, '#{pane_pid}').trim()}\n`);
    const line = '# cmack: alice mentioned you in #general';
    assert.ok(!tmux('capture-pane', '-p', '-t', pane).includes(line), 'the pane already held the nudge');
    let stderr = '';
    assert.equal(main(['send', '--from', 'alice', '@bob hello'], { env, run: defaultRun, stdout: quiet, stderr: { write: (s) => { stderr += s; } } }), 0);
    assert.equal(stderr, '');
    // The typed text echoes once; cat prints it a second time only when enter lands.
    const count = () => tmux('capture-pane', '-p', '-t', pane).split(line).length - 1;
    assert.ok(until(() => count() >= 2), `enter never landed: the nudge appears ${count()} time(s) in the pane`);
  } finally {
    tmux('kill-server');
  }
});

// open and adopt against a real tmux server: the split, the quoting and the typed line are real.
function session() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmack-'));
  tmux('-f', '/dev/null', 'new-session', '-d', '-x', '120', '-y', '40', 'cat');
  const [socket, pane, pid] = tmux('display-message', '-p', '#{socket_path}\t#{pane_id}\t#{pid}').trim().split('\t');
  assert.ok(until(() => tmux('display-message', '-p', '-t', pane, '#{pane_current_command}').trim() === 'cat'), 'cat did not start in the pane');
  const env = { ...process.env, TMUX: `${socket},${pid},0`, TMUX_PANE: pane, CMACK_DIR: dir };
  return { dir, pane, env };
}
const quiet = { write() {} };

test('open splits a real tmux pane and the seat it starts joins and reports', (t) => {
  try { defaultRun('tmux', ['-V']); } catch { t.skip('tmux is not installed'); return; }
  const { dir, env } = session();
  try {
    // cat as the agent: it takes the first prompt as a file name, fails, and the seat frees itself.
    assert.equal(main(['open', 'cat', 'builder', 'read the brief', '--as', 'lead'], { env, cwd: dir, run: defaultRun, stdout: quiet, stderr: quiet }), 0);
    const general = () => { try { return fs.readFileSync(path.join(dir, 'general.md'), 'utf8'); } catch { return ''; } };
    assert.ok(until(() => /builder is down/.test(general()), 5000), `the started seat never reported: ${general()}`);
    assert.match(general(), /Z lead > @all lead joined\n.*Z builder > @all builder joined\n.*Z builder > builder is down\n$/s);
    assert.match(fs.readFileSync(path.join(dir, 'team.txt'), 'utf8'), /^lead\t\t\nbuilder\tcat\tread the brief\n$/);
  } finally {
    tmux('kill-server');
  }
});

test('adopt seats a real neighbouring tmux pane and the line lands in it', (t) => {
  try { defaultRun('tmux', ['-V']); } catch { t.skip('tmux is not installed'); return; }
  const { dir, pane, env } = session();
  try {
    // The helper lives in another window, which only the named form can reach.
    const other = tmux('new-window', '-d', '-P', '-F', '#{pane_id}', 'cat').trim();
    assert.ok(until(() => tmux('display-message', '-p', '-t', other, '#{pane_current_command}').trim() === 'cat'));
    // cat is no agent CLI, so a bare adopt takes nothing and only seats the caller; named, any pane goes.
    assert.equal(main(['adopt', '--as', 'lead'], { env, cwd: dir, run: defaultRun, stdout: quiet, stderr: quiet }), 0);
    assert.match(fs.readFileSync(path.join(dir, 'wake.txt'), 'utf8'), new RegExp(`^lead\ttmux\t.*,${pane},\\d+\n$`));
    let stdout = '';
    assert.equal(main(['adopt', `helper=${other}`, '--as', 'lead'], { env, cwd: dir, run: defaultRun, stdout: { write: (s) => { stdout += s; } }, stderr: quiet }), 0);
    assert.equal(stdout, `adopted helper (${other}, cat)\n`);
    const line = `# cmack: you are helper on the team at ${dir}, run cmack team and cmack read`;
    // -J joins the wrapped line back together; the typed line is wider than the pane.
    const count = () => tmux('capture-pane', '-p', '-J', '-t', other).split(line).length - 1;
    assert.ok(until(() => count() >= 2), `enter never landed: the line appears ${count()} time(s)`);
    assert.match(fs.readFileSync(path.join(dir, 'wake.txt'), 'utf8'), new RegExp(`^lead\ttmux\t.*,${pane},\\d+\nhelper\ttmux\t.*,${other.replace('%', '\\%')},\\d+\n$`));
  } finally {
    tmux('kill-server');
  }
});
