import fs from 'node:fs';
import path from 'node:path';
import { withLock } from './lock.mjs';

// The team folder: CMACK_DIR, else the nearest .cmack/ above cwd; null when nothing above has one.
export function findTeamDir({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.CMACK_DIR) return env.CMACK_DIR;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, '.cmack');
    if (isDir(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

export function ensureTeamDir(dir) {
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
  return dir;
}

// team.txt holds every seat started here (name, agent, brief), so a seat can start again
// after its pane is gone. A brief is kept on one line.
const teamPath = (dir) => path.join(dir, 'team.txt');

export function readTeam(dir) {
  let content = '';
  try { content = fs.readFileSync(teamPath(dir), 'utf8'); } catch { return []; }
  return content.split('\n').filter(Boolean).map((line) => {
    const [name, agent = '', brief = ''] = line.split('\t');
    return { name, agent, brief };
  });
}

// An empty agent or brief keeps what the seat already had, so a join from inside a started
// seat loses nothing; a new brief replaces the old one. A seat keeps its line's place.
export function recordSeat(dir, { name, agent = '', brief = '' }) {
  return withLock(dir, () => {
    const seats = readTeam(dir);
    const old = seats.find((s) => s.name === name) ?? { agent: '', brief: '' };
    const seat = { name, agent: agent || old.agent, brief: brief.replace(/\s+/g, ' ').trim() || old.brief };
    const next = seats.some((s) => s.name === name) ? seats.map((s) => (s.name === name ? seat : s)) : [...seats, seat];
    const file = teamPath(dir);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, next.map((s) => `${s.name}\t${s.agent}\t${s.brief}\n`).join(''));
    fs.renameSync(temp, file);
    return seat;
  });
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
