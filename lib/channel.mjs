import fs from 'node:fs';
import path from 'node:path';

export const CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
export const KEEP = 150;
export const DEFAULT_CHANNEL = 'general';

export const channelPath = (dir, name) => path.join(dir, `${name}.md`);
export const archivePath = (dir, name) => path.join(dir, 'archive', `${name}.md`);

const START = /^(\d{2}:\d{2})Z (\S+) > (.*)$/;
const DATE = /^## (\d{4}-\d{2}-\d{2})$/;
const isoDate = (at) => at.toISOString().slice(0, 10);
const isoTime = (at) => at.toISOString().slice(11, 16);

// One message: the first line carries time and sender; further lines are indented by two spaces.
export function formatMessage({ at, from, text }) {
  const lines = String(text).split('\n').map((line) => line.trimEnd()).filter(Boolean);
  if (lines.length === 0) throw new Error('cmack: the message is empty');
  const [first, ...rest] = lines;
  return [`${isoTime(at)}Z ${from} > ${first}`, ...rest.map((line) => `  ${line}`)];
}

export function parseChannel(content) {
  const blocks = [];
  let date = null;
  let current = null;
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    let m;
    if ((m = DATE.exec(line))) {
      date = m[1];
      blocks.push({ kind: 'date', date });
      current = null;
    } else if ((m = START.exec(line))) {
      current = { kind: 'message', date, time: m[1], from: m[2], lines: [line] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return blocks.map((b) => (b.kind === 'message' ? finish(b) : b));
}

function finish({ date, time, from, lines }) {
  const text = [START.exec(lines[0])[3], ...lines.slice(1).map((line) => line.replace(/^  /, ''))].join('\n');
  return { kind: 'message', date, time, from, text, raw: lines.join('\n') };
}

// Date headers are derived from the messages, one whenever the date changes.
export function serialize(blocks) {
  const out = [];
  let date = null;
  for (const b of blocks) {
    if (b.kind !== 'message') continue;
    if (b.date && b.date !== date) { date = b.date; out.push(`## ${date}`); }
    out.push(b.raw);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

// The caller holds the lock.
export function appendMessage(dir, name, { at, from, text }) {
  const file = channelPath(dir, name);
  const lines = formatMessage({ at, from, text });
  const raw = lines.join('\n');
  const all = [...parseChannel(read(file)).filter((b) => b.kind === 'message'), { kind: 'message', date: isoDate(at), time: isoTime(at), from, raw }];
  const old = all.slice(0, Math.max(0, all.length - KEEP));
  if (old.length) {
    const archive = archivePath(dir, name);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.appendFileSync(archive, serialize(old));
  }
  writeAtomic(file, serialize(all.slice(-KEEP)));
  return { raw };
}

export function readChannel(dir, name, { count = 40 } = {}) {
  return serialize(parseChannel(read(channelPath(dir, name))).filter((b) => b.kind === 'message').slice(-count));
}

export function listChannels(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => {
      const last = parseChannel(read(path.join(dir, e.name))).filter((b) => b.kind === 'message').at(-1);
      return { name: e.name.slice(0, -3), lastAt: last ? `${last.date} ${last.time}Z` : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function writeAtomic(file, content) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}
