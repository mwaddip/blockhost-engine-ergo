/**
 * Fund Manager Module (Ergo)
 *
 * Periodic tasks integrated into the monitor polling loop:
 *   - Fund cycle (every 24h): collect earned subscription payments via
 *     executeWithdraw(), then distribute collected ERG to hot/server/
 *     dev/broker/admin.
 *   - Gas check (every 30min): monitor server wallet ERG balance and
 *     top up hot wallet if needed.
 *
 * No collateral check — Ergo has no Plutus-style collateral requirement.
 */

import { spawnSync } from "child_process";
import { getCommand } from "../provisioner.js";
import { loadFundManagerConfig, loadRevenueShareConfig } from "./config.js";
import { loadState, updateState } from "./state.js";
import { loadAddressbook, ensureHotWallet } from "./addressbook.js";
import { runWithdrawal } from "./withdrawal.js";
import {
  topUpHotWalletGas,
  topUpServerStablecoinBuffer,
  distributeRevenueShares,
  sendRemainderToAdmin,
} from "./distribution.js";
import { executeBalance } from "../bw/commands/balance.js";
import { formatErg } from "../bw/cli-utils.js";
import type { ErgoProvider } from "../ergo/provider.js";
import type { FundManagerState } from "./types.js";

import * as fs from "fs";
import { TESTING_MODE_FILE } from "../paths.js";

let fundCycleInProgress = false;

const testingMode = fs.existsSync(TESTING_MODE_FILE);

// -- Scheduling helpers -------------------------------------------------------

/**
 * Check if the fund cycle is due to run.
 *
 * Block-based when config has `fund_cycle_interval_blocks` and state has a
 * recorded `last_fund_cycle_block`; falls back to wall-clock otherwise.
 * Block-based wins when both keys are present (per facts §6).
 *
 * Testing mode: runs every 10 minutes wall-clock (config ignored).
 */
export async function shouldRunFundCycle(provider: ErgoProvider): Promise<boolean> {
  const state = loadState();
  if (testingMode) {
    return Date.now() - state.last_fund_cycle >= 600_000;
  }
  const config = loadFundManagerConfig();
  if (config.fund_cycle_interval_blocks && state.last_fund_cycle_block !== undefined) {
    try {
      const currentBlock = await provider.getHeight();
      return currentBlock - state.last_fund_cycle_block >= config.fund_cycle_interval_blocks;
    } catch (err) {
      console.error(`[FUND] getHeight failed in shouldRunFundCycle: ${err}`);
      return false;
    }
  }
  const intervalMs = config.fund_cycle_interval_hours * 3_600_000;
  return Date.now() - state.last_fund_cycle >= intervalMs;
}

/**
 * Check if the gas check is due.
 *
 * Block-based when config has `gas_check_interval_blocks` and state has a
 * recorded `last_gas_check_block`; falls back to wall-clock otherwise.
 *
 * Testing mode: every 1 minute wall-clock (config ignored).
 */
export async function shouldRunGasCheck(provider: ErgoProvider): Promise<boolean> {
  const state = loadState();
  if (testingMode) {
    return Date.now() - state.last_gas_check >= 60_000;
  }
  const config = loadFundManagerConfig();
  if (config.gas_check_interval_blocks && state.last_gas_check_block !== undefined) {
    try {
      const currentBlock = await provider.getHeight();
      return currentBlock - state.last_gas_check_block >= config.gas_check_interval_blocks;
    } catch (err) {
      console.error(`[FUND] getHeight failed in shouldRunGasCheck: ${err}`);
      return false;
    }
  }
  const intervalMs = config.gas_check_interval_minutes * 60_000;
  return Date.now() - state.last_gas_check >= intervalMs;
}

/**
 * Return true if a provisioner VM-create command is currently running.
 * We skip fund cycles during provisioning to avoid ERG balance race conditions.
 */
export function isProvisioningInProgress(): boolean {
  try {
    const createCmd = getCommand("create");
    const result = spawnSync("pgrep", ["-f", createCmd], { timeout: 5000 });
    return result.status === 0;
  } catch {
    // getCommand() may throw if manifest not loaded — treat as not in progress
    return false;
  }
}

// -- Gas check ----------------------------------------------------------------

/**
 * Run the periodic gas (ERG balance) check.
 *
 * Checks server wallet ERG balance and logs a warning if below threshold.
 * Also tops up hot wallet gas if needed.
 */
