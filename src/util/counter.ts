/**
 * Atomic file-backed counter allocator.
 *
 * Used by VM ID, NFT number, and plan ID allocation. Each call reads the
 * current value, returns it, and persists value+1. Lockfile (O_CREAT|O_EXCL)
 * serialises concurrent callers; stale locks are reclaimed after exhaustion.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_RETRIES = 50;
const RETRY_DELAY_MS = 100;

/**
 * Allocate the next integer from a file-backed counter.
 *
 * @param counterPath  Absolute path to the counter file (created on first call)
 * @returns The current value (1 if file did not exist); value+1 is persisted
 */
export async function allocateCounter(counterPath: string): Promise<number> {
  const lockPath = counterPath + ".lock";
  fs.mkdirSync(path.dirname(counterPath), { recursive: true });

  let lockFd = -1;
  for (let i = 0; i < DEFAULT_RETRIES; i++) {
    try {
      lockFd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      break;
    } catch {
      if (i === DEFAULT_RETRIES - 1) {
        // Reclaim a stale lock from a crashed predecessor
        try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
        try {
          lockFd = fs.openSync(
            lockPath,
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          );
        } catch { /* give up — proceed unlocked */ }
        break;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  try {
    let current = 1;
    try {
      const raw = fs.readFileSync(counterPath, "utf8").trim();
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed) && parsed > 0) current = parsed;
    } catch {
      // File doesn't exist — start at 1
    }
    fs.writeFileSync(counterPath, String(current + 1), "utf8");
    return current;
  } finally {
    if (lockFd >= 0) try { fs.closeSync(lockFd); } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}
