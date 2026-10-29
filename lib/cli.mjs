import { findTeamDir, ensureTeamDir, initTeamDir } from './team.mjs';
import { readChannel, listChannels, DEFAULT_CHANNEL } from './channel.mjs';
import { readWake, join, leave, whoAmI } from './wake.mjs';
import { detect, adapters, defaultRun } from './mux.mjs';
import { send } from './send.mjs';
import { watch } from './watch.mjs';
import { sleepMs } from './lock.mjs';

const USAGE = `usage: cmack <command>

  init                                create .cmack/ in this folder
  join <name> [--mux m --target t]    register this pane as <name>
  leave [name]                        remove a seat from the team
  send [-c channel] [--from name] <text...>
  read [channel] [-n 40]
  channels
  who
  watch [--as name]

The team folder is CMACK_DIR, else the nearest .cmack/ above you, else ~/.cmack.
`;

const FLAGS = { '-c': 'channel', '--channel': 'channel', '--from': 'from', '-n': 'n', '--as': 'as', '--mux': 'mux', '--target': 'target' };

export function main(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, run = defaultRun, sleep = sleepMs } = {}) {
  const { command, flags, rest } = parse(argv);
  const out = (s) => stdout.write(`${s}\n`);
  const err = (s) => stderr.write(`${s}\n`);
  if (!command || argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  try {
    if (command === 'init') { out(initTeamDir(cwd)); return 0; }
    const dir = ensureTeamDir(findTeamDir({ cwd, env }));
    // Only a command that needs the caller's identity asks the multiplexer which pane this is;
    // a sandbox may block that socket, and a read or a send with --from must still work.
    const pane = () => (flags.mux && flags.target ? { mux: flags.mux, target: flags.target } : detect(env, run));
    const me = () => { try { const p = pane(); return p ? whoAmI(dir, p) : null; } catch { return null; } };
    switch (command) {
      case 'join': {
        const name = rest[0];
        if (!name) { err('cmack: join needs a name'); return 2; }
        const here = pane();
        if (!here) { err('cmack: not inside tmux or cmux; pass --mux and --target'); return 2; }
        join(dir, { name, ...here });
        send({ dir, from: name, text: `${name} joined`, run, sleep });
        out(`joined ${dir} as ${name} (${here.mux} ${here.target})`);
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
      case 'who':
        for (const e of readWake(dir)) {
          const alive = adapters[e.mux]?.alive(e.target, run) ?? { ok: false, reason: `unknown multiplexer ${e.mux}` };
          out(`${e.name}\t${e.mux}\t${e.target}${alive.ok ? '' : `\t${alive.reason}`}`);
        }
        return 0;
      case 'watch':
        watch({ dir, skip: flags.as ?? me() ?? undefined, out: stdout, sleep });
        return 0;
      default:
        stderr.write(USAGE);
        return 2;
    }
  } catch (error) {
    err(error.message);
    return 1;
  }
}

function parse([command, ...args]) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const key = FLAGS[args[i]];
    if (key) flags[key] = args[++i];
    else rest.push(args[i]);
  }
  return { command, flags, rest };
}
