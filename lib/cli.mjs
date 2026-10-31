import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findTeamDir, ensureTeamDir, readTeam, recordSeat } from './team.mjs';
import { readChannel, listChannels, DEFAULT_CHANNEL } from './channel.mjs';
import { readWake, join, leave, whoAmI, assertName } from './wake.mjs';
import { detect, adapters, defaultRun, adoptLine, AGENTS } from './mux.mjs';
import { send } from './send.mjs';
import { watch } from './watch.mjs';
import { readClaims, claim, release, releaseAll } from './claims.mjs';
import { board } from './board.mjs';
import { sleepMs } from './lock.mjs';

const USAGE = `usage: cmack <agent> <name> [brief]      start <agent> in this pane as <name>
       cmack resume <name>               start a seat again, in this pane
       cmack <command>

  open <agent> <name> [brief]         open a pane beside you and start <agent> there as <name>
  adopt [<name>=<pane> ...]           seat the claude, codex, grok, devin or opencode panes around you, and tell each
  join <name> [brief]                 join from inside a running agent
  leave [name]                        free a seat
  team                                every seat: agent, up or down, brief
  board                               one screen: every seat, up or down, what it holds, its last post and how long ago
  send [-c channel] [--from name] <text...>
  read [channel] [-n 40]
  channels
  who
  watch [--as name]
  claim <thing>                       hold a thing, so no other seat takes it; refused while held
  release <thing>                     let a thing go
  claims                              every held thing: who holds it, since when

  cmack codex lead 'coordinate the team, delegate, accept steering'

The team folder is CMACK_DIR, else the nearest .cmack/ above you. The first seat creates it here.
open and adopt seat you first if you have none: as --as <name>, else as your program's name. @all is every seat that is up.
A seat that leaves or exits releases what it held. A claim held by a seat that is down is taken over by the next claim.
`;

const COMMANDS = new Set(['join', 'leave', 'team', 'send', 'read', 'channels', 'who', 'watch', 'resume', 'open', 'adopt', 'claim', 'release', 'claims', 'board']);
const CREATORS = new Set(['join', 'open', 'adopt']);
const BIN = fileURLToPath(new URL('../bin/cmack.mjs', import.meta.url));
const FLAGS = { '-c': 'channel', '--channel': 'channel', '--from': 'from', '-n': 'n', '--as': 'as', '--mux': 'mux', '--target': 'target' };
// OpenCode takes its first prompt as an option; every other agent CLI checked takes it after --.
const PROMPT_ARGS = { opencode: (prompt) => ['--prompt', prompt] };
// Ctrl-C, a closed pane and a kill are for the agent; the seat outlives them to free itself.
const SIGNALS = ['SIGINT', 'SIGHUP', 'SIGTERM'];

