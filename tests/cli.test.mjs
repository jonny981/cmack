import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../lib/cli.mjs';
import { readChannel } from '../lib/channel.mjs';
import { readWake, join } from '../lib/wake.mjs';
import { readTeam } from '../lib/team.mjs';

const BIN = fileURLToPath(new URL('../bin/cmack.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmack-'));
const noSleep = () => {};

// One call of main with captured output; the pane is a cmux surface named by `surface`.
function cli(argv, { dir, surface = 'S1', run = () => '', cwd = dir, env = {} } = {}) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, {
    env: { CMACK_DIR: dir, CMUX_SURFACE_ID: surface, ...env },
    cwd,
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    run,
    sleep: noSleep,
  });
  return { code, stdout, stderr };
}

// A stand-in agent: records its arguments, its team folder and the wake table, then exits 3.
function fakeAgent(dir) {
  const file = path.join(dir, 'fake-agent');
  fs.writeFileSync(file, '#!/bin/sh\n{ printf \'%s\\n\' "$@"; printf \'CMACK_DIR=%s\\n\' "$CMACK_DIR"; /bin/cat "$CMACK_DIR/wake.txt"; } > "$CMACK_TEST_OUT"\nexit 3\n', { mode: 0o755 });
  return file;
}
const recorded = (dir) => fs.readFileSync(path.join(dir, 'out'), 'utf8').split('\n');
function fakeAgentThat(dir, body) {
  const file = path.join(dir, 'fake-agent');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test('cmack <agent> <name> <brief> seats the pane, starts the agent with its brief, and frees the seat when it exits', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  const { code, stdout } = cli([agent, 'lead', 'coordinate', 'the team'], { dir, env: { CMACK_TEST_OUT: path.join(dir, 'out') } });
  assert.equal(code, 3);
  const lines = recorded(dir);
  assert.equal(lines[0], '--');
  assert.match(lines[1], /^You are "lead" on a Cmack team, in this pane\. Read the cmack skill before you post, or run: cmack --help\. Brief: coordinate the team$/);
  assert.equal(lines[2], `CMACK_DIR=${dir}`);
  assert.equal(lines[3], 'lead\tcmux\tS1');
  assert.deepEqual(readWake(dir), []);
  assert.match(readChannel(dir, 'general'), /Z lead > @all lead joined\n\d\d:\d\dZ lead > lead is down\n$/);
  assert.deepEqual(readTeam(dir), [{ name: 'lead', agent, brief: 'coordinate the team' }]);
  assert.equal(stdout, 'lead is down; cmack resume lead starts it again\n');
});

test('a hangup reaches the agent, not the seat: a closed pane still frees the seat', () => {
  const dir = tmp();
  const agent = fakeAgentThat(dir, 'kill -HUP $PPID; sleep 0.3; exit 0');
  const { code, stdout } = cli([agent, 'lead'], { dir });
  assert.equal(code, 0);
  assert.deepEqual(readWake(dir), []);
  assert.equal(stdout, 'lead is down; cmack resume lead starts it again\n');
});

test('one Ctrl-C reaches the agent, not the seat', () => {
  const dir = tmp();
  const agent = fakeAgentThat(dir, 'kill -INT $PPID; kill -TERM $PPID; sleep 0.3; exit 0');
  const { code } = cli([agent, 'lead'], { dir });
  assert.equal(code, 0);
  assert.deepEqual(readWake(dir), []);
});

test('an agent killed by a signal exits the seat with 128 plus the signal', () => {
  const dir = tmp();
  const agent = fakeAgentThat(dir, 'kill -TERM $$');
  assert.equal(cli([agent, 'lead'], { dir }).code, 143);
});

test('the exit of an old copy does not sign out the seat that replaced it', async () => {
  const dir = tmp();
  const agent = fakeAgentThat(dir, 'while [ ! -f "$CMACK_DIR/go" ]; do sleep 0.05; done; exit 0');
  const env = { ...process.env, CMACK_DIR: dir, CMUX_SURFACE_ID: 'S1' };
  const old = new Promise((resolve) => spawn(process.execPath, [BIN, agent, 'lead', 'run'], { env, stdio: 'ignore' }).on('close', resolve));
  const until = Date.now() + 5000;
  while (Date.now() < until && !readWake(dir).some((e) => e.target === 'S1')) await new Promise((r) => setTimeout(r, 20));
  cli(['join', 'lead'], { dir, surface: 'S2' });
  fs.writeFileSync(path.join(dir, 'go'), '');
  assert.equal(await old, 0);
  assert.deepEqual(readWake(dir), [{ name: 'lead', mux: 'cmux', target: 'S2' }]);
  assert.doesNotMatch(readChannel(dir, 'general'), /lead is down/);
});

