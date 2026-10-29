import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findTeamDir, ensureTeamDir, readTeam, recordSeat } from './team.mjs';
import { readChannel, listChannels, DEFAULT_CHANNEL } from './channel.mjs';
import { readWake, join, leave, whoAmI } from './wake.mjs';
import { detect, adapters, defaultRun } from './mux.mjs';
import { send } from './send.mjs';
import { watch } from './watch.mjs';
import { sleepMs } from './lock.mjs';

const USAGE = `usage: cmack <agent> <name> [brief]      start <agent> in this pane as <name>
       cmack resume <name>               start a seat again, in this pane
       cmack <command>

  join <name> [brief]                 join from inside a running agent
  leave [name]                        free a seat
  team                                every seat: agent, up or down, brief
  send [-c channel] [--from name] <text...>
  read [channel] [-n 40]
  channels
  who
  watch [--as name]

  cmack codex lead 'coordinate the team, delegate, accept steering'

The team folder is CMACK_DIR, else the nearest .cmack/ above you. The first seat creates it here.
`;

const COMMANDS = new Set(['join', 'leave', 'team', 'send', 'read', 'channels', 'who', 'watch', 'resume']);
const FLAGS = { '-c': 'channel', '--channel': 'channel', '--from': 'from', '-n': 'n', '--as': 'as', '--mux': 'mux', '--target': 'target' };
// OpenCode takes its first prompt as an option; every other agent CLI checked takes it after --.
const PROMPT_ARGS = { opencode: (prompt) => ['--prompt', prompt] };
// Ctrl-C, a closed pane and a kill are for the agent; the seat outlives them to free itself.
const SIGNALS = ['SIGINT', 'SIGHUP', 'SIGTERM'];

