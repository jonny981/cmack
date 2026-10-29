import { withLock, sleepMs } from './lock.mjs';
import { appendMessage, CHANNEL_NAME, DEFAULT_CHANNEL } from './channel.mjs';
import { readWake, NAME } from './wake.mjs';
import { adapters, nudgeLine, defaultRun } from './mux.mjs';

// Every teammate named as @name, or as "name:" at the start, in order of first appearance.
// An at-sign inside a word (an email address) and an unknown name (a CSS at-rule) are not mentions.
export function mentions(text, names) {
  const known = new Set(names);
  const found = [];
  const add = (name) => { if (known.has(name) && !found.includes(name)) found.push(name); };
  const lead = /^([A-Za-z0-9._-]+):/.exec(text);
  if (lead) add(lead[1]);
  for (const m of text.matchAll(/(?:^|[^\w@])@([A-Za-z0-9._-]+)/g)) add(m[1].replace(/[._-]+$/, ''));
  return found;
}

// Post first, under the lock; then nudge. A nudge that fails is reported, never fatal.
export function send({ dir, from, channel = DEFAULT_CHANNEL, text, now = new Date(), run = defaultRun, sleep = sleepMs }) {
  if (!CHANNEL_NAME.test(channel)) throw new Error(`cmack: a channel name is lowercase letters, digits, dots, dashes or underscores, not "${channel}"`);
  if (!NAME.test(from)) throw new Error(`cmack: a sender name is letters, digits, dots, dashes or underscores, not "${from}"`);
  const { raw } = withLock(dir, () => appendMessage(dir, channel, { at: now, from, text }));
  const wake = readWake(dir);
  const line = nudgeLine(from, channel);
  const nudged = mentions(text, wake.map((e) => e.name))
    .filter((name) => name !== from)
    .map((name) => {
      const entry = wake.find((e) => e.name === name);
      const adapter = adapters[entry.mux];
      const result = adapter ? adapter.nudge(entry.target, line, run, sleep) : { ok: false, reason: `unknown multiplexer ${entry.mux}` };
      return { name, ...result };
    });
  return { raw, nudged };
}