test('a start without a brief keeps the recorded brief', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  const env = { CMACK_TEST_OUT: path.join(dir, 'out') };
  cli([agent, 'lead', 'run the team'], { dir, env });
  cli([agent, 'lead'], { dir, env });
  assert.match(recorded(dir)[1], /Brief: run the team$/);
});

test('an agent given as a relative path is recorded resolved', () => {
  const dir = tmp();
  fakeAgent(dir);
  cli(['./fake-agent', 'lead'], { dir, cwd: dir, env: { CMACK_TEST_OUT: path.join(dir, 'out') } });
  assert.deepEqual(readTeam(dir), [{ name: 'lead', agent: path.join(dir, 'fake-agent'), brief: '' }]);
});

test('a failed start creates no team folder', () => {
  const cwd = tmp();
  const agent = fakeAgent(cwd);
  const quiet = { write() {} };
  const run = (argv, env) => main(argv, { cwd, env, stdout: quiet, stderr: quiet, run: () => '', sleep: noSleep });
  assert.equal(run([agent, 'lead'], {}), 2);
  assert.equal(run(['frobnicate', 'lead'], { CMUX_SURFACE_ID: 'S1' }), 127);
  assert.equal(run([agent], { CMUX_SURFACE_ID: 'S1' }), 2);
  assert.equal(run(['resume', 'ghost'], { CMUX_SURFACE_ID: 'S1' }), 2);
  assert.ok(!fs.existsSync(path.join(cwd, '.cmack')));
});

test('a mention of a seat that is down is reported as not delivered', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  cli([agent, 'lead'], { dir, env: { CMACK_TEST_OUT: path.join(dir, 'out') } });
  const { code, stderr } = cli(['send', '--from', 'jonny', '@lead take task 3'], { dir });
  assert.equal(code, 0);
  assert.equal(stderr, 'cmack: nudge to lead not delivered (down); message posted\n');
  assert.match(readChannel(dir, 'general'), /Z jonny > @lead take task 3\n$/);
});

test('team shows a tmux seat whose pane is gone as down', () => {
  const dir = tmp();
  cli(['join', 'lead', 'run it', '--mux', 'tmux', '--target', 'sock,%1,123'], { dir, run: () => '999 0 node' });
  assert.equal(cli(['team'], { dir, run: () => '999 0 node' }).stdout, 'lead\t-\tdown\trun it\n');
  assert.equal(cli(['team'], { dir, run: () => '123 0 node' }).stdout, 'lead\t-\tup\trun it\n');
});

test('an agent may carry its own flags, placed before the prompt', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  const { code } = cli([`${agent} --fast --model x`, 'lead', 'go'], { dir, env: { CMACK_TEST_OUT: path.join(dir, 'out') } });
  assert.equal(code, 3);
  assert.deepEqual(recorded(dir).slice(0, 4), ['--fast', '--model', 'x', '--']);
  assert.deepEqual(readTeam(dir), [{ name: 'lead', agent: `${agent} --fast --model x`, brief: 'go' }]);
});

test('opencode takes its prompt as --prompt', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  const opencode = path.join(dir, 'opencode');
  fs.renameSync(agent, opencode);
  cli([opencode, 'lead'], { dir, env: { CMACK_TEST_OUT: path.join(dir, 'out') } });
  const lines = recorded(dir);
  assert.equal(lines[0], '--prompt');
  assert.match(lines[1], /^You are "lead" on a Cmack team, in this pane\. Read the cmack skill before you post, or run: cmack --help\.$/);
});

test('the first seat creates .cmack in the current folder', () => {
  const cwd = tmp();
  const agent = fakeAgent(cwd);
  let stdout = '';
  const code = main([agent, 'lead'], { cwd, env: { CMUX_SURFACE_ID: 'S1', CMACK_TEST_OUT: path.join(cwd, 'out') }, stdout: { write: (s) => { stdout += s; } }, stderr: { write() {} }, run: () => '', sleep: noSleep });
  assert.equal(code, 3);
  assert.ok(fs.statSync(path.join(cwd, '.cmack', 'archive')).isDirectory());
  assert.equal(recorded(cwd)[2], `CMACK_DIR=${path.join(cwd, '.cmack')}`);
});

