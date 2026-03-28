/**
 * Admin command dispatcher — HMAC-authenticated Ergo transaction protocol.
 *
 * Protocol:
 *   Admin sends a transaction to the admin address (or self-send).
 *   The command payload is HMAC-authenticated and stored as hex in the
 *   R4 register of the first output.
 *
 *   Wire format of R4 data: message_bytes + hmac_suffix(16 bytes)
 *   message = "{nonce} {command text}" (UTF-8)
 *   hmac_suffix = HMAC-SHA256(shared_key, message_bytes)[:16]
 *
 * Detection:
 *   1. Query recent transactions at admin address via explorer
 *   2. For each tx: check outputs for boxes with R4 register data
 *   3. Decode R4 hex, verify HMAC, parse command, check nonce, dispatch
 */

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import type { ErgoProvider } from "../ergo/provider.js";
import type {
  AdminCommand,
  AdminConfig,
  CommandResult,
  CommandDatabase,
  KnockParams,
  KnockActionConfig,
} from "./types.js";
import { loadCommandDatabase } from "./config.js";
import { isNonceUsed, markNonceUsed, pruneOldNonces, loadNonces, validateTimestamp } from "./nonces.js";
import { executeKnock, closeAllKnocks } from "./handlers/knock.js";
import { hexToBytes } from "../crypto.js";

// -- Helpers ------------------------------------------------------------------

/**
 * Constant-time comparison of two Uint8Arrays.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Decode a serialized Ergo register value to raw bytes.
 *
 * Ergo serializes Coll[Byte] in registers as: type_prefix + length_vlq + data.
 * Type prefix for Coll[Byte] is 0e. Length is VLQ-encoded.
 * If the value doesn't start with 0e, try treating it as raw hex data.
 */
function decodeRegisterBytes(hexValue: string): Uint8Array | null {
  try {
    const bytes = hexToBytes(hexValue);

    // Check for Coll[Byte] serialization prefix (0x0e)
    if (bytes.length >= 2 && bytes[0] === 0x0e) {
      // Decode VLQ length
      let length = 0;
      let shift = 0;
      let idx = 1;

      while (idx < bytes.length) {
        const b = bytes[idx]!;
        length |= (b & 0x7f) << shift;
        idx++;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }

      if (idx + length <= bytes.length) {
        return bytes.slice(idx, idx + length);
      }
    }

    // Fallback: return raw bytes (some explorers return decoded values)
    return bytes;
  } catch {
    return null;
  }
}

// -- Action Handlers ----------------------------------------------------------

const ACTION_HANDLERS: Record<
  string,
  (
    params: Record<string, unknown>,
    config: Record<string, unknown>,
    txHash: string,
  ) => Promise<CommandResult>
> = {
  knock: async (params, config, txHash) =>
    executeKnock(
      params as unknown as KnockParams,
      config as unknown as KnockActionConfig,
      txHash,
    ),
};

// -- Payload Parsing ----------------------------------------------------------

/**
 * Parse and verify a payload as an HMAC-authenticated admin command.
 *
 * @param payload   - Raw command bytes (from R4 register data)
 * @param sharedKey - 32-byte shared key (hex, no prefix)
 * @returns Parsed command or null if HMAC verification fails
 */
export function parseCommandPayload(
  payload: Uint8Array,
  sharedKey: string,
): AdminCommand | null {
  // Minimum: 1 (nonce) + 1 (space) + 1 (command) + 16 (hmac) = 19 bytes
  if (payload.length < 19) return null;

  const message = payload.slice(0, payload.length - 16);
  const hmacSuffix = payload.slice(payload.length - 16);

  // Verify HMAC-SHA256 truncated to 16 bytes (128-bit)
  const keyBytes = hexToBytes(sharedKey);
  const expectedHmac = hmac(sha256, keyBytes, message).slice(0, 16);

  if (!timingSafeEqual(hmacSuffix, expectedHmac)) {
    return null; // HMAC mismatch — not an admin command
  }

  // Parse message: "{nonce} {command}"
  const messageStr = new TextDecoder().decode(message);
  const spaceIdx = messageStr.indexOf(" ");
  if (spaceIdx < 1) return null;

  const nonce = messageStr.slice(0, spaceIdx);
  const command = messageStr.slice(spaceIdx + 1).trim();

  if (!nonce || !command) return null;

  return { command, nonce };
}

// -- Validation & Dispatch ----------------------------------------------------

/**
 * Validate command nonce (anti-replay) and timestamp
 */
export function validateCommand(
  cmd: AdminCommand,
  maxCommandAge: number,
): { valid: boolean; reason?: string } {
  if (isNonceUsed(cmd.nonce)) {
    return { valid: false, reason: `Nonce already used (replay attack prevented)` };
  }

  // If nonce is numeric, also validate as a timestamp
  const nonceNum = parseInt(cmd.nonce, 10);
  if (!isNaN(nonceNum) && nonceNum > 1_000_000_000) {
    // Looks like a Unix timestamp — validate freshness
    const tsResult = validateTimestamp(nonceNum, maxCommandAge);
    if (!tsResult.valid) {
      return tsResult;
    }
  }

  return { valid: true };
}

