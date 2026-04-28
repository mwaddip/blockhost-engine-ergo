/**
 * Anti-replay nonce tracking for admin commands (timestamp-based)
 *
 * Ergo admin commands use a timestamp nonce in the encrypted JSON payload.
 * The server rejects:
 *   1. Any nonce already in the seen set (exact replay prevention)
 *   2. Any nonce whose timestamp is too old (max_command_age)
 *   3. Any nonce whose timestamp is in the future (clock skew tolerance: 60s)
 *
 * Pruning: nonces older than max_command_age * 2 are removed from the
 * seen set to prevent unbounded growth.
 */

import * as fs from "fs";
import * as path from "path";

const NONCE_FILE = "/var/lib/blockhost/admin-nonces.json";
const NONCE_DIR = path.dirname(NONCE_FILE);

/** Clock skew tolerance: accept timestamps up to 60s in the future */
const FUTURE_TOLERANCE_MS = 60_000;

interface NonceStore {
  /** Set of seen nonces mapped to their timestamps (ms since epoch) */
  seenNonces: Record<string, number>;
}

let store: NonceStore = { seenNonces: {} };
let loaded = false;

/**
 * Ensure the nonce directory exists
 */
function ensureDir(): void {
  if (!fs.existsSync(NONCE_DIR)) {
    fs.mkdirSync(NONCE_DIR, { recursive: true });
  }
}

/**
 * Load nonces from persistent storage on startup
 */
export function loadNonces(): void {
  if (loaded) return;

  try {
    ensureDir();

    if (fs.existsSync(NONCE_FILE)) {
      const data = fs.readFileSync(NONCE_FILE, "utf8");
      const parsed = JSON.parse(data) as Partial<NonceStore>;

      store = {
        seenNonces: parsed.seenNonces ?? {},
      };

      console.log(
        `[ADMIN] Loaded nonce store (tracked: ${Object.keys(store.seenNonces).length})`,
      );
    }
  } catch (err) {
    console.error(`[ADMIN] Error loading nonces: ${err}`);
    store = { seenNonces: {} };
  }

  loaded = true;
}

/**
 * Save nonces to persistent storage
 */
function saveNonces(): void {
  try {
    ensureDir();
    const tmp = NONCE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, NONCE_FILE);
  } catch (err) {
    console.error(`[ADMIN] Error saving nonces: ${err}`);
  }
}

/**
 * Check if a nonce has already been used.
 */
export function isNonceUsed(nonce: string): boolean {
  loadNonces();
  return nonce in store.seenNonces;
}

/**
 * Validate a command timestamp.
 *
 * @param timestamp  Command timestamp in seconds since epoch
 * @param maxAge     Maximum age in seconds (from admin config)
 * @returns Object with valid flag and reason on failure
 */
export function validateTimestamp(
  timestamp: number,
  maxAge: number,
): { valid: boolean; reason?: string } {
  const nowMs = Date.now();
  const commandMs = timestamp * 1000;

  // Reject commands too far in the future
  if (commandMs > nowMs + FUTURE_TOLERANCE_MS) {
    return {
      valid: false,
      reason: `Command timestamp is in the future (${Math.round((commandMs - nowMs) / 1000)}s ahead)`,
    };
  }

  // Reject commands that are too old
  const ageMs = nowMs - commandMs;
  if (ageMs > maxAge * 1000) {
    return {
      valid: false,
      reason: `Command too old (${Math.round(ageMs / 1000)}s, max: ${maxAge}s)`,
    };
  }

  return { valid: true };
}

/** Future tolerance for block-height freshness (facts §5: suggest 2 blocks). */
const FUTURE_TOLERANCE_BLOCKS = 2;

/**
 * Validate a command's block height against the current chain height.
 *
 * @param payloadHeight  Block height carried in the command payload
 * @param currentHeight  Current chain height as observed by the engine
 * @param maxAgeBlocks   Maximum acceptable age in blocks (from admin config)
 * @returns Object with valid flag and reason on failure
 */
export function validateBlockHeight(
  payloadHeight: number,
  currentHeight: number,
  maxAgeBlocks: number,
): { valid: boolean; reason?: string } {
  const ageBlocks = currentHeight - payloadHeight;

  if (ageBlocks < -FUTURE_TOLERANCE_BLOCKS) {
    return {
      valid: false,
      reason: `Command block_height is in the future (${-ageBlocks} blocks ahead)`,
    };
  }

  if (ageBlocks > maxAgeBlocks) {
    return {
      valid: false,
      reason: `Command too old (${ageBlocks} blocks, max: ${maxAgeBlocks})`,
    };
  }

  return { valid: true };
}

/**
 * Mark a nonce as used (call BEFORE executing command).
 */
export function markNonceUsed(nonce: string): void {
  loadNonces();
  store.seenNonces[nonce] = Date.now();
  saveNonces();
}

/**
 * Prune nonces older than maxAge * 2 to prevent unbounded growth.
 * Old nonces don't need tracking because validateTimestamp() will
 * independently reject commands with expired timestamps.
 *
 * @param maxAgeSeconds  Maximum command age from admin config
 */
export function pruneOldNonces(maxAgeSeconds: number): void {
  loadNonces();

  const cutoffMs = Date.now() - maxAgeSeconds * 2 * 1000;
  let pruned = 0;

  for (const [nonce, recordedAt] of Object.entries(store.seenNonces)) {
    if (recordedAt < cutoffMs) {
      delete store.seenNonces[nonce];
      pruned++;
    }
  }

  if (pruned > 0) {
    console.log(`[ADMIN] Pruned ${pruned} old nonces`);
    saveNonces();
  }
}