export function main(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, run = defaultRun, sleep = sleepMs } = {}) {
  const [command, ...args] = argv;
  const out = (s) => stdout.write(`${s}\n`);
  const err = (s) => stderr.write(`${s}\n`);
  if (!command || argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  try {
    const found = findTeamDir({ cwd, env });
    const creates = !COMMANDS.has(command) || command === 'join';
    if (!found && !creates) { err('cmack: no team here; cd to the team folder, set CMACK_DIR, or start one with cmack <agent> <name> [brief]'); return 2; }
    // A new team folder is created only by a start or a join, and only once its checks pass.
    const dir = found ?? path.join(cwd, '.cmack');
    if (found) ensureTeamDir(dir);
    const { flags, rest } = parse(args);
    // Only a command that needs the caller's identity asks the multiplexer which pane this is;
    // a sandbox may block that socket, and a read or a send with --from must still work.
    const pane = () => (flags.mux && flags.target ? { mux: flags.mux, target: flags.target } : detect(env, run));
    const me = () => { try { const p = pane(); return p ? whoAmI(dir, p) : null; } catch { return null; } };
    const start = ({ agent, name, brief, resumed = false }) => {
      // The agent may carry its own flags: cmack 'claude --permission-mode acceptEdits' lead 'brief'.
      const [cmd, ...agentFlags] = agent.split(' ').filter(Boolean);
      const command = findCommand(cmd, env, cwd);
      if (!command) { err(`cmack: ${cmd}: command not found; cmack --help lists the commands`); return 127; }
      if (!name) { err(`cmack: ${agent} needs a name: cmack ${agent} <name> [brief]`); return 2; }
      const here = pane();
      if (!here) { err('cmack: not inside tmux or cmux'); return 2; }
      ensureTeamDir(dir);
      join(dir, { name, ...here });
      const seat = recordSeat(dir, { name, agent: [cmd.includes('/') ? command : cmd, ...agentFlags].join(' '), brief });
      send({ dir, from: name, text: `${name} joined`, run, sleep });
      const ignore = () => {};
      for (const sig of SIGNALS) process.on(sig, ignore);
      const promptArgs = (PROMPT_ARGS[path.basename(cmd)] ?? ((p) => ['--', p]))(firstPrompt(name, seat.brief, resumed));
      const child = spawnSync(command, [...agentFlags, ...promptArgs], { stdio: 'inherit', env: { ...env, CMACK_DIR: dir } });
      for (const sig of SIGNALS) process.off(sig, ignore);
      if (leave(dir, name, here)) {
        send({ dir, from: name, text: `${name} is down`, run, sleep });
        out(`${name} is down; cmack resume ${name} starts it again`);
      } else {
        out(`${name} carried on in another pane`);
      }
      if (child.error) { err(child.error.message); return 1; }
      return child.signal ? 128 + os.constants.signals[child.signal] : child.status;
    };
    if (!COMMANDS.has(command)) return start({ agent: command, name: args[0], brief: args.slice(1).join(' ') });
    switch (command) {
      case 'resume': {
        const name = rest[0];
        if (!name) { err('cmack: resume needs a name'); return 2; }
        const seat = readTeam(dir).find((s) => s.name === name);
        if (!seat) { err(`cmack: no record of ${name}; start it with cmack <agent> ${name} [brief]`); return 2; }
        if (!seat.agent) { err(`cmack: ${name} was joined from inside a running agent; start it with cmack <agent> ${name} [brief]`); return 2; }
        return start({ ...seat, resumed: true });
      }
      case 'join': {
        const name = rest[0];
        if (!name) { err('cmack: join needs a name'); return 2; }
        const here = pane();
        if (!here) { err('cmack: not inside tmux or cmux; pass --mux and --target'); return 2; }
        ensureTeamDir(dir);
        join(dir, { name, ...here });
        recordSeat(dir, { name, brief: rest.slice(1).join(' ') });
        send({ dir, from: name, text: `${name} joined`, run, sleep });
        out(`joined ${dir} as ${name} (${here.mux} ${here.target})`);
        return 0;
      }
      case 'team': {
        const up = new Set(readWake(dir).filter((e) => adapters[e.mux]?.alive(e.target, run).ok).map((e) => e.name));
        for (const s of readTeam(dir)) out(`${s.name}\t${s.agent || '-'}\t${up.has(s.name) ? 'up' : 'down'}\t${s.brief}`);
        return 0;
      }
      case 'leave': {
        const name = rest[0] ?? me();
        if (!name) { err('cmack: leave needs a name'); return 2; }
        if (!leave(dir, name)) { err(`cmack: ${name} is not on the team`); return 1; }
        out(`left ${name}`);
        return 0;
      }
      case 'send': {
        const from = flags.from ?? me();
        if (!from) { err('cmack: not joined here; run cmack join <name> or pass --from <name>'); return 2; }
        const { nudged } = send({ dir, from, channel: flags.channel ?? DEFAULT_CHANNEL, text: rest.join(' '), run, sleep });
        for (const n of nudged) if (!n.ok) err(`cmack: nudge to ${n.name} not delivered (${n.reason}); message posted`);
        return 0;
      }
      case 'read':
        stdout.write(readChannel(dir, rest[0] ?? DEFAULT_CHANNEL, { count: Number(flags.n ?? 40) }));
        return 0;
      case 'channels':
        for (const c of listChannels(dir)) out(`${c.name}\t${c.lastAt ?? '-'}`);
        return 0;
      case 'who': {
        const live = readWake(dir);
        for (const e of live) {
          const alive = adapters[e.mux]?.alive(e.target, run) ?? { ok: false, reason: `unknown multiplexer ${e.mux}` };
          out(`${e.name}\t${e.mux}\t${e.target}${alive.ok ? '' : `\t${alive.reason}`}`);
        }
        for (const s of readTeam(dir)) if (!live.some((e) => e.name === s.name)) out(`${s.name}\t-\t-\tdown`);
        return 0;
      }
      case 'watch':
        watch({ dir, skip: flags.as ?? me() ?? undefined, out: stdout, sleep });
        return 0;
    }
  } catch (error) {
    err(error.message);
    return 1;
  }
}

function firstPrompt(name, brief, resumed) {
  return [
    `You are "${name}" on a Cmack team, in this pane${resumed ? ', back after a stop' : ''}.`,
    'Read the cmack skill before you post, or run: cmack --help.',
    resumed ? 'Catch up with cmack read and cmack channels before you carry on.' : '',
    brief ? `Brief: ${brief}` : '',
  ].filter(Boolean).join(' ');
}

// The agent is looked up before anything is written, so a typo starts no seat and posts nothing.
function findCommand(cmd, env, cwd) {
  const candidates = cmd.includes('/') ? [path.resolve(cwd, cmd)] : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, cmd));
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
}

function parse(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const key = FLAGS[args[i]];
    if (key) flags[key] = args[++i];
    else rest.push(args[i]);
  }
  return { flags, rest };
}