test('resume starts the recorded agent again with a catch-up prompt', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  const env = { CMACK_TEST_OUT: path.join(dir, 'out') };
  cli([agent, 'lead', 'run the team'], { dir, env });
  const { code } = cli(['resume', 'lead'], { dir, surface: 'S2', env });
  assert.equal(code, 3);
  const lines = recorded(dir);
  assert.match(lines[1], /^You are "lead" on a Cmack team, in this pane, back after a stop\. Read the cmack skill before you post, or run: cmack --help\. Catch up with cmack read and cmack channels before you carry on\. Brief: run the team$/);
  assert.equal(lines[3], 'lead\tcmux\tS2');
});

test('resume of a seat with no record says so', () => {
  const dir = tmp();
  const { code, stderr } = cli(['resume', 'ghost'], { dir });
  assert.equal(code, 2);
  assert.equal(stderr, 'cmack: no record of ghost; start it with cmack <agent> ghost [brief]\n');
});

test('who shows a recorded seat that is down', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  cli([agent, 'lead', 'run the team'], { dir, env: { CMACK_TEST_OUT: path.join(dir, 'out') } });
  cli(['join', 'builder'], { dir, surface: 'S2' });
  assert.equal(cli(['who'], { dir }).stdout, 'builder\tcmux\tS2\nlead\t-\t-\tdown\n');
});

test('team lists every seat with its agent, whether it is up, and its brief', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  cli([agent, 'lead', 'run the team'], { dir, env: { CMACK_TEST_OUT: path.join(dir, 'out') } });
  cli(['join', 'builder', 'build', 'what', 'lead', 'assigns'], { dir, surface: 'S2' });
  cli(['join', 'reviewer'], { dir, surface: 'S3' });
  assert.equal(cli(['team'], { dir }).stdout, `lead\t${agent}\tdown\trun the team\nbuilder\t-\tup\tbuild what lead assigns\nreviewer\t-\tup\t\n`);
});

test('a join from inside a started seat keeps its agent and brief', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  cli([agent, 'lead', 'run the team'], { dir, env: { CMACK_TEST_OUT: path.join(dir, 'out') } });
  cli(['join', 'lead'], { dir, surface: 'S2' });
  assert.deepEqual(readTeam(dir), [{ name: 'lead', agent, brief: 'run the team' }]);
});

test('resume of a seat joined from inside an agent says which command to use', () => {
  const dir = tmp();
  cli(['join', 'lead', 'run the team'], { dir });
  const { code, stderr } = cli(['resume', 'lead'], { dir });
  assert.equal(code, 2);
  assert.equal(stderr, 'cmack: lead was joined from inside a running agent; start it with cmack <agent> lead [brief]\n');
});

test('a command that is not found starts nothing', () => {
  const dir = tmp();
  const { code, stderr } = cli(['frobnicate', 'lead'], { dir });
  assert.equal(code, 127);
  assert.equal(stderr, 'cmack: frobnicate: command not found; cmack --help lists the commands\n');
  assert.deepEqual(readWake(dir), []);
  assert.equal(readChannel(dir, 'general'), '');
});

test('an agent needs a name', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  const { code, stderr } = cli([agent], { dir });
  assert.equal(code, 2);
  assert.equal(stderr, `cmack: ${agent} needs a name: cmack ${agent} <name> [brief]\n`);
});

test('a command with no team says so', () => {
  let stderr = '';
  const code = main(['send', '--from', 'a', 'hi'], { cwd: tmp(), env: {}, stdout: { write() {} }, stderr: { write: (s) => { stderr += s; } } });
  assert.equal(code, 2);
  assert.equal(stderr, 'cmack: no team here; cd to the team folder, set CMACK_DIR, or start one with cmack <agent> <name> [brief]\n');
});

