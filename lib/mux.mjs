import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { sleepMs } from './lock.mjs';

// Some agent CLIs swallow an enter that arrives in the same instant as the text.
export const ENTER_DELAY_MS = 200;
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash']);
// The agent CLIs a pane is read for; a wrapper such as caffeinate in the same foreground loses to one of
// these, and a bare adopt takes only panes running one of these, so an editor or a build is never typed into.
export const AGENTS = new Set(['claude', 'codex', 'grok', 'devin', 'opencode']);

// The nudge carries no message text, so nothing from a message can reach a shell,
// and it starts with a hash, so a bare shell reads it as a comment.
export const nudgeLine = (from, channel) => `# cmack: ${from} mentioned you in #${channel}`;
// The line typed into a pane that adopt has just seated: its name and the team folder, nothing free, and
// no semicolon, so a zsh that does not read # as a comment runs one command that is not found, not two.
export const adoptLine = (name, dir) => `# cmack: you are ${name} on the team at ${dir}, run cmack team and cmack read`;

export const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// Every multiplexer call has a deadline: tmux holds send-keys open while a pane is in copy
// mode and a person has a prompt up, and no send may hang on that.
export const RUN_TIMEOUT_MS = 5000;
export function defaultRun(cmd, args, { timeout = RUN_TIMEOUT_MS } = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
}

// Which multiplexer this process runs in, and the pane it is in, from the environment.
// tmux first: a tmux pane started inside a cmux pane inherits CMUX_SURFACE_ID, and the
// innermost multiplexer is the one that can type into this pane.
export function detect(env, run = defaultRun) {
  if (env.TMUX && env.TMUX_PANE) {
    const socket = env.TMUX.split(',')[0];
    const pid = run('tmux', ['-S', socket, 'display-message', '-p', '-t', env.TMUX_PANE, '#{pane_pid}']).trim();
    return { mux: 'tmux', target: `${socket},${env.TMUX_PANE},${pid}` };
  }
  if (env.CMUX_SURFACE_ID) return { mux: 'cmux', target: env.CMUX_SURFACE_ID };
  return null;
}

// The multiplexer's own words are in stderr; execFileSync's message only repeats the argv.
function failure(error) {
  if (error?.code === 'ETIMEDOUT') return { ok: false, reason: `no answer within ${RUN_TIMEOUT_MS / 1000} s` };
  const text = String(error?.stderr ?? '').trim() || String(error?.message ?? error);
  return { ok: false, reason: text.split('\n').find((line) => line.trim()) ?? 'failed' };
}