export function main(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, run = defaultRun, sleep = sleepMs, now = new Date() } = {}) {
  const [command, ...args] = argv;
  const out = (s) => stdout.write(`${s}\n`);
  const err = (s) => stderr.write(`${s}\n`);
  if (!command || argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  try {
    const found = findTeamDir({ cwd, env });
    const creates = !COMMANDS.has(command) || CREATORS.has(command);
    if (!found && !creates) { err('cmack: no team here; cd to the team folder, set CMACK_DIR, or start one with cmack <agent> <name> [brief]'); return 2; }
    // A new team folder is created only by a start or a join, and only once its checks pass.
    const dir = found ?? path.join(cwd, '.cmack');
    if (found) ensureTeamDir(dir);
    const { flags, rest } = parse(args);
    // Only a command that needs the caller's identity asks the multiplexer which pane this is;
    // a sandbox may block that socket, and a read or a send with --from must still work.
    const pane = () => (flags.mux && flags.target ? { mux: flags.mux, target: flags.target } : detect(env, run));
    const me = () => { try { const p = pane(); return p ? whoAmI(dir, p) : null; } catch { return null; } };
    const isDown = (name) => readTeam(dir).some((s) => s.name === name) && !readWake(dir).some((e) => e.name === name && adapters[e.mux]?.alive(e.target, run).ok);
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
      send({ dir, from: name, text: `@all ${name} joined`, run, sleep });
      const ignore = () => {};
      for (const sig of SIGNALS) process.on(sig, ignore);
      const promptArgs = (PROMPT_ARGS[path.basename(cmd)] ?? ((p) => ['--', p]))(firstPrompt(name, seat.brief, resumed));
      const child = spawnSync(command, [...agentFlags, ...promptArgs], { stdio: 'inherit', env: { ...env, CMACK_DIR: dir } });
      for (const sig of SIGNALS) process.off(sig, ignore);
      if (leave(dir, name, here)) {
        const held = releaseAll(dir, name);
        send({ dir, from: name, text: `${name} is down${held.length ? `, released ${held.join(', ')}` : ''}`, run, sleep });
        out(`${name} is down; cmack resume ${name} starts it again`);
      } else {
        out(`${name} carried on in another pane`);
      }
      if (child.error) { err(child.error.message); return 1; }
      return child.signal ? 128 + os.constants.signals[child.signal] : child.status;
    };
    if (!COMMANDS.has(command)) return start({ agent: command, name: args[0], brief: args.slice(1).join(' ') });
    // A caller with no seat takes one first: the name given as --as, else its own program's name.
    const seatCaller = (here) => {
      const seated = whoAmI(dir, here);
      if (seated) return seated;
      const name = flags.as ?? adapters[here.mux].panes(here.target, run).find((p) => p.self)?.command;
      if (!name) return null;
      ensureTeamDir(dir);
      join(dir, { name, ...here });
      recordSeat(dir, { name });
      send({ dir, from: name, text: `@all ${name} joined`, run, sleep });
      return name;
    };
    switch (command) {
      case 'open': {
        const [agent, name, ...words] = rest;
        if (!agent || !name) { err('cmack: open needs an agent and a name: cmack open <agent> <name> [brief]'); return 2; }
        const [cmd] = agent.split(' ').filter(Boolean);
        if (!findCommand(cmd, env, cwd)) { err(`cmack: ${cmd}: command not found; cmack --help lists the commands`); return 127; }
        try { assertName(name); } catch (error) { err(error.message); return 2; }
        const here = pane();
        if (!here) { err('cmack: not inside tmux or cmux'); return 2; }
        if (!seatCaller(here)) { err('cmack: you have no seat and no name was read from your pane; pass --as <your name>'); return 2; }
        const brief = words.join(' ');
        const opened = adapters[here.mux].open(here.target, { cwd, dir, path: env.PATH, command: [process.execPath, BIN, agent, name, ...(brief ? [brief] : [])] }, run, sleep);
        if (!opened.ok) { err(`cmack: no pane opened (${opened.reason})`); return 1; }
        out(`opened ${name} in ${opened.ref}; it joins when its agent starts`);
        return 0;
      }
      case 'adopt': {
        const here = pane();
        if (!here) { err('cmack: not inside tmux or cmux'); return 2; }
        const around = adapters[here.mux].panes(here.target, run);
        const callerName = whoAmI(dir, here) ?? flags.as ?? around.find((p) => p.self)?.command;
        // Every check runs before anything is written: a bad name or a pane that is not around you seats nobody.
        let wanted;
        if (rest.length) {
          wanted = [];
          for (const arg of rest) {
            const [name, ref] = arg.split('=');
            const found = around.find((p) => p.ref === ref || p.target === ref);
            if (!name || !ref || !found) { err(`cmack: no pane ${ref ?? arg} around you`); return 2; }
            try { assertName(name); } catch (error) { err(error.message); return 2; }
            if (found.self) { err(`cmack: ${ref} is your own pane`); return 2; }
            if (name === callerName) { err(`cmack: ${name} is your own name`); return 2; }
            wanted.push({ name, pane: found });
          }
        } else {
          // Only a known agent CLI, and only a pane with no seat yet, so an editor is never typed into
          // and a second adopt renames nobody.
          const seated = new Set(readWake(dir).filter((e) => e.mux === here.mux).map((e) => e.target));
          const agents = around.filter((p) => !p.self && AGENTS.has(p.command));
          wanted = agents.filter((p) => !seated.has(p.target)).map((p) => ({ name: p.command, pane: p }));
          if (!wanted.length) { err(agents.length ? 'cmack: every agent pane around you is already seated' : 'cmack: no agent pane around you to adopt'); return 1; }
        }
        const caller = seatCaller(here);
        if (!caller) { err('cmack: you have no seat and no name was read from your pane; pass --as <your name>'); return 2; }
        // A default name that is taken gets a number, so adopting a second claude never evicts the first.
        const taken = new Set([...readWake(dir), ...readTeam(dir)].map((e) => e.name));
        const names = [];
        for (const { name: base, pane: p } of wanted) {
          let name = base;
          if (!rest.length) for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
          taken.add(name);
          join(dir, { name, mux: here.mux, target: p.target });
          recordSeat(dir, { name });
          names.push(name);
          out(`adopted ${name} (${p.ref}, ${p.command ?? 'shell'})`);
          const told = adapters[here.mux].nudge(p.target, adoptLine(name, dir), run, sleep);
          if (!told.ok) err(`cmack: ${name} was not told (${told.reason}); tell it yourself`);
        }
        send({ dir, from: caller, text: `${caller} adopted ${names.join(', ')}`, run, sleep });
        return 0;
      }
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
        send({ dir, from: name, text: `@all ${name} joined`, run, sleep });
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
        // A seat whose pane entry was taken over still holds its claims, so those go even when leave finds no entry.
        // The post is by whoever ran leave, so removing another seat never reads as that seat's own activity.
        const actor = flags.from ?? me() ?? name;
        const left = leave(dir, name);
        const held = releaseAll(dir, name);
        if (!left && !held.length) { err(`cmack: ${name} is not on the team`); return 1; }
        if (held.length) send({ dir, from: actor, text: `${actor} released ${held.join(', ')}${actor === name ? '' : ` for ${name}`}`, run, sleep });
        out(`left ${name}${held.length ? `, released ${held.join(', ')}` : ''}`);
        return 0;
      }
      case 'claim': {
        const holder = flags.from ?? me();
        if (!holder) { err('cmack: not joined here; run cmack join <name> or pass --from <name>'); return 2; }
        try { assertName(holder); } catch (error) { err(error.message); return 2; }
        const thing = oneLine(rest);
        if (!thing) { err('cmack: claim needs a thing: cmack claim <thing>'); return 2; }
        let got = claim(dir, { thing, holder });
        let note = '';
        // A seat that is down holds nothing: its claim is taken over, and the post names it. A holder
        // that was never a seat is a person, or a sandboxed seat posting with --from, and is never taken over.
        if (!got.ok && isDown(got.holder)) {
          note = `, ${got.holder} held it and is down`;
          release(dir, thing);
          got = claim(dir, { thing, holder });
        }
        if (!got.ok) { err(`cmack: ${thing} is held by ${got.holder} since ${got.since}`); return 1; }
        send({ dir, from: holder, text: `${holder} claimed ${thing}${note}`, run, sleep });
        out(`${holder} holds ${thing}${note}`);
        return 0;
      }
      case 'release': {
        const from = flags.from ?? me();
        if (!from) { err('cmack: not joined here; run cmack join <name> or pass --from <name>'); return 2; }
        try { assertName(from); } catch (error) { err(error.message); return 2; }
        const thing = oneLine(rest);
        if (!thing) { err('cmack: release needs a thing: cmack release <thing>'); return 2; }
        const holder = release(dir, thing);
        if (!holder) { err(`cmack: ${thing} is not held`); return 1; }
        const by = holder === from ? '' : `, ${holder} held it`;
        send({ dir, from, text: `${from} released ${thing}${by}`, run, sleep });
        out(`${thing} released${by}`);
        return 0;
      }
      case 'claims':
        for (const c of readClaims(dir)) out(`${c.thing}\t${c.holder}\t${c.since}`);
        return 0;
      case 'board':
        for (const line of board(dir, { now, run })) out(line);
        return 0;
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

const oneLine = (words) => words.join(' ').replace(/\s+/g, ' ').trim();

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