test('join registers the pane and posts to general', () => {
  const dir = tmp();
  const { code, stdout } = cli(['join', 'codex'], { dir });
  assert.equal(code, 0);
  assert.equal(stdout, `joined ${dir} as codex (cmux S1)\n`);
  assert.deepEqual(readWake(dir), [{ name: 'codex', mux: 'cmux', target: 'S1' }]);
  assert.match(readChannel(dir, 'general'), /Z codex > @all codex joined\n$/);
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

test('help', () => {
  const dir = tmp();
  const { code, stdout } = cli(['--help'], { dir });
  assert.equal(code, 0);
  assert.match(stdout, /^usage: cmack <agent> <name> \[brief\]/);
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

// open and adopt: the multiplexer is scripted. Each pane has a tty, and ps on that tty names its
// foreground program (a shell alone for command null); the table also answers tmux's alive check.
const SOCK = '/tmp/tmux-501/default';
function tmuxScript(panes) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'ps') { const p = panes.find((e) => `/dev/tty${e.id.slice(1)}` === args[1]); return p.command ? `Ss   login\nS    -zsh\nS+   ${p.command}\n` : 'Ss   login\nS+   -zsh\n'; }
    if (args.includes('split-window')) return '%5\n';
    if (args.includes('list-panes')) return panes.filter((p) => args.includes('-a') || !p.elsewhere).map((p) => `${p.id}\t${p.pid}\t/dev/tty${p.id.slice(1)}`).join('\n') + '\n';
    if (args.includes('display-message')) {
      const p = panes.find((e) => e.id === args[args.indexOf('-t') + 1]);
      return args.at(-1) === '#{pane_pid}' ? `${p.pid}\n` : `${p.pid} 0 ${p.command ?? 'zsh'}\n`;
    }
    return '';
  };
  run.calls = calls;
  return run;
}
function cliIn(argv, { dir, env, run }) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, { env: { CMACK_DIR: dir, ...env }, cwd: dir, stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, run, sleep: noSleep });
  return { code, stdout, stderr };
}
const inTmux = { TMUX: `${SOCK},1,0`, TMUX_PANE: '%1' };
const quoted = (...parts) => parts.map((p) => `'${p}'`).join(' ');

test('open on tmux seats the caller as --as, splits beside it with the team folder and PATH, and runs the start there', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  const run = tmuxScript([{ id: '%1', pid: 100, command: 'claude' }]);
  const { code, stdout } = cliIn(['open', agent, 'builder', 'build', 'it', '--as', 'lead'], { dir, env: { ...inTmux, PATH: '/p' }, run });
  assert.equal(code, 0);
  assert.equal(stdout, 'opened builder in %5; it joins when its agent starts\n');
  assert.deepEqual(readWake(dir), [{ name: 'lead', mux: 'tmux', target: `${SOCK},%1,100` }]);
  assert.match(readChannel(dir, 'general'), /Z lead > @all lead joined\n$/);
  assert.deepEqual(run.calls.find((c) => c.includes('split-window')), ['tmux', '-S', SOCK, 'split-window', '-d', '-t', '%1', '-c', dir, '-e', `CMACK_DIR=${dir}`, '-e', 'PATH=/p', '-P', '-F', '#{pane_id}', quoted(process.execPath, BIN, agent, 'builder', 'build it')]);
});

test('open on cmux splits right and types the start into the new pane', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'new-split') return 'OK surface:36 workspace:13\n';
    return '';
  };
  const { code, stdout } = cli(['open', agent, 'builder', 'go', '--as', 'lead'], { dir, run });
  assert.equal(code, 0);
  assert.equal(stdout, 'opened builder in surface:36; it joins when its agent starts\n');
  assert.deepEqual(calls.find((c) => c[1] === 'new-split'), ['cmux', 'new-split', 'right', '--surface', 'S1', '--focus', 'false']);
  assert.equal(calls.filter((c) => c[1] === 'tree').length, 0);
  assert.deepEqual(calls.at(-2), ['cmux', 'send', '--surface', 'surface:36', `cd '${dir}' && CMACK_DIR='${dir}' ${quoted(process.execPath, BIN, agent, 'builder', 'go')}`]);
  assert.deepEqual(calls.at(-1), ['cmux', 'send-key', '--surface', 'surface:36', 'enter']);
});

test('open from a seated pane keeps the seat and posts no second join', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  cli(['join', 'lead'], { dir });
  const run = (cmd, args) => (args[0] === 'new-split' ? 'OK surface:36 workspace:13\n' : '');
  assert.equal(cli(['open', agent, 'builder'], { dir, run }).code, 0);
  assert.deepEqual(readWake(dir), [{ name: 'lead', mux: 'cmux', target: 'S1' }]);
  assert.equal(readChannel(dir, 'general').split('joined').length - 1, 1);
});

test('open with an agent that is not found opens no pane', () => {
  const dir = tmp();
  const calls = [];
  const run = (cmd, args) => { calls.push(args[0]); return ''; };
  const { code, stderr } = cli(['open', 'frobnicate', 'x', '--as', 'lead'], { dir, run });
  assert.equal(code, 127);
  assert.equal(stderr, 'cmack: frobnicate: command not found; cmack --help lists the commands\n');
  assert.ok(!calls.includes('new-split'));
  assert.deepEqual(readWake(dir), []);
});