/**
 * Dispatch a validated command to its handler
 */
export async function dispatchCommand(
  cmd: AdminCommand,
  txHash: string,
  commandDb: CommandDatabase,
): Promise<CommandResult> {
  const cmdDef = commandDb.commands[cmd.command];
  if (!cmdDef) {
    return { success: false, message: `Unknown command: ${cmd.command}` };
  }

  const handler = ACTION_HANDLERS[cmdDef.action];
  if (!handler) {
    return { success: false, message: `Unknown action type: ${cmdDef.action}` };
  }

  console.log(`[ADMIN] Dispatching action '${cmdDef.action}' for command '${cmd.command}'`);
  return handler(cmdDef.params, cmdDef.config ?? cmdDef.params, txHash);
}

// -- Transaction types --------------------------------------------------------

/** Minimal type for explorer transaction response. */
interface ExplorerTx {
  id: string;
  outputs?: Array<{
    boxId: string;
    address: string;
    additionalRegisters?: Record<string, string>;
  }>;
}

// -- Transaction Processing ---------------------------------------------------

/**
 * Process admin commands from Ergo transactions.
 *
 * Queries recent transactions at the admin address via the explorer and
 * checks each transaction's outputs for boxes with R4 register data.
 *
 * The R4 data is interpreted as an HMAC-authenticated command payload.
 * We scan up to 10 recent transactions on each call. Nonce tracking
 * prevents any command from being executed twice.
 */
export async function processAdminCommands(
  provider: ErgoProvider,
  adminConfig: AdminConfig,
): Promise<void> {
  const commandDb = loadCommandDatabase();
  if (!commandDb) return;

  const maxAge = adminConfig.max_command_age ?? 300;
  pruneOldNonces(maxAge);

  let recentTxs: ExplorerTx[];
  try {
    const raw = await provider.getTransactions(adminConfig.wallet_address, 0, 10);
    recentTxs = raw as ExplorerTx[];
  } catch (err) {
    console.error(`[ADMIN] Error querying admin address transactions: ${err}`);
    return;
  }

  for (const tx of recentTxs) {
    try {
      await processTransaction(tx, adminConfig, commandDb);
    } catch (err) {
      console.error(`[ADMIN] Error processing tx ${tx.id}: ${err}`);
    }
  }
}

/**
 * Process a single transaction for potential admin commands in R4 registers.
 *
 * Checks all outputs (not just the first) for R4 data that can be
 * decoded as an HMAC-authenticated command.
 */
async function processTransaction(
  tx: ExplorerTx,
  adminConfig: AdminConfig,
  commandDb: CommandDatabase,
): Promise<void> {
  const outputs = tx.outputs;
  if (!outputs || outputs.length === 0) return;

  for (const output of outputs) {
    const r4 = output.additionalRegisters?.["R4"];
    if (!r4) continue;

    // Decode R4 register value to raw bytes
    const payload = decodeRegisterBytes(r4);
    if (!payload || payload.length < 19) continue;

    // Attempt HMAC verification
    const cmd = parseCommandPayload(payload, adminConfig.shared_key);
    if (!cmd) continue; // HMAC failed — not an admin command (or wrong key)

    console.log(`[ADMIN] Verified admin command from tx: ${tx.id}`);

    const maxAge = adminConfig.max_command_age ?? 300;
    const validation = validateCommand(cmd, maxAge);
    if (!validation.valid) {
      console.warn(`[ADMIN] Command validation failed: ${validation.reason} (tx: ${tx.id})`);
      continue;
    }

    markNonceUsed(cmd.nonce);
    console.log(`[ADMIN] Executing command '${cmd.command}' from tx: ${tx.id}`);

    const result = await dispatchCommand(cmd, tx.id, commandDb);
    if (result.success) {
      console.log(`[ADMIN] Command succeeded: ${result.message}`);
    } else {
      console.error(`[ADMIN] Command failed: ${result.message}`);
    }
  }
}

// -- Lifecycle ----------------------------------------------------------------

/**
 * Initialize admin command system
 */
export function initAdminCommands(): void {
  loadNonces();
  console.log(`[ADMIN] Admin command system initialized (R4 register scanning)`);
}

/**
 * Cleanup on shutdown
 */
export async function shutdownAdminCommands(): Promise<void> {
  await closeAllKnocks();
  console.log(`[ADMIN] Admin command system shutdown`);
}

// Re-export only what external consumers need
export { loadAdminConfig } from "./config.js";
export type { AdminConfig } from "./types.js";
