/**
 * BlockHost Ergo monitor -- main polling loop.
 *
 * Polls the Ergo node every 5 seconds for subscription box UTXOs. Detects
 * new subscriptions, extensions, and removals by diffing the current chain
 * state against our known state. Runs periodic reconciliation and fund
 * cycles. Handles graceful shutdown on SIGINT/SIGTERM.
 *
 * Pipeline serialization: only one handler pipeline runs at a time.
 * New events are queued and processed after the current pipeline completes.
 * Pipeline state is persisted to /var/lib/blockhost/pipeline.json for
 * crash recovery.
 */

import * as fs from "fs";
import { createProvider } from "../ergo/provider.js";
import type { ErgoProvider } from "../ergo/provider.js";
import { loadNetworkConfig } from "../fund-manager/web3-config.js";
import { getSubscriptionErgoTree } from "../ergo/contracts.js";
import { publicKeyFromAddress, addressFromPrivateKey } from "../ergo/address.js";
import { loadServerPrivateKey } from "../crypto.js";
import { SubscriptionScanner, type ScanDiff, type TrackedSubscription } from "./scanner.js";
import {
  handleSubscriptionCreated,
  handleSubscriptionExtended,
  handleSubscriptionRemoved,
} from "../handlers/index.js";
import { runReconciliation } from "../reconcile/index.js";
import { processAdminCommands, loadAdminConfig, initAdminCommands, shutdownAdminCommands } from "../admin/index.js";
import type { AdminConfig } from "../admin/index.js";
import { runFundManager, runGasCheck, shouldRunFundCycle, shouldRunGasCheck } from "../fund-manager/index.js";
import { STATE_DIR, TESTING_MODE_FILE } from "../paths.js";

// -- Testing mode ------------------------------------------------------------

const testingMode = fs.existsSync(TESTING_MODE_FILE);

// -- Intervals ---------------------------------------------------------------

const POLL_INTERVAL_MS      = testingMode ? 5_000  : 5_000;         // 5s both modes
const RECONCILE_INTERVAL_MS = testingMode ? 120_000 : 300_000;      // 2min test / 5min prod
const FUND_CYCLE_INTERVAL_MS = testingMode ? 600_000 : 86_400_000;  // 10min test / 24h prod
const GAS_CHECK_INTERVAL_MS = testingMode ? 300_000 : 1_800_000;    // 5min test / 30min prod

// -- Pipeline state ----------------------------------------------------------

const PIPELINE_STATE_PATH = `${STATE_DIR}/pipeline.json`;

interface PipelineState {
  busy: boolean;
  current_event?: string;
  stage?: string;
  started_at?: number;
}

interface QueuedEvent {
  type: "created" | "extended" | "removed";
  sub: TrackedSubscription;
  oldSub?: TrackedSubscription;
}

// -- State -------------------------------------------------------------------

let running = true;
let pipelineBusy = false;
const eventQueue: QueuedEvent[] = [];
let lastReconcile = 0;
let adminConfig: AdminConfig | null = null;

// -- Pipeline state persistence ----------------------------------------------

function savePipelineState(state: PipelineState): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(PIPELINE_STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // Non-fatal
  }
}

function clearPipelineState(): void {
  savePipelineState({ busy: false });
}

// -- Pipeline execution ------------------------------------------------------

async function runPipeline(event: QueuedEvent): Promise<void> {
  pipelineBusy = true;
  savePipelineState({
    busy: true,
    current_event: event.type,
    stage: "started",
    started_at: Date.now(),
  });

  try {
    switch (event.type) {
      case "created":
        await handleSubscriptionCreated(event.sub);
        break;
      case "extended":
        if (event.oldSub) {
          await handleSubscriptionExtended(event.oldSub, event.sub);
        }
        break;
      case "removed":
        await handleSubscriptionRemoved(event.sub);
        break;
    }
  } catch (err) {
    console.error(`[MONITOR] Pipeline error for ${event.type} event: ${err}`);
  } finally {
    pipelineBusy = false;
    clearPipelineState();
  }
}

async function drainQueue(): Promise<void> {
  while (eventQueue.length > 0 && running) {
    const event = eventQueue.shift();
    if (event) {
      await runPipeline(event);
    }
  }
}

// -- Periodic tasks (guarded by pipeline_busy) --------------------------------

async function maybeRunReconciliation(provider: ErgoProvider): Promise<void> {
  const now = Date.now();
  if (pipelineBusy) return;
  if (now - lastReconcile < RECONCILE_INTERVAL_MS) return;

  console.log("[MONITOR] Running reconciliation...");
  try {
    await runReconciliation(provider);
  } catch (err) {
    console.error(`[MONITOR] Reconciliation error: ${err}`);
  }
  lastReconcile = now;
}

async function maybeRunFundCycle(): Promise<void> {
  if (pipelineBusy) return;
  if (!shouldRunFundCycle()) return;

  console.log("[MONITOR] Running fund cycle...");
  try {
    await runFundManager();
  } catch (err) {
    console.error(`[MONITOR] Fund cycle error: ${err}`);
  }
}