test('adopt on tmux seats every agent pane in the window under its program name, numbers a repeat, skips shells, editors and the caller, and tells each', () => {
  const dir = tmp();
  const run = tmuxScript([
    { id: '%1', pid: 100, command: 'claude' },
    { id: '%2', pid: 200, command: null },
    { id: '%3', pid: 300, command: 'codex' },
    { id: '%4', pid: 400, command: 'claude' },
    { id: '%5', pid: 500, command: 'vim' },
  ]);
  const { code, stdout, stderr } = cliIn(['adopt'], { dir, env: inTmux, run });
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.equal(stdout, 'adopted codex (%3, codex)\nadopted claude-2 (%4, claude)\n');
  assert.deepEqual(readWake(dir), [
    { name: 'claude', mux: 'tmux', target: `${SOCK},%1,100` },
    { name: 'codex', mux: 'tmux', target: `${SOCK},%3,300` },
    { name: 'claude-2', mux: 'tmux', target: `${SOCK},%4,400` },
  ]);
  assert.deepEqual(readTeam(dir).map((s) => s.name), ['claude', 'codex', 'claude-2']);
  const typed = run.calls.filter((c) => c.includes('send-keys') && c.includes('-l')).map((c) => [c[5], c.at(-1)]);
  assert.deepEqual(typed, [
    ['%3', `# cmack: you are codex on the team at ${dir}, run cmack team and cmack read`],
    ['%4', `# cmack: you are claude-2 on the team at ${dir}, run cmack team and cmack read`],
  ]);
  assert.match(readChannel(dir, 'general'), /Z claude > @all claude joined\n\d\d:\d\dZ claude > claude adopted codex, claude-2\n$/);
  const again = cliIn(['adopt'], { dir, env: inTmux, run });
  assert.equal(again.code, 1);
  assert.equal(again.stderr, 'cmack: you are claude; every agent pane around you is already seated\n');
  assert.deepEqual(readWake(dir).map((e) => e.name), ['claude', 'codex', 'claude-2']);
});

test('a bad name, your own pane or your own name stops open and adopt before anything is written', () => {
  const dir = tmp();
  const agent = fakeAgent(dir);
  const run = tmuxScript([{ id: '%1', pid: 100, command: 'claude' }, { id: '%3', pid: 300, command: 'codex' }]);
  const open = cliIn(['open', agent, 'all', '--as', 'lead'], { dir, env: inTmux, run });
  assert.equal(open.code, 2);
  assert.match(open.stderr, /"all" is every seat/);
  assert.equal(cliIn(['adopt', 'builder=%3', 'all=%1', '--as', 'lead'], { dir, env: inTmux, run }).code, 2);
  assert.equal(cliIn(['adopt', 'helper=%1', '--as', 'lead'], { dir, env: inTmux, run }).stderr, 'cmack: %1 is your own pane\n');
  assert.equal(cliIn(['adopt', 'lead=%3', '--as', 'lead'], { dir, env: inTmux, run }).stderr, 'cmack: lead is your own name\n');
  assert.deepEqual(readWake(dir), []);
  assert.equal(readChannel(dir, 'general'), '');
  assert.ok(!run.calls.some((c) => c.includes('split-window') || c.includes('send-keys')));
});

test('adopt with names seats only the named panes, and a pane that is not found stops it before anything is written', () => {
  const dir = tmp();
  const run = tmuxScript([{ id: '%1', pid: 100, command: 'claude' }, { id: '%3', pid: 300, command: 'codex' }, { id: '%4', pid: 400, command: 'grok' }]);
  const missing = cliIn(['adopt', 'reviewer=%9', '--as', 'lead'], { dir, env: inTmux, run });
  assert.equal(missing.code, 2);
  assert.equal(missing.stderr, 'cmack: no pane %9 in tmux\n');
  assert.deepEqual(readWake(dir), []);
  const { code, stdout } = cliIn(['adopt', 'reviewer=%4', '--as', 'lead'], { dir, env: inTmux, run });
  assert.equal(code, 0);
  assert.equal(stdout, 'adopted reviewer (%4, grok)\n');
  assert.deepEqual(readWake(dir).map((e) => e.name), ['lead', 'reviewer']);
});

