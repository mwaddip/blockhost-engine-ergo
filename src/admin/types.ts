/**
 * Admin command types for HMAC-authenticated metadata protocol
 */

import type { ChildProcess } from "child_process";

/**
 * Admin command payload (parsed from transaction metadata)
 *
 * Wire format (HMAC-SHA256(sharedKey)[:16] suffix on both):
 *   v0 (legacy): "{nonce} {command}"
 *   v1 (block-height aware): "v1 {nonce} {block_height} {command}"
 *
 * v1 carries the chain height the sender saw when issuing the command, so
 * the engine can apply block-based freshness per facts §5.
 */
export interface AdminCommand {
  command: string;           // Command text (maps to action in command database)
  nonce: string;             // Anti-replay nonce
  block_height?: number;     // Preferred freshness anchor (v1 wire format only)
}

/**
 * Parameters for knock command action
 */
export interface KnockParams {
  ports?: number[];          // Ports to open (validated against allowed_ports)
  duration?: number;         // How long to keep ports open (seconds)
  source?: string;           // IPv6 address — if set, open ports only for this source
}

/**
 * Admin configuration from blockhost.yaml
 */
export interface AdminConfig {
  wallet_address: string;           // Admin wallet (Base58 Ergo address)
  shared_key: string;               // HMAC shared key (32-byte hex, no prefix)
  credential_nft_id?: string;       // Admin NFT token ID (optional)
  max_command_age?: number;         // Legacy: seconds. Falls back when v1 wire format absent.
  max_command_age_blocks?: number;  // Preferred per facts §5 (Ergo default ~3 blocks ≈ 5 min). Wins over max_command_age when v1 wire format carries block_height.
}

/**
 * Command definition in admin-commands.json
 */
export interface CommandDefinition {
  action: string;                    // Action type: 'knock', etc.
  description?: string;              // Admin reference only
  params: Record<string, unknown>;   // Per-command parameters (ports, duration, source)
  config?: Record<string, unknown>;  // Action constraints (allowed_ports, default_duration); defaults to params
}

/**
 * Command database structure (admin-commands.json)
 */
export interface CommandDatabase {
  commands: Record<string, CommandDefinition>;
}

/**
 * Knock action configuration (from command definition params)
 */
export interface KnockActionConfig {
  allowed_ports?: number[];         // Ports that can be opened (default: [22])
  default_duration?: number;        // Default duration if not specified (default: 300)
}

/**
 * Result of command execution
 */
export interface CommandResult {
  success: boolean;
  message: string;
  data?: unknown;
}

/**
 * Active knock state (tracked in memory)
 */
export interface ActiveKnock {
  txHash: string;
  ports: number[];
  source?: string;              // IPv6 source filter (if set, rules are per-source)
  startTime: number;
  duration: number;
  timeoutId: NodeJS.Timeout;
  loginSource?: string;         // IP narrowed to after login detection (phase 2)
  heartbeatInterval?: NodeJS.Timeout;  // Heartbeat file poller
  tailProcess?: ChildProcess;   // auth.log tail handle
}
