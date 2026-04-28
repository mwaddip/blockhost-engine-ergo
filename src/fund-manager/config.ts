/**
 * Fund manager configuration loading with defaults (Ergo)
 *
 * All monetary thresholds use base units:
 *   - ERG thresholds: nanoERG (1 ERG = 1,000,000,000 nanoERG)
 *   - Token thresholds: token base units
 */

import * as fs from "fs";
import * as yaml from "js-yaml";
import type { FundManagerConfig, RevenueShareConfig } from "./types.js";
import { BLOCKHOST_CONFIG_PATH, CONFIG_DIR } from "../paths.js";

const REVENUE_SHARE_PATH = `${CONFIG_DIR}/revenue-share.json`;

const DEFAULTS: FundManagerConfig = {
  fund_cycle_interval_hours: 24,
  gas_check_interval_minutes: 30,
  min_withdrawal_nanoerg: 50_000_000_000n,          // 50 ERG
  gas_low_threshold_nanoerg: 5_000_000_000n,        // 5 ERG — triggers warning
  gas_swap_amount_nanoerg: 20_000_000_000n,         // 20 ERG — target swap amount
  server_stablecoin_buffer_nanoerg: 50_000_000_000n, // stablecoin buffer in token base units
  hot_wallet_gas_nanoerg: 1_000_000_000n,           // 1 ERG — target hot wallet ERG balance
};

// mtime-based YAML cache. Re-parses only when blockhost.yaml changes on disk.
// shouldRunFundCycle / shouldRunGasCheck call loadFundManagerConfig() every
// poll tick, so the cache prevents re-parsing the same file every 5 seconds.
let fundConfigCache: { mtimeMs: number; config: FundManagerConfig } | null = null;

/**
 * Load fund manager configuration from blockhost.yaml
 */
export function loadFundManagerConfig(): FundManagerConfig {
  try {
    if (!fs.existsSync(BLOCKHOST_CONFIG_PATH)) {
      return { ...DEFAULTS };
    }

    const stat = fs.statSync(BLOCKHOST_CONFIG_PATH);
    if (fundConfigCache && fundConfigCache.mtimeMs === stat.mtimeMs) {
      return fundConfigCache.config;
    }

    const config = yaml.load(
      fs.readFileSync(BLOCKHOST_CONFIG_PATH, "utf8"),
    ) as Record<string, unknown>;

    const fm = config.fund_manager as Record<string, unknown> | undefined;
    if (!fm) {
      const result = { ...DEFAULTS };
      fundConfigCache = { mtimeMs: stat.mtimeMs, config: result };
      return result;
    }

    const safeBigInt = (v: unknown, fallback: bigint): bigint => {
      if (v === undefined || v === null) return fallback;
      return BigInt(Math.trunc(Number(v)));
    };

    const parsed: FundManagerConfig = {
      fund_cycle_interval_hours:
        (fm.fund_cycle_interval_hours as number) || DEFAULTS.fund_cycle_interval_hours,
      gas_check_interval_minutes:
        (fm.gas_check_interval_minutes as number) || DEFAULTS.gas_check_interval_minutes,
      min_withdrawal_nanoerg: safeBigInt(
        fm.min_withdrawal_nanoerg,
        DEFAULTS.min_withdrawal_nanoerg,
      ),
      gas_low_threshold_nanoerg: safeBigInt(
        fm.gas_low_threshold_nanoerg,
        DEFAULTS.gas_low_threshold_nanoerg,
      ),
      gas_swap_amount_nanoerg: safeBigInt(
        fm.gas_swap_amount_nanoerg,
        DEFAULTS.gas_swap_amount_nanoerg,
      ),
      server_stablecoin_buffer_nanoerg: safeBigInt(
        fm.server_stablecoin_buffer_nanoerg,
        DEFAULTS.server_stablecoin_buffer_nanoerg,
      ),
      hot_wallet_gas_nanoerg: safeBigInt(
        fm.hot_wallet_gas_nanoerg,
        DEFAULTS.hot_wallet_gas_nanoerg,
      ),
    };

    fundConfigCache = { mtimeMs: stat.mtimeMs, config: parsed };
    return parsed;
  } catch (err) {
    console.error(`[FUND] Error loading config: ${err}`);
    return { ...DEFAULTS };
  }
}

/**
 * Load revenue share configuration from /etc/blockhost/revenue-share.json
 */
export function loadRevenueShareConfig(): RevenueShareConfig {
  const disabled: RevenueShareConfig = {
    enabled: false,
    total_bps: 0,
    recipients: [],
  };

  try {
    if (!fs.existsSync(REVENUE_SHARE_PATH)) {
      return disabled;
    }

    const data = fs.readFileSync(REVENUE_SHARE_PATH, "utf8");
    const raw = JSON.parse(data) as Record<string, unknown>;

    if (!raw.enabled) {
      return disabled;
    }

    const recipients = raw.recipients as Array<Record<string, unknown>> | undefined;
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return disabled;
    }

    // Support both new bps format and legacy percent format
    const totalBps =
      (raw.total_bps as number | undefined) ??
      (raw.total_percent ? Math.round((raw.total_percent as number) * 100) : 0);

    if (totalBps <= 0) {
      return disabled;
    }

    const parsed = recipients.map((r) => ({
      role: r.role as string,
      bps:
        (r.bps as number | undefined) ??
        (r.percent ? Math.round((r.percent as number) * 100) : 0),
      percent: r.percent as number | undefined,
    }));

    // Validate recipient bps sum matches total_bps
    const bpsSum = parsed.reduce((sum, r) => sum + r.bps, 0);
    if (bpsSum !== totalBps) {
      console.error(
        `[FUND] Revenue share bps mismatch: recipients sum to ${bpsSum} but total_bps is ${totalBps}`,
      );
      return disabled;
    }

    return {
      enabled: true,
      total_bps: totalBps,
      total_percent: raw.total_percent as number | undefined,
      recipients: parsed,
    };
  } catch (err) {
    console.error(`[FUND] Error loading revenue share config: ${err}`);
    return disabled;
  }
}