test('adopt with nothing around you still seats you and says what to do next; a second one does nothing', () => {
  const dir = tmp();
  const run = tmuxScript([{ id: '%1', pid: 100, command: 'claude' }, { id: '%2', pid: 200, command: null }, { id: '%6', pid: 600, command: 'htop' }]);
  const first = cliIn(['adopt', '--as', 'lead'], { dir, env: inTmux, run });
  assert.equal(first.code, 0);
  assert.equal(first.stdout, `seated lead in ${dir}\n`);
  assert.equal(first.stderr, 'cmack: no agent pane around you to adopt; name one with cmack adopt <name>=<pane>\n');
  assert.deepEqual(readWake(dir), [{ name: 'lead', mux: 'tmux', target: `${SOCK},%1,100` }]);
  assert.match(readChannel(dir, 'general'), /Z lead > @all lead joined\n$/);
  const again = cliIn(['adopt'], { dir, env: inTmux, run });
  assert.equal(again.code, 1);
  assert.equal(again.stdout, '');
  assert.equal(again.stderr, 'cmack: you are lead; no agent pane around you to adopt; name one with cmack adopt <name>=<pane>\n');
  assert.equal(readChannel(dir, 'general').split('joined').length - 1, 1);
});

test('a bare adopt alone in its window takes a numbered name when its program name is a seat already', () => {
  const dir = tmp();
  join(dir, { name: 'claude', mux: 'tmux', target: `${SOCK},%9,900` });
  const run = tmuxScript([{ id: '%1', pid: 100, command: 'claude' }]);
  const { code, stdout } = cliIn(['adopt'], { dir, env: inTmux, run });
  assert.equal(code, 0);
  assert.equal(stdout, `seated claude-2 in ${dir}\n`);
  assert.deepEqual(readWake(dir), [{ name: 'claude', mux: 'tmux', target: `${SOCK},%9,900` }, { name: 'claude-2', mux: 'tmux', target: `${SOCK},%1,100` }]);
});

test('a bare adopt from a pane running no agent CLI is not seated under that program', () => {
  const dir = tmp();
  const run = tmuxScript([{ id: '%1', pid: 100, command: 'node' }]);
  const { code, stderr } = cliIn(['adopt'], { dir, env: inTmux, run });
  assert.equal(code, 2);
  assert.equal(stderr, 'cmack: you have no seat and no name was read from your pane; pass --as <your name>\n');
  assert.deepEqual(readWake(dir), []);
});

test('adopt with a name reaches a pane in another tmux window; a bare adopt stays in yours', () => {
  const dir = tmp();
  const run = tmuxScript([{ id: '%1', pid: 100, command: 'claude' }, { id: '%7', pid: 700, command: 'codex', elsewhere: true }]);
  const bare = cliIn(['adopt', '--as', 'lead'], { dir, env: inTmux, run });
  assert.equal(bare.stderr, 'cmack: no agent pane around you to adopt; name one with cmack adopt <name>=<pane>\n');
  const { code, stdout } = cliIn(['adopt', 'reviewer=%7'], { dir, env: inTmux, run });
  assert.equal(code, 0);
  assert.equal(stdout, 'adopted reviewer (%7, codex)\n');
  assert.deepEqual(readWake(dir).map((e) => e.name), ['lead', 'reviewer']);
  assert.ok(run.calls.some((c) => c.includes('send-keys') && c.includes('%7')));
});

