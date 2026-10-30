import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nudgeLine, adoptLine, detect, adapters, defaultRun } from '../lib/mux.mjs';

const SOCK = '/tmp/tmux-501/default';
const TMUX_ENV = { TMUX: `${SOCK},123,0`, TMUX_PANE: '%3' };
const noSleep = () => {};

// A fake runner: records every call, answers from a script keyed by the joined args.
function fakeRun(script = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, args]);
    const answer = script[args.join(' ')];
    if (answer instanceof Error) throw answer;
    return answer ?? '';
  };
  run.calls = calls;
  return run;
}

test('nudgeLine is the fixed comment line', () => {
  assert.equal(nudgeLine('claude', 'general'), '# cmack: claude mentioned you in #general');
});

test('detect prefers tmux when both are set, since tmux is always the innermost', () => {
  const run = fakeRun({ [`-S ${SOCK} display-message -p -t %3 #{pane_pid}`]: '456\n' });
  assert.deepEqual(detect({ ...TMUX_ENV, CMUX_SURFACE_ID: 'S1' }, run), { mux: 'tmux', target: `${SOCK},%3,456` });
});

test('detect builds a tmux target with socket, pane and pid', () => {
  const run = fakeRun({ [`-S ${SOCK} display-message -p -t %3 #{pane_pid}`]: '456\n' });
  assert.deepEqual(detect(TMUX_ENV, run), { mux: 'tmux', target: `${SOCK},%3,456` });
  assert.deepEqual(run.calls, [['tmux', ['-S', SOCK, 'display-message', '-p', '-t', '%3', '#{pane_pid}']]]);
});

test('detect returns null outside a multiplexer', () => {
  assert.equal(detect({}, fakeRun()), null);
});

const target = `${SOCK},%3,456`;
const aliveQuery = `-S ${SOCK} display-message -p -t %3 #{pane_pid} #{pane_in_mode} #{pane_current_command}`;

test('tmux nudge types the line then enter', () => {
  const run = fakeRun({ [aliveQuery]: '456 0 node\n' });
  assert.deepEqual(adapters.tmux.nudge(target, '# hi', run, noSleep), { ok: true });
  assert.deepEqual(run.calls.slice(1), [
    ['tmux', ['-S', SOCK, 'send-keys', '-t', '%3', '-l', '# hi']],
    ['tmux', ['-S', SOCK, 'send-keys', '-t', '%3', 'Enter']],
  ]);
});

test('tmux nudge reports pane gone when the pid changed', () => {
  const run = fakeRun({ [aliveQuery]: '999 0 node\n' });
  assert.deepEqual(adapters.tmux.nudge(target, '# hi', run, noSleep), { ok: false, reason: 'pane gone' });
  assert.equal(run.calls.length, 1);
});

test('tmux nudge reports pane gone when tmux throws', () => {
  const run = fakeRun({ [aliveQuery]: new Error("can't find pane: %3") });
  assert.deepEqual(adapters.tmux.nudge(target, '# hi', run, noSleep), { ok: false, reason: 'pane gone' });
});

test('tmux nudge reports nobody home for a shell', () => {
  const run = fakeRun({ [aliveQuery]: '456 0 zsh\n' });
  assert.deepEqual(adapters.tmux.nudge(target, '# hi', run, noSleep), { ok: false, reason: 'nobody home' });
  assert.equal(run.calls.length, 1);
});

test('cmux nudge sends then presses enter', () => {
  const run = fakeRun();
  assert.deepEqual(adapters.cmux.nudge('S1', '# hi', run, noSleep), { ok: true });
  assert.deepEqual(run.calls, [
    ['cmux', ['send', '--surface', 'S1', '# hi']],
    ['cmux', ['send-key', '--surface', 'S1', 'enter']],
  ]);
});

test('cmux nudge reports a failure and does not throw', () => {
  const run = fakeRun({ 'send --surface S1 # hi': new Error('surface not found\nmore detail') });
  assert.deepEqual(adapters.cmux.nudge('S1', '# hi', run, noSleep), { ok: false, reason: 'surface not found' });
});

test('cmux alive cannot tell and says ok without running anything', () => {
  const run = fakeRun();
  assert.deepEqual(adapters.cmux.alive('S1', run), { ok: true });
  assert.deepEqual(run.calls, []);
});

// An execFileSync error carries the multiplexer's own words in stderr, not in message.
const execError = (stderr) => Object.assign(new Error(`Command failed: tmux ${stderr}`), { stderr: `${stderr}\n` });

test('tmux nudge reports pane scrolled back and types nothing', () => {
  const run = fakeRun({ [aliveQuery]: '456 1 node\n' });
  assert.deepEqual(adapters.tmux.nudge(target, '# hi', run, noSleep), { ok: false, reason: 'pane scrolled back' });
  assert.equal(run.calls.length, 1);
});

test('tmux alive reads the reason from stderr', () => {
  assert.deepEqual(adapters.tmux.alive(target, fakeRun({ [aliveQuery]: execError("can't find pane: %3") })), { ok: false, reason: 'pane gone' });
  assert.deepEqual(adapters.tmux.alive(target, fakeRun({ [aliveQuery]: execError('error connecting to /tmp/tmux-501/default (Operation not permitted)') })), { ok: false, reason: 'error connecting to /tmp/tmux-501/default (Operation not permitted)' });
  assert.deepEqual(adapters.tmux.alive(target, fakeRun({ [aliveQuery]: execError('no server running on /tmp/tmux-501/default') })), { ok: false, reason: 'no server running on /tmp/tmux-501/default' });
});

test('cmux nudge reports the reason from stderr', () => {
  const run = fakeRun({ 'send --surface S1 # hi': Object.assign(new Error('Command failed: cmux send --surface S1 # hi'), { stderr: 'Error: not_found: Workspace not found\n' }) });
  assert.deepEqual(adapters.cmux.nudge('S1', '# hi', run, noSleep), { ok: false, reason: 'Error: not_found: Workspace not found' });
});

test('defaultRun gives up on a command that hangs', () => {
  const started = Date.now();
  assert.throws(() => defaultRun('sleep', ['5'], { timeout: 200 }));
  assert.ok(Date.now() - started < 2000);
});

test('adoptLine names the seat and the team folder, and nothing else', () => {
  assert.equal(adoptLine('builder', '/w/.cmack'), '# cmack: you are builder on the team at /w/.cmack, run cmack team and cmack read');
});