async function maybeRunGasCheck(): Promise<void> {
  if (pipelineBusy) return;
  if (!shouldRunGasCheck()) return;

  console.log("[MONITOR] Running gas check...");
  try {
    await runGasCheck();
  } catch (err) {
    console.error(`[MONITOR] Gas check error: ${err}`);
  }
}

// -- Core poll loop ----------------------------------------------------------

async function poll(
  provider: ErgoProvider,
  scanner: SubscriptionScanner,
): Promise<void> {
  while (running) {
    try {
      console.log("[MONITOR] Scanning...");
      const diff: ScanDiff = await scanner.scan();
      console.log(
        `[MONITOR] Scan result: created=${diff.created.length} removed=${diff.removed.length} extended=${diff.extended.length}`,
      );

      // Queue new subscription events
      for (const sub of diff.created) {
        eventQueue.push({ type: "created", sub });
      }

      // Queue extension events
      for (const { old: oldSub, new: newSub } of diff.extended) {
        eventQueue.push({ type: "extended", sub: newSub, oldSub });
      }

      // Queue removal events
      for (const sub of diff.removed) {
        eventQueue.push({ type: "removed", sub });
      }

      // Process queued events (serialized)
      if (eventQueue.length > 0) {
        await drainQueue();
      }

      // Admin commands (only when pipeline is idle)
      if (adminConfig) {
        try {
          await processAdminCommands(provider, adminConfig);
        } catch (err) {
          console.error(`[MONITOR] Admin command processing error: ${err}`);
        }
      }

      // Periodic tasks (only when pipeline is idle)
      await maybeRunReconciliation(provider);
      await maybeRunFundCycle();
      await maybeRunGasCheck();

    } catch (err) {
      console.error(`[MONITOR] Poll error: ${err}`);
    }

    // Wait before next scan
    await sleep(POLL_INTERVAL_MS);
  }
}

// -- Shutdown ----------------------------------------------------------------

function setupShutdown(): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[MONITOR] Received ${signal}, shutting down...`);
    running = false;
    clearPipelineState();
    if (adminConfig) {
      void shutdownAdminCommands();
    }
    // Allow the current poll iteration to finish, then exit
    setTimeout(() => process.exit(0), 2000);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// -- Entry point -------------------------------------------------------------

async function main(): Promise<void> {
  console.log("==============================================");
  console.log("  BlockHost Ergo Monitor");
  if (testingMode) {
    console.log("  *** TESTING MODE ACTIVE ***");
    console.log(`  Poll: ${POLL_INTERVAL_MS / 1000}s | Reconcile: ${RECONCILE_INTERVAL_MS / 1000}s | Fund: ${FUND_CYCLE_INTERVAL_MS / 60000}min | Gas: ${GAS_CHECK_INTERVAL_MS / 60000}min`);
  }
  console.log("==============================================");

  setupShutdown();

  // Load network config
  let config;
  try {
    config = loadNetworkConfig();
  } catch (err) {
    console.error(`[MONITOR] Fatal: could not load web3-defaults.yaml: ${err}`);
    process.exit(1);
  }

  const provider = createProvider(config.explorerUrl, config.signerUrl);
  const mainnet = config.network === "mainnet";

  // Load server identity
  let serverPubKeyHex: string;
  try {
    const privKeyHex = loadServerPrivateKey();
    const serverAddress = addressFromPrivateKey(privKeyHex, mainnet);
    serverPubKeyHex = publicKeyFromAddress(serverAddress);
    console.log(`Server address:   ${serverAddress}`);
  } catch (err) {
    console.error(`[MONITOR] Fatal: could not load server key: ${err}`);
    process.exit(1);
  }

  // Get subscription ErgoTree (compile or use cached)
  let subscriptionErgoTree: string;
  // Derive subscription ErgoTree from embedded template + server PK
  // No node or JRE needed — pure constant substitution
  subscriptionErgoTree = getSubscriptionErgoTree(serverPubKeyHex);
  console.log(`Subscription tree: ${subscriptionErgoTree.slice(0, 40)}... (from template)`);

  // Create scanner
  const scanner = new SubscriptionScanner(provider, subscriptionErgoTree, testingMode);
  scanner.restoreFromFile();

  console.log(`Network:          ${config.network}`);
  console.log(`Explorer URL:     ${config.explorerUrl}`);
  console.log(`Signer URL:       ${config.signerUrl}`);
  console.log(`Poll interval:    ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`Reconcile every:  ${RECONCILE_INTERVAL_MS / 60000}min`);
  console.log("----------------------------------------------\n");

  // Load admin config (optional)
  adminConfig = loadAdminConfig();
  if (adminConfig) {
    initAdminCommands();
    console.log(`Admin commands:   enabled (wallet: ${adminConfig.wallet_address.slice(0, 15)}...)`);
  } else {
    console.log("Admin commands:   not configured");
  }

  // Initialize periodic task timers from now
  lastReconcile = Date.now();

  // Clear any stale pipeline state from a previous crash
  clearPipelineState();

  console.log("Monitor is running. Press Ctrl+C to stop.\n");
  await poll(provider, scanner);
}

main().catch((err) => {
  console.error(`[MONITOR] Fatal error: ${err}`);
  process.exit(1);
});

// -- Helpers -----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
