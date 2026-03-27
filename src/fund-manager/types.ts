/**
 * Type definitions for fund-manager and bw CLI.
 */

export interface FundManagerState {
  last_fund_cycle: number;        // ms timestamp
  last_gas_check: number;         // ms timestamp
  hot_wallet_generated: boolean;
}

export interface FundManagerConfig {
  fund_cycle_interval_hours: number;
  gas_check_interval_minutes: number;
  min_withdrawal_nanoerg: bigint;
  gas_low_threshold_nanoerg: bigint;
  gas_swap_amount_nanoerg: bigint;
  server_stablecoin_buffer_nanoerg: bigint;
  hot_wallet_gas_nanoerg: bigint;
}

export interface RevenueShareRecipient {
  role: string;
  /** Recipient's share in basis points (100 = 1%). Integer only. */
  bps: number;
  /** @deprecated Use bps instead. Kept for config migration. */
  percent?: number;
}

export interface RevenueShareConfig {
  enabled: boolean;
  /** Total revenue share in basis points (100 = 1%). Integer only. */
  total_bps: number;
  /** @deprecated Use total_bps instead. Kept for config migration. */
  total_percent?: number;
  recipients: RevenueShareRecipient[];
}

export interface AddressbookEntry {
  /** Base58 Ergo address */
  address: string;
  /** Path to key file (private key or mnemonic) */
  keyfile?: string;
}

export type Addressbook = Record<string, AddressbookEntry>;