export async function runGasCheck(provider: ErgoProvider): Promise<void> {
  try {
    const book = loadAddressbook();
    if (!book["server"]?.address) return;

    const config = loadFundManagerConfig();

    // Check server ERG balance
    const serverBal = await executeBalance("server", undefined, book);
    if (serverBal.nanoErg < config.gas_low_threshold_nanoerg) {
      console.warn(
        `[FUND] Server ERG balance low: ${formatErg(serverBal.nanoErg)} ` +
        `(threshold: ${formatErg(config.gas_low_threshold_nanoerg)})`,
      );
      // TODO: DEX swap stub — when available, swap stablecoin to ERG here
    }

    // Top up hot wallet gas if needed
    if (book["hot"]?.address) {
      try {
        await topUpHotWalletGas(book, config);
      } catch (err) {
        console.error(`[FUND] Hot wallet gas top-up failed: ${err}`);
      }
    }
  } catch (err) {
    console.error(`[FUND] Gas check error: ${err}`);
  } finally {
    const update: Partial<FundManagerState> = { last_gas_check: Date.now() };
    try {
      update.last_gas_check_block = await provider.getHeight();
    } catch (err) {
      console.error(`[FUND] getHeight failed in runGasCheck finally: ${err}`);
    }
    updateState(update);
  }
}

// -- Fund cycle ---------------------------------------------------------------

/**
 * Run the full fund collection and distribution cycle.
 *
 * 1. Load addressbook, ensure hot wallet exists
 * 2. Withdraw — collect earned payments from subscription boxes
 * 3. Top up hot wallet ERG from server if below threshold
 * 4. Top up server stablecoin buffer from hot wallet
 * 5. Revenue shares — distribute % to dev/broker if enabled
 * 6. Remainder to admin — send all remaining hot wallet balance
 * 7. Update state: last_fund_cycle (ms) and last_fund_cycle_block (height)
 */
export async function runFundManager(provider: ErgoProvider): Promise<void> {
  if (fundCycleInProgress) return;
  fundCycleInProgress = true;

  try {
    if (isProvisioningInProgress()) {
      console.log("[FUND] Provisioning in progress, deferring fund cycle");
      return;
    }

    console.log("[FUND] Starting fund cycle...");

    // Load addressbook and ensure hot wallet exists
    let book = loadAddressbook();
    if (Object.keys(book).length === 0) {
      console.error("[FUND] Addressbook empty, skipping fund cycle");
      return;
    }
    book = await ensureHotWallet(book);

    const config = loadFundManagerConfig();

    const pause = () => new Promise<void>((r) => setTimeout(r, 3000));

    // Step 1: Collect earned payments from subscription boxes
    try {
      await runWithdrawal(book);
    } catch (err) {
      console.error(`[FUND] Step 1 (withdrawal) failed: ${err}`);
    }

    // Steps 2-5: distribution — skip in testing mode to preserve deployer ERG
    if (!testingMode) {
      await pause();

      try {
        // Step 2: Top up hot wallet ERG from server
        await topUpHotWalletGas(book, config);
      } catch (err) {
        console.error(`[FUND] Step 2 (hot wallet gas) failed: ${err}`);
      }

      await pause();

      try {
        // Step 3: Top up server stablecoin buffer from hot wallet
        await topUpServerStablecoinBuffer(book, config);
      } catch (err) {
        console.error(`[FUND] Step 3 (stablecoin buffer) failed: ${err}`);
      }

      await pause();

      try {
        // Step 4: Revenue shares (hot -> dev/broker)
        const revenueConfig = loadRevenueShareConfig();
        await distributeRevenueShares(book, revenueConfig);
      } catch (err) {
        console.error(`[FUND] Step 4 (revenue shares) failed: ${err}`);
      }

      await pause();

      try {
        // Step 5: Remainder to admin (hot -> admin)
        await sendRemainderToAdmin(book);
      } catch (err) {
        console.error(`[FUND] Step 5 (remainder to admin) failed: ${err}`);
      }
    } else {
      console.log("[FUND] Testing mode — skipping distribution steps 2-5");
    }

    console.log("[FUND] Fund cycle complete");
  } catch (err) {
    console.error(`[FUND] Error during fund cycle: ${err}`);
  } finally {
    const update: Partial<FundManagerState> = { last_fund_cycle: Date.now() };
    try {
      update.last_fund_cycle_block = await provider.getHeight();
    } catch (err) {
      console.error(`[FUND] getHeight failed in runFundManager finally: ${err}`);
    }
    updateState(update);
    fundCycleInProgress = false;
  }
}