const tmux = {
  // A tmux pane id is reused after a server restart; the pane's shell pid tells the panes apart.
  // A pane in copy mode (scrolled back) would feed the nudge to copy mode's key bindings and
  // hold the call open on a prompt, so it is reported instead of typed into.
  alive(target, run = defaultRun) {
    const [socket, pane, pid] = target.split(',');
    let out;
    try {
      out = run('tmux', ['-S', socket, 'display-message', '-p', '-t', pane, '#{pane_pid} #{pane_in_mode} #{pane_current_command}']);
    } catch (error) {
      const f = failure(error);
      return /can't find (pane|window|session)/.test(f.reason) ? { ok: false, reason: 'pane gone' } : f;
    }
    const [livePid, inMode, ...command] = out.trim().split(' ');
    if (livePid !== pid) return { ok: false, reason: 'pane gone' };
    if (inMode === '1') return { ok: false, reason: 'pane scrolled back' };
    if (SHELLS.has(command.join(' '))) return { ok: false, reason: 'nobody home' };
    return { ok: true };
  },
  // Every pane in the caller's window, or on the server with everywhere: its id, its target, the program in its foreground (null for
  // a bare shell), and whether it is the caller's own. tmux's own name for a pane's program is the
  // executable's file name (a native Claude Code is its version number), so the program is read
  // through the pane's tty, as on cmux.
  // Your window by default; every pane on the server when a pane is named, so a team can span windows.
  panes(target, run = defaultRun, { everywhere = false } = {}) {
    const [socket, pane] = target.split(',');
    const scope = everywhere ? ['-a'] : ['-t', pane];
    return run('tmux', ['-S', socket, 'list-panes', ...scope, '-F', '#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{window_name}\t#{pane_title}']).split('\n').filter(Boolean).map((line) => {
      const [id, pid, tty, window, title] = line.split('\t');
      // titles: the window's name, then the pane's own title, so a person can name a pane by either. A pane
      // whose program set no title carries the host name, which names nothing.
      return { ref: id, target: `${socket},${id},${pid}`, command: foregroundCommand(tty, run), self: id === pane, titles: [window, title].filter((t) => t && t !== os.hostname()) };
    });
  },
  // A new pane beside the caller runs the command directly, so the pane closes when the seat ends.
  // A new pane inherits no environment, so the team folder and the caller's PATH are passed in.
  open(target, { cwd, dir, command, path: searchPath }, run = defaultRun) {
    const [socket, pane] = target.split(',');
    try {
      const ref = run('tmux', ['-S', socket, 'split-window', '-d', '-t', pane, '-c', cwd, '-e', `CMACK_DIR=${dir}`, ...(searchPath ? ['-e', `PATH=${searchPath}`] : []), '-P', '-F', '#{pane_id}', command.map(shellQuote).join(' ')]).trim();
      return { ok: true, ref };
    } catch (error) {
      return failure(error);
    }
  },
  nudge(target, line, run = defaultRun, sleep = sleepMs) {
    const alive = tmux.alive(target, run);
    if (!alive.ok) return alive;
    const [socket, pane] = target.split(',');
    try {
      run('tmux', ['-S', socket, 'send-keys', '-t', pane, '-l', line]);
      sleep(ENTER_DELAY_MS);
      run('tmux', ['-S', socket, 'send-keys', '-t', pane, 'Enter']);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
};

const cmux = {
  // cmux lists surfaces by short ref, never by the id a pane knows itself by, and
  // identify answers for any id, so there is no quiet way to ask whether a surface
  // exists. A send to a gone surface fails with not_found and is reported then.
  alive() {
    return { ok: true };
  },
  // Every terminal surface in the caller's workspace. cmux names no program per surface, but its
  // tree names each surface's tty, and ps names the program in that tty's foreground.
  // Your workspace by default; every workspace when a surface is named, so a team can span workspaces.
  panes(target, run = defaultRun, { everywhere = false } = {}) {
    const scope = everywhere ? ['--all'] : ['--workspace', JSON.parse(run('cmux', ['identify'])).caller.workspace_ref];
    const found = [];
    let workspace = '';
    for (const line of run('cmux', ['tree', ...scope, '--id-format', 'both']).split('\n')) {
      // A workspace line names the tab; its surfaces follow until the next one.
      // The selected workspace's line goes on after its name ([selected] ◀ active), so the name runs to the last quote.
      const w = /workspace workspace:\d+ \S+ "(.*)"/.exec(line);
      if (w) { workspace = w[1]; continue; }
      const m = /surface (surface:\d+) (\S+) \[terminal\](?: "(.*)")?/.exec(line);
      if (!m) continue;
      const tty = /tty=(\S+)$/.exec(line.trimEnd())?.[1];
      found.push({ ref: m[1], target: m[2], command: tty ? foregroundCommand(tty, run) : null, self: m[2].toUpperCase() === target.toUpperCase(), titles: [workspace, m[3]].filter(Boolean) });
    }
    return found;
  },
  // A new split beside the caller opens a shell; cmux cannot open a split with a command, so the
  // start is typed into that shell. A split in a workspace nobody is looking at gets no shell until
  // something is typed into it, and what is typed waits for the shell, so there is nothing to wait for.
  open(target, { cwd, dir, command }, run = defaultRun, sleep = sleepMs) {
    let ref;
    try {
      ref = /^OK (surface:\d+)/.exec(run('cmux', ['new-split', 'right', '--surface', target, '--focus', 'false']))?.[1];
    } catch (error) {
      return failure(error);
    }
    if (!ref) return { ok: false, reason: 'new-split named no surface' };
    try {
      run('cmux', ['send', '--surface', ref, `cd ${shellQuote(cwd)} && CMACK_DIR=${shellQuote(dir)} ${command.map(shellQuote).join(' ')}`]);
      sleep(ENTER_DELAY_MS);
      run('cmux', ['send-key', '--surface', ref, 'enter']);
      return { ok: true, ref };
    } catch (error) {
      return failure(error);
    }
  },
  nudge(target, line, run = defaultRun, sleep = sleepMs) {
    try {
      run('cmux', ['send', '--surface', target, line]);
      sleep(ENTER_DELAY_MS);
      run('cmux', ['send-key', '--surface', target, 'enter']);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
};

// The program in a tty's foreground: ps marks the foreground group with a plus; a known agent CLI
// wins over whatever wraps it; a shell alone, or a tty with nothing on it, is null.
function foregroundCommand(tty, run) {
  let ps;
  try { ps = run('ps', ['-t', tty, '-o', 'stat=', '-o', 'comm=']); } catch { return null; }
  const fg = ps.split('\n').map((l) => l.trim().split(/\s+/)).filter(([stat]) => stat?.includes('+'))
    .map(([, ...comm]) => path.basename(comm.join(' ').replace(/^-/, ''))).filter((c) => c && !SHELLS.has(c) && c !== 'login');
  return fg.find((c) => AGENTS.has(c)) ?? fg[0] ?? null;
}

export const adapters = { tmux, cmux };