test('adopt on cmux reads each surface in the workspace through its tty, skips a shell and a surface with no tty, and tells the agent', () => {
  const dir = tmp();
  const tree = [
    'window window:1 UUID-W [current]',
    '└── workspace workspace:13 UUID-WS "team"',
    '    ├── pane pane:30 UUID-P30 [focused]',
    '    │   └── surface surface:30 S1 [terminal] "me" [selected] ◀ here tty=ttys007',
    '    ├── pane pane:18 UUID-P18',
    '    │   └── surface surface:18 UUID-18 [terminal] "devin" [selected] tty=ttys012',
    '    ├── pane pane:19 UUID-P19',
    '    │   └── surface surface:19 UUID-19 [terminal] "notes on tty=ttys099" [selected] tty=ttys013',
    '    └── pane pane:36 UUID-P36',
    '        └── surface surface:36 UUID-36 [terminal] "Terminal" [selected]',
    '',
  ].join('\n');
  const ps = {
    ttys007: 'S+   caffeinate\nSs   /usr/bin/login\nS    -/bin/zsh\nS+   /Users/x/.local/bin/claude\nS+   node\n',
    ttys012: 'Ss   login\nS    -zsh\nS+   devin\n',
    ttys013: 'Ss   login\nS+   -zsh\n',
  };
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'identify') return '{"caller":{"workspace_ref":"workspace:13","surface_id":"S1"}}\n';
    if (args[0] === 'tree') return tree;
    if (cmd === 'ps') return ps[args[1]];
    return '';
  };
  const { code, stdout } = cli(['adopt'], { dir, run });
  assert.equal(code, 0);
  assert.equal(stdout, 'adopted devin (surface:18, devin)\n');
  assert.deepEqual(readWake(dir), [{ name: 'claude', mux: 'cmux', target: 'S1' }, { name: 'devin', mux: 'cmux', target: 'UUID-18' }]);
  assert.deepEqual(calls.find((c) => c[1] === 'tree'), ['cmux', 'tree', '--workspace', 'workspace:13', '--id-format', 'both']);
  assert.deepEqual(calls.at(-2), ['cmux', 'send', '--surface', 'UUID-18', `# cmack: you are devin on the team at ${dir}, run cmack team and cmack read`]);
  assert.deepEqual(calls.at(-1), ['cmux', 'send-key', '--surface', 'UUID-18', 'enter']);
});

test('adopt with a name on cmux reaches a surface in another workspace', () => {
  const dir = tmp();
  const mine = [
    'window window:1 UUID-W [current]',
    '├── workspace workspace:13 UUID-WS "team"',
    '│       └── surface surface:30 S1 [terminal] "me" [selected] ◀ here tty=ttys007',
    '',
  ].join('\n');
  const all = [
    mine.trimEnd(),
    '└── workspace workspace:14 UUID-WS2 "sig"',
    '        └── surface surface:32 UUID-32 [terminal] "sig" [selected] tty=ttys020',
    '',
  ].join('\n');
  const ps = { ttys007: 'Ss   login\nS    -zsh\nS+   claude\n', ttys020: 'Ss   login\nS    -zsh\nS+   codex\n' };
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'identify') return '{"caller":{"workspace_ref":"workspace:13","surface_id":"S1"}}\n';
    if (args[0] === 'tree') return args.includes('--all') ? all : mine;
    if (cmd === 'ps') return ps[args[1]];
    return '';
  };
  const bare = cli(['adopt', '--as', 'lead'], { dir, run });
  assert.equal(bare.stdout, `seated lead in ${dir}\n`);
  const { code, stdout } = cli(['adopt', 'sig=surface:32'], { dir, run });
  assert.equal(code, 0);
  assert.equal(stdout, 'adopted sig (surface:32, codex)\n');
  assert.deepEqual(readWake(dir), [{ name: 'lead', mux: 'cmux', target: 'S1' }, { name: 'sig', mux: 'cmux', target: 'UUID-32' }]);
  assert.deepEqual(calls.find((c) => c[1] === 'tree' && !c.includes('--workspace')), ['cmux', 'tree', '--all', '--id-format', 'both']);
  assert.deepEqual(calls.at(-2), ['cmux', 'send', '--surface', 'UUID-32', `# cmack: you are sig on the team at ${dir}, run cmack team and cmack read`]);
});

test('claim posts to #general, a second claim by another seat is refused with the holder, claims lists it, release posts', () => {
  const dir = tmp();
  assert.deepEqual(cli(['claim', 'main', '--from', 'lead'], { dir }), { code: 0, stdout: 'lead holds main\n', stderr: '' });
  const refused = cli(['claim', 'main', '--from', 'builder'], { dir });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^cmack: main is held by lead since \d{4}-\d\d-\d\dT\d\d:\d\dZ\n$/);
  assert.match(cli(['claims'], { dir }).stdout, /^main\tlead\t\d{4}-\d\d-\d\dT\d\d:\d\dZ\n$/);
  assert.deepEqual(cli(['release', 'main', '--from', 'builder'], { dir }), { code: 0, stdout: 'main released, lead held it\n', stderr: '' });
  assert.equal(cli(['release', 'main', '--from', 'builder'], { dir }).code, 1);
  assert.equal(cli(['claims'], { dir }).stdout, '');
  assert.match(readChannel(dir, 'general'), /Z lead > lead claimed main\n\d\d:\d\dZ builder > builder released main, lead held it\n$/);
});

