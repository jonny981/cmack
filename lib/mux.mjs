import { execFileSync } from 'node:child_process';
import { sleepMs } from './lock.mjs';

// Some agent CLIs swallow an enter that arrives in the same instant as the text.
export const ENTER_DELAY_MS = 200;
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash']);

// The nudge carries no message text, so nothing from a message can reach a shell,
// and it starts with a hash, so a bare shell reads it as a comment.
export const nudgeLine = (from, channel) => `# cmack: ${from} mentioned you in #${channel}`;

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

export const adapters = { tmux, cmux };
