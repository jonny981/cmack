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
