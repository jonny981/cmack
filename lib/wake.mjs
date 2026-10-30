import fs from 'node:fs';
import path from 'node:path';
import { withLock } from './lock.mjs';

// Starts and ends with a letter or digit, so a flag or a trailing dot can never be a name.
export const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

const wakePath = (dir) => path.join(dir, 'wake.txt');

export function readWake(dir) {
  let content = '';
  try { content = fs.readFileSync(wakePath(dir), 'utf8'); } catch { return []; }
  return content.split('\n').filter(Boolean).map((line) => {
    const [name, mux, target] = line.split('\t');
    return { name, mux, target };
  });
}

export function writeWake(dir, entries) {
  const file = wakePath(dir);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, entries.map((e) => `${e.name}\t${e.mux}\t${e.target}\n`).join(''));
  fs.renameSync(temp, file);
}

export function assertName(name) {
  if (name === 'all') throw new Error('cmack: "all" is every seat, not a name');
  if (!NAME.test(name)) throw new Error(`cmack: a name is letters, digits, dots, dashes or underscores, starting and ending with a letter or digit, not "${name}"`);
}

// One pane is one seat: a join replaces the same name and evicts any other name on the same pane.
export function join(dir, { name, mux, target }) {
  assertName(name);
  return withLock(dir, () => {
    const entries = readWake(dir).filter((e) => e.name !== name && !(e.mux === mux && e.target === target));
    entries.push({ name, mux, target });
    writeWake(dir, entries);
    return entries;
  });
}

// With a pane, the seat is removed only while it still points at that pane, so an old copy
// that exits after another pane took the name over signs nobody out.
export function leave(dir, name, pane) {
  return withLock(dir, () => {
    const entries = readWake(dir);
    const kept = entries.filter((e) => !(e.name === name && (!pane || (e.mux === pane.mux && e.target === pane.target))));
    if (kept.length === entries.length) return false;
    writeWake(dir, kept);
    return true;
  });
}

export function whoAmI(dir, { mux, target }) {
  return readWake(dir).find((e) => e.mux === mux && e.target === target)?.name ?? null;
}
