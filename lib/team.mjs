import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The team folder: CMACK_DIR, else the nearest .cmack/ above cwd, else ~/.cmack.
export function findTeamDir({ cwd = process.cwd(), env = process.env, home = os.homedir() } = {}) {
  if (env.CMACK_DIR) return env.CMACK_DIR;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, '.cmack');
    if (isDir(candidate)) return candidate;
    if (path.dirname(dir) === dir) break;
  }
  return path.join(home, '.cmack');
}

export function ensureTeamDir(dir) {
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
  return dir;
}

export function initTeamDir(cwd) {
  return ensureTeamDir(path.join(cwd, '.cmack'));
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
