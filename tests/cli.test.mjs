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
  assert.match(readChannel(dir, 'general'), /Z lead > lead joined\n\d\d:\d\dZ lead > lead is down\n$/);
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
