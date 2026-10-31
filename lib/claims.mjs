import fs from 'node:fs';
import path from 'node:path';
import { withLock } from './lock.mjs';

// claims.txt holds every thing a seat has claimed and not yet released: thing, holder, since.
// A claim is a team fact, not a git lock: the skill says claim the shared branch before you
// land on it, and the record says who holds what. Cmack never runs git.
const claimsPath = (dir) => path.join(dir, 'claims.txt');

export function readClaims(dir) {
  let content = '';
  try { content = fs.readFileSync(claimsPath(dir), 'utf8'); } catch { return []; }
  return content.split('\n').filter(Boolean).map((line) => {
    const [thing, holder, since] = line.split('\t');
    return { thing, holder, since };
  });
}

function writeClaims(dir, claims) {
  const file = claimsPath(dir);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, claims.map((c) => `${c.thing}\t${c.holder}\t${c.since}\n`).join(''));
  fs.renameSync(temp, file);
}

// A thing is one line of text; it is refused while another seat holds it.
export function claim(dir, { thing, holder, now = new Date() }) {
  const name = String(thing ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('cmack: claim needs a thing: cmack claim <thing>');
  return withLock(dir, () => {
    const claims = readClaims(dir);
    const held = claims.find((c) => c.thing === name);
    if (held) return { ok: held.holder === holder, holder: held.holder, since: held.since };
    const since = `${now.toISOString().slice(0, 16)}Z`;
    writeClaims(dir, [...claims, { thing: name, holder, since }]);
    return { ok: true, holder, since };
  });
}

// Any seat may release a thing; the channel post says who did. Returns who held it, or null.
export function release(dir, thing) {
  return withLock(dir, () => {
    const claims = readClaims(dir);
    const held = claims.find((c) => c.thing === thing);
    if (!held) return null;
    writeClaims(dir, claims.filter((c) => c !== held));
    return held.holder;
  });
}

// A seat that goes down holds nothing; returns the things it held, in claim order.
export function releaseAll(dir, holder) {
  return withLock(dir, () => {
    const claims = readClaims(dir);
    const gone = claims.filter((c) => c.holder === holder).map((c) => c.thing);
    if (gone.length) writeClaims(dir, claims.filter((c) => c.holder !== holder));
    return gone;
  });
}
