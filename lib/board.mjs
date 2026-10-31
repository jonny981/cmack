import fs from 'node:fs';
import { parseChannel, channelPath, archivePath, listChannels } from './channel.mjs';
import { readTeam } from './team.mjs';
import { readWake } from './wake.mjs';
import { readClaims } from './claims.mjs';
import { adapters, defaultRun } from './mux.mjs';

const CUT = 60;

// How long ago, in the unit a person would say. A post is stamped to the minute, so under a
// minute is all the record can say.
export function age(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return '<1m';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// The newest message by each sender across every channel, the archive included, so a seat that
// has been quiet while the channel moved on still has its last post. A message under no date
// header is a hand-written file and has no time; it is skipped.
export function lastPosts(dir) {
  const last = new Map();
  for (const { name } of listChannels(dir)) {
    const content = [archivePath(dir, name), channelPath(dir, name)].map(read).join('\n');
    for (const m of parseChannel(content)) {
      if (m.kind !== 'message' || !m.date) continue;
      const at = new Date(`${m.date}T${m.time}:00Z`);
      const prev = last.get(m.from);
      if (!prev || at >= prev.at) last.set(m.from, { at, channel: name, text: m.text.split('\n')[0] });
    }
  }
  return last;
}

// One screen: every seat with its state, what it holds, and its last post with how long ago.
// A thing held by someone who is not a seat (a person posting with --from) is listed after.
export function board(dir, { now = new Date(), run = defaultRun } = {}) {
  const seats = readTeam(dir);
  const up = new Set(readWake(dir).filter((e) => adapters[e.mux]?.alive(e.target, run).ok).map((e) => e.name));
  const claims = readClaims(dir);
  const last = lastPosts(dir);
  const rows = seats.map((s) => {
    const post = last.get(s.name);
    const points = post ? Array.from(post.text) : [];
    return {
      seat: s.name,
      agent: s.agent || '-',
      state: up.has(s.name) ? 'up' : 'down',
      holds: claims.filter((c) => c.holder === s.name).map((c) => c.thing).join(', ') || '-',
      age: post ? age(now - post.at) : '',
      channel: post ? `#${post.channel}` : '',
      text: points.length > CUT ? `${points.slice(0, CUT - 1).join('')}…` : points.join(''),
    };
  });
  const cols = ['seat', 'agent', 'state', 'holds', 'age', 'channel'];
  const width = Object.fromEntries(cols.map((c) => [c, Math.max(...rows.map((r) => r[c].length), c === 'age' || c === 'channel' ? 0 : c.length)]));
  const line = (r) => [...cols.map((c) => r[c].padEnd(width[c])), r.text].join('  ').trimEnd();
  const lines = [
    [...['seat', 'agent', 'state', 'holds'].map((c) => c.padEnd(width[c])), 'last post'].join('  '),
    ...rows.map((r) => (r.age ? line(r) : `${['seat', 'agent', 'state', 'holds'].map((c) => r[c].padEnd(width[c])).join('  ')}  never posted`)),
  ];
  const names = new Set(seats.map((s) => s.name));
  for (const c of claims) if (!names.has(c.holder)) lines.push(`${c.thing} is held by ${c.holder} since ${c.since}`);
  return lines;
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
