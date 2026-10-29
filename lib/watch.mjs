import fs from 'node:fs';
import path from 'node:path';
import { parseChannel } from './channel.mjs';
import { sleepMs } from './lock.mjs';

const RESYNC = 10;

// New messages since the last pass, by content: the sender rewrites a channel file on every
// post, so a line count or a file handle goes blind after a prune.
export function diffChannels(dir, state, { skip } = {}) {
  const next = {};
  const lines = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const name = file.slice(0, -3);
    const messages = parseChannel(fs.readFileSync(path.join(dir, file), 'utf8')).filter((b) => b.kind === 'message');
    if (messages.length === 0) continue;
    const pos = state[name] === undefined ? -1 : messages.map((m) => m.raw).lastIndexOf(state[name]);
    const fresh = pos === -1 ? messages.slice(-RESYNC) : messages.slice(pos + 1);
    next[name] = messages.at(-1).raw;
    for (const m of fresh) if (m.from !== skip) lines.push(`#${name} ${m.raw}`);
  }
  return { state: next, lines };
}

export function watch({ dir, skip, intervalMs = 2000, out = process.stdout, sleep = sleepMs, once = false }) {
  let { state } = diffChannels(dir, {}, { skip });
  do {
    sleep(intervalMs);
    const result = diffChannels(dir, state, { skip });
    state = result.state;
    for (const line of result.lines) out.write(`${line}\n`);
  } while (!once);
}
