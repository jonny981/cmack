import fs from 'node:fs';
import path from 'node:path';

// A blocking sleep: every command is synchronous and short-lived.
export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// An exclusive-create lock file, so it works on Mac and Linux with no external tool.
export function withLock(dir, fn, { waitMs = 5000, staleMs = 10000, retryMs = 20, sleep = sleepMs } = {}) {
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (isStale(lock, staleMs)) { rm(lock); continue; }
      if (Date.now() >= deadline) throw new Error(`cmack: could not take the lock ${lock} within ${waitMs} ms`);
      sleep(retryMs);
    }
  }
  try { return fn(); } finally { rm(lock); }
}

function isStale(lock, staleMs) {
  try { return Date.now() - fs.statSync(lock).mtimeMs > staleMs; } catch { return false; }
}

function rm(file) {
  try { fs.unlinkSync(file); } catch {}
}