test('a seat that goes down releases what it held, and the down post says so', () => {
  const dir = tmp();
  const agent = fakeAgentThat(dir, 'CMACK_DIR="$CMACK_DIR" "$CMACK_NODE" "$CMACK_BIN" claim main --from lead >/dev/null; exit 0');
  const { code, stdout } = cli([agent, 'lead'], { dir, env: { CMACK_BIN: BIN, CMACK_NODE: process.execPath } });
  assert.equal(code, 0);
  assert.equal(cli(['claims'], { dir }).stdout, '');
  assert.match(readChannel(dir, 'general'), /Z lead > lead claimed main\n\d\d:\d\dZ lead > lead is down, released main\n$/);
  assert.equal(stdout, 'lead is down; cmack resume lead starts it again\n');
});

test('leave releases what the seat held', () => {
  const dir = tmp();
  cli(['join', 'lead'], { dir });
  cli(['claim', 'main'], { dir });
  assert.deepEqual(cli(['leave'], { dir }), { code: 0, stdout: 'left lead, released main\n', stderr: '' });
  assert.equal(cli(['claims'], { dir }).stdout, '');
  assert.match(readChannel(dir, 'general'), /Z lead > lead released main\n$/);
});

test('a claim held by a seat that is down is taken over, and the post says so; a holder with no seat is never taken over', () => {
  const dir = tmp();
  cli(['join', 'builder'], { dir, surface: 'S2' });
  cli(['claim', 'main'], { dir, surface: 'S2' });
  fs.writeFileSync(path.join(dir, 'wake.txt'), '');
  assert.deepEqual(cli(['claim', 'main', '--from', 'lead'], { dir }), { code: 0, stdout: 'lead holds main, builder held it and is down\n', stderr: '' });
  assert.match(readChannel(dir, 'general'), /Z lead > lead claimed main, builder held it and is down\n$/);
  assert.equal(cli(['claim', 'main', '--from', 'jonny'], { dir }).code, 1);
});

test('a bad --from name claims and releases nothing', () => {
  const dir = tmp();
  assert.equal(cli(['claim', 'main', '--from', 'lead\nevil\tbuilder\t2020'], { dir }).code, 2);
  assert.equal(cli(['claims'], { dir }).stdout, '');
  cli(['claim', 'main', '--from', 'lead'], { dir });
  assert.equal(cli(['release', 'main', '--from', 'x y'], { dir }).code, 2);
  assert.match(cli(['claims'], { dir }).stdout, /^main\tlead\t/);
});

test('leave releases the claims of a seat whose pane entry was taken over', () => {
  const dir = tmp();
  cli(['join', 'lead'], { dir });
  cli(['claim', 'main'], { dir });
  cli(['join', 'builder'], { dir });
  assert.deepEqual(cli(['leave', 'lead'], { dir }), { code: 0, stdout: 'left lead, released main\n', stderr: '' });
  assert.equal(cli(['claims'], { dir }).stdout, '');
  assert.equal(cli(['leave', 'lead'], { dir }).code, 1);
});

test('a thing is one line in every message, and a missing thing is a usage error', () => {
  const dir = tmp();
  assert.equal(cli(['claim', 'auth  fix', '--from', 'lead'], { dir }).stdout, 'lead holds auth fix\n');
  assert.equal(cli(['release', 'auth  fix', '--from', 'lead'], { dir }).code, 0);
  assert.deepEqual(cli(['release', '--from', 'lead'], { dir }), { code: 2, stdout: '', stderr: 'cmack: release needs a thing: cmack release <thing>\n' });
  assert.deepEqual(cli(['claim', '--from', 'lead'], { dir }), { code: 2, stdout: '', stderr: 'cmack: claim needs a thing: cmack claim <thing>\n' });
});

test('board prints the team on one screen', () => {
  const dir = tmp();
  cli(['join', 'lead', 'run the team'], { dir });
  const { code, stdout } = cli(['board'], { dir });
  assert.equal(code, 0);
  assert.match(stdout, /^seat  agent  state  holds  last post\nlead  -      up     -      (<1m|1m)  #general  @all lead joined\n$/);
});

test('leave by another seat posts under that seat\'s name, not the one who left', () => {
  const dir = tmp();
  cli(['join', 'lead'], { dir });
  cli(['join', 'builder'], { dir, surface: 'S2' });
  cli(['claim', 'main'], { dir, surface: 'S2' });
  assert.deepEqual(cli(['leave', 'builder'], { dir }), { code: 0, stdout: 'left builder, released main\n', stderr: '' });
  assert.match(readChannel(dir, 'general'), /Z lead > lead released main for builder\n$/);
});
