/**
 * Subscription event handlers -- provision, extend, and destroy VMs.
 *
 * Adapts the Cardano handler pipeline for Ergo's beacon-based detection model.
 * Input is TrackedSubscription (from the subscription scanner), not a contract event.
 *
 * Pipeline for new subscriptions:
 *   1. Decrypt userEncrypted from registers (ECIES with server key)
 *   2. Call provisioner: blockhost-vm-create with --owner-wallet and --expiry-days
 *   3. Parse JSON summary from provisioner stdout
 *   4. Resolve subscriber-facing host via network_hook.get_connection_endpoint()
 *   5. Encrypt connection details (SHAKE256 symmetric)
 *   6. Call: blockhost-mint-nft with --owner-wallet and --user-encrypted
 *   7. Call provisioner: blockhost-vm-update-gecos with VM name, wallet, NFT ID
 *   8. Mark NFT minted in database (Python subprocess)
 *
 * VM naming: blockhost-NNN (3-digit zero-padded), auto-incrementing counter.
 */

import { spawn, spawnSync } from "child_process";
import * as fs from "node:fs";
import type { TrackedSubscription } from "../monitor/scanner.js";
import { eciesDecrypt, symmetricEncrypt, loadServerPrivateKey } from "../crypto.js";
import { getCommand } from "../provisioner.js";
import { getProviderClient } from "../bw/cli-utils.js";
import { allocateCounter } from "../util/counter.js";
import { CONFIG_DIR, STATE_DIR, PYTHON_TIMEOUT_MS } from "../paths.js";

// -- Constants ---------------------------------------------------------------
const SSH_PORT = 22;
const NEXT_VM_ID_FILE = `${STATE_DIR}/next-vm-id`;
const NETWORK_MODE_PATH = `${CONFIG_DIR}/network-mode`;
// Onion mode can call root-agent (tor-hidden-service-add) which may reload tor.
const NETWORK_HOOK_TIMEOUT_MS = 30_000;

/**
 * Format a VM ID as a VM name: blockhost-001, blockhost-042, etc.
 */
function formatVmName(vmId: number): string {
  return `blockhost-${vmId.toString().padStart(3, "0")}`;
}

// -- Expiry calculation ------------------------------------------------------



/** Approx blocks per day on Ergo (~2 min block time) */
const BLOCKS_PER_DAY = 720;

/**
 * Calculate days remaining from current block height until expiry height.
 * Returns at least 1.
 */
function calculateExpiryDays(expiryHeight: number, currentHeight: number): number {
  if (expiryHeight <= currentHeight) return 1;
  const blocksRemaining = expiryHeight - currentHeight;
  const days = Math.floor(blocksRemaining / BLOCKS_PER_DAY);
  return Math.max(1, days);
}

/**
 * Calculate additional days between two expiry heights.
 */
function calculateAdditionalDays(oldExpiryHeight: number, newExpiryHeight: number): number {
  if (newExpiryHeight <= oldExpiryHeight) return 0;
  const blocksDelta = newExpiryHeight - oldExpiryHeight;
  return Math.max(1, Math.floor(blocksDelta / BLOCKS_PER_DAY));
}

// -- Crypto helpers ----------------------------------------------------------

/**
 * Decrypt ECIES-encrypted register field using the server private key.
 * Returns the decrypted plaintext (user signature), or null on failure.
 */
function decryptUserSignature(userEncryptedHex: string): string | null {
  try {
    const privateKey = loadServerPrivateKey();
    return eciesDecrypt(privateKey, userEncryptedHex);
  } catch (err) {
    console.error(`[ERROR] Failed to decrypt user signature: ${err}`);
    return null;
  }
}

/**
 * Encrypt connection details with the user's signature as key material.
 * Returns hex-encoded ciphertext, or null on failure.
 */
function encryptConnectionDetails(
  userSignature: string,
  hostname: string,
  username: string,
): string | null {
  const connectionDetails = JSON.stringify({
    hostname,
    port: SSH_PORT,
    username,
  });

  try {
    return symmetricEncrypt(userSignature, connectionDetails);
  } catch (err) {
    console.error(`[ERROR] Failed to encrypt connection details: ${err}`);
    return null;
  }
}

// -- Command runner ----------------------------------------------------------

function runCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd: STATE_DIR });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

// -- Network hook (network-mode-agnostic endpoint resolution) ----------------

function readNetworkMode(): string {
  try {
    const mode = fs.readFileSync(NETWORK_MODE_PATH, "utf8").trim();
    return mode || "broker";
  } catch {
    return "broker";
  }
}

/**
 * Ask blockhost.network_hook for the subscriber-facing host for this VM.
 * Return value depends on mode:
 *   broker -> IPv6 from broker-allocation.json
 *   manual -> static IP from config
 *   onion  -> .onion address (creates hidden service and pushes into VM)
 */
function getConnectionEndpoint(vmName: string, bridgeIp: string, mode: string): string {
  const script =
    "import sys\n" +
    "from blockhost.network_hook import get_connection_endpoint\n" +
    "print(get_connection_endpoint(sys.argv[1], sys.argv[2], sys.argv[3]))\n";
  const result = spawnSync("python3", ["-c", script, vmName, bridgeIp, mode], {
    cwd: STATE_DIR,
    timeout: NETWORK_HOOK_TIMEOUT_MS,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    throw new Error(`network_hook.get_connection_endpoint failed: ${err || `exit ${String(result.status)}`}`);
  }
  return result.stdout.trim();
}

function networkHookCleanup(vmName: string, mode: string): void {
  const script =
    "import sys\n" +
    "from blockhost.network_hook import cleanup\n" +
    "cleanup(sys.argv[1], sys.argv[2])\n";
  const result = spawnSync("python3", ["-c", script, vmName, mode], {
    cwd: STATE_DIR,
    timeout: NETWORK_HOOK_TIMEOUT_MS,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    console.warn(`[WARN] network_hook.cleanup failed for ${vmName}: ${err || `exit ${String(result.status)}`}`);
  }
}

// -- Output parsers ----------------------------------------------------------

const RESULT_PREFIX = "BLOCKHOST_RESULT: ";

/** Summary JSON emitted by blockhost-vm-create on the BLOCKHOST_RESULT: line */
interface VmCreateSummary {
  status: string;
  vm_name: string;
  ip: string;
  vmid: number;
  username: string;
}

function findResultPayload(stdout: string): string | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const idx = line.indexOf(RESULT_PREFIX);
    if (idx !== -1) {
      return line.slice(idx + RESULT_PREFIX.length).trim();
    }
  }
  return null;
}

function parseVmSummary(stdout: string): VmCreateSummary | null {
  const payload = findResultPayload(stdout);
  if (!payload) return null;
  try {
    return JSON.parse(payload) as VmCreateSummary;
  } catch {
    return null;
  }
}

function parseMintTokenId(stdout: string): string | null {
  const payload = findResultPayload(stdout);
  if (payload && /^[0-9a-fA-F]{64}$/.test(payload)) {
    return payload;
  }
  return null;
}

// -- Database helpers --------------------------------------------------------

/**
 * Mark an NFT as minted in the VM database (synchronous Python subprocess).
 */
function markNftMinted(vmName: string, nftTokenId: string): void {
  const script = `
import os
from blockhost.vm_db import get_database
db = get_database()
db.set_nft_minted(os.environ['VM_NAME'], os.environ['NFT_TOKEN_ID'])
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: STATE_DIR,
    timeout: PYTHON_TIMEOUT_MS,
    env: { ...process.env, VM_NAME: vmName, NFT_TOKEN_ID: nftTokenId },
  });
  if (result.status !== 0) {
    const errMsg = result.stderr ? result.stderr.toString().trim() : "";
    console.error(
      `[WARN] Failed to mark NFT ${nftTokenId.slice(0, 16)}... as minted in database${errMsg ? ": " + errMsg : ""}`,
    );
  }
}

function updateVmFields(vmName: string, fields: Record<string, unknown>): void {
  const script = `
import os, json
from blockhost.vm_db import get_database
db = get_database()
db.update_fields(os.environ['VM_NAME'], json.loads(os.environ['FIELDS_JSON']))
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: STATE_DIR,
    timeout: PYTHON_TIMEOUT_MS,
    env: { ...process.env, VM_NAME: vmName, FIELDS_JSON: JSON.stringify(fields) },
  });
  if (result.status !== 0) {
    const errMsg = result.stderr ? result.stderr.toString().trim() : "";
    console.warn(
      `[WARN] Failed to update VM fields for ${vmName}${errMsg ? ": " + errMsg : ""}`,
    );
  }
}

// -- VM lifecycle helpers ----------------------------------------------------

async function destroyVm(vmName: string): Promise<{ success: boolean; output: string }> {
  const result = await runCommand(getCommand("destroy"), [vmName]);
  return {
    success: result.code === 0,
    output: (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim(),
  };
}

// -- Handler: new subscription -----------------------------------------------

/**
 * Handle a newly-detected subscription box.
 *
 * Allocates a VM ID from the local counter, then runs the full 8-step
 * provisioning pipeline: decrypt -> create VM -> parse summary -> resolve
 * connection endpoint -> encrypt details -> mint NFT -> update GECOS -> mark minted.
 */
export async function handleSubscriptionCreated(sub: TrackedSubscription): Promise<void> {
  const { state, beaconTokenId, boxId } = sub;

  const vmId = await allocateCounter(NEXT_VM_ID_FILE);
  const vmName = formatVmName(vmId);
  const currentHeight = await getProviderClient().getHeight();
  const expiryDays = calculateExpiryDays(state.expiryHeight, currentHeight);

  const networkMode = readNetworkMode();

  console.log("\n========== SUBSCRIPTION CREATED ==========");
  console.log(`Beacon:      ${beaconTokenId.slice(0, 16)}...`);
  console.log(`Box ID:      ${boxId}`);
  console.log(`Plan ID:     ${state.planId}`);
  console.log(`Subscriber:  ${state.subscriber}`);
  console.log(`Expiry height: ${state.expiryHeight}`);
  console.log(`Amount:      ${state.amountRemaining} (rate: ${state.ratePerInterval}/${state.intervalBlocks} blocks)`);
  console.log(`User enc:    ${state.userEncrypted.length > 10 ? state.userEncrypted.slice(0, 10) + "..." : state.userEncrypted}`);
  console.log(`Network mode: ${networkMode}`);
  console.log("------------------------------------------");
  console.log(`Provisioning VM: ${vmName} (${expiryDays} days)`);

  // Step 1: Decrypt user signature (fail fast before spending time on VM create)
  let userSignature: string | null = null;
  if (state.userEncrypted && state.userEncrypted.length > 0) {
    console.log("Decrypting user signature...");
    userSignature = decryptUserSignature(state.userEncrypted);
    if (userSignature) {
      console.log("User signature decrypted successfully");
    } else {
      console.warn("[WARN] Could not decrypt user signature, proceeding without encrypted connection details");
    }
  }

  // Step 2: Create VM
  const createArgs = [
    vmName,
    "--owner-wallet", state.subscriber,
    "--expiry-days", expiryDays.toString(),
    "--apply",
  ];

  console.log("Creating VM...");
  const createResult = await runCommand(getCommand("create"), createArgs);

  if (createResult.code !== 0) {
    console.error(`[ERROR] Failed to provision VM ${vmName}`);
    console.error(createResult.stderr || createResult.stdout);
    console.log("==========================================\n");
    return;
  }

  console.log(`[OK] VM ${vmName} provisioned successfully`);

  // Record Ergo-specific fields (beacon, box id) on the VM record. The
  // provisioner registered the row; we extend it via the agnostic update_fields
  // mutator. Non-fatal: scanner re-detects the box on restart if this fails.
  updateVmFields(vmName, { beacon_token_id: beaconTokenId, box_id: boxId });

  // Step 3: Parse JSON summary from provisioner stdout
  const summary = parseVmSummary(createResult.stdout);
  if (!summary) {
    console.log("[INFO] No JSON summary from provisioner");
    console.log(createResult.stdout);
    console.log("==========================================\n");
    return;
  }

  console.log(`[INFO] VM summary: ip=${summary.ip}, vmid=${summary.vmid}`);

  // Step 4: Resolve subscriber-facing host via network hook
  // (broker -> IPv6 allocation, manual -> static IP, onion -> creates .onion)
  let connectionHost: string;
  try {
    connectionHost = getConnectionEndpoint(vmName, summary.ip, networkMode);
    console.log(`[OK] Connection endpoint (${networkMode}): ${connectionHost}`);
  } catch (err) {
    console.error(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    console.warn(`[WARN] Falling back to bridge IP ${summary.ip} for connection details`);
    connectionHost = summary.ip;
  }

  // Step 5: Encrypt connection details with user signature
  let userEncryptedOut = "";

  if (userSignature) {
    const encrypted = encryptConnectionDetails(userSignature, connectionHost, summary.username);
    if (encrypted) {
      userEncryptedOut = encrypted;
      console.log("[OK] Connection details encrypted");
    } else {
      console.warn("[WARN] Failed to encrypt connection details, minting without user data");
    }
  }

  // Step 6: Mint NFT
  // The subscriber field is an Ergo Base58 address
  const mintArgs: string[] = ["--owner-wallet", state.subscriber];
  if (userEncryptedOut) {
    // Strip 0x prefix if present -- mint script expects raw hex
    const cleanHex = userEncryptedOut.startsWith("0x") ? userEncryptedOut.slice(2) : userEncryptedOut;
    mintArgs.push("--user-encrypted", cleanHex);
  }

  console.log("Minting NFT...");
  const mintResult = await runCommand("blockhost-mint-nft", mintArgs);

  if (mintResult.code !== 0) {
    console.error(`[WARN] NFT minting failed for ${vmName} (VM is still operational)`);
    console.error(mintResult.stderr || mintResult.stdout);
    console.error(
      `[WARN] Retry manually: blockhost-mint-nft --owner-wallet ${state.subscriber} --user-encrypted <hex>`,
    );
    console.log("==========================================\n");
    return;
  }

  // Parse token ID from mint stdout (Ergo: 64-char hex)
  const actualTokenId = parseMintTokenId(mintResult.stdout);
  if (actualTokenId === null) {
    console.error(`[WARN] Could not parse token ID from mint output: ${mintResult.stdout.trim()}`);
    console.log("==========================================\n");
    return;
  }

  console.log(`[OK] NFT minted for ${vmName} (token ${actualTokenId.slice(0, 16)}...)`);

  // Step 7: Update GECOS with actual token ID
  const gecosCmd = getCommand("update-gecos");
  const gecosArgs = [vmName, state.subscriber, "--nft-id", actualTokenId];
  let gecosUpdated = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) {
      console.log(`[INFO] Waiting for guest agent (attempt ${attempt}/4)...`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
    const gecosResult = spawnSync(gecosCmd, gecosArgs, { timeout: 30_000, cwd: STATE_DIR });
    if (gecosResult.status === 0) {
      console.log(`[OK] GECOS updated for ${vmName}`);
      gecosUpdated = true;
      break;
    }
    if (attempt === 4) {
      const errMsg = gecosResult.stderr ? gecosResult.stderr.toString().trim() : "";
      console.error(`[WARN] update-gecos failed for ${vmName} after ${attempt} attempts${errMsg ? ": " + errMsg : ""}`);
    }
  }
  // Not fatal if GECOS failed -- reconciler will retry on next cycle
  void gecosUpdated;

  // Step 8: Mark NFT minted in database
  markNftMinted(vmName, actualTokenId);

  console.log("==========================================\n");
}

// -- Handler: subscription extended ------------------------------------------

/**
 * Handle a subscription box that changed to a new box ID (spend-and-recreate).
 *
 * The new box carries an updated expiry timestamp and amountRemaining.
 * We calculate additional days from the delta between old and new expiry,
 * update the VM database, and resume the VM if it was suspended.
 */
export async function handleSubscriptionExtended(
  old: TrackedSubscription,
  updated: TrackedSubscription,
): Promise<void> {
  const { state: newState, beaconTokenId } = updated;

  console.log("\n========== SUBSCRIPTION EXTENDED ==========");
  console.log(`Beacon:         ${beaconTokenId.slice(0, 16)}...`);
  console.log(`Old box:        ${old.boxId}`);
  console.log(`New box:        ${updated.boxId}`);
  console.log(`Old expiry height: ${old.state.expiryHeight}`);
  console.log(`New expiry height: ${newState.expiryHeight}`);
  console.log(`Old amount:      ${old.state.amountRemaining}`);
  console.log(`New amount:      ${newState.amountRemaining}`);
  console.log(`Subscriber:      ${newState.subscriber}`);
  console.log("-------------------------------------------");

  const additionalDays = calculateAdditionalDays(old.state.expiryHeight, newState.expiryHeight);
  console.log(`Additional days: ${additionalDays}`);

  // Look up VM by beacon token ID or subscriber, update expiry
  const script = `
import os
from blockhost.vm_db import get_database

beacon_token_id = os.environ['BEACON_TOKEN_ID']
subscriber = os.environ['SUBSCRIBER']
additional_days = int(os.environ['ADDITIONAL_DAYS'])
db = get_database()
vm = db.get_vm_by_beacon(beacon_token_id) or db.get_vm_by_owner(subscriber)
if vm:
    old_status = vm.get('status', 'unknown')
    db.extend_expiry(vm['vm_name'], additional_days)
    print(f"Extended {vm['vm_name']} expiry by {additional_days} days")
    if old_status == 'suspended':
        print("NEEDS_RESUME")
    print(f"VM_NAME={vm['vm_name']}")
else:
    print(f"VM not found for beacon {beacon_token_id[:16]}... / subscriber {subscriber}")
`;

  const proc = spawn("python3", ["-c", script], {
    cwd: STATE_DIR,
    env: {
      ...process.env,
      BEACON_TOKEN_ID: beaconTokenId,
      SUBSCRIBER: newState.subscriber,
      ADDITIONAL_DAYS: String(additionalDays),
    },
  });

  let output = "";
  proc.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  proc.stderr.on("data", (data: Buffer) => { output += data.toString(); });

  const { needsResume, vmName } = await new Promise<{ needsResume: boolean; vmName: string | null }>(
    (resolve) => {
      proc.on("close", (code) => {
        if (code === 0) {
          const lines = output.trim().split("\n");
          console.log(`[OK] ${lines[0] ?? ""}`);
          const vmNameLine = lines.find((l) => l.startsWith("VM_NAME="));
          const parsedVmName = vmNameLine ? vmNameLine.slice("VM_NAME=".length) : null;
          resolve({ needsResume: output.includes("NEEDS_RESUME"), vmName: parsedVmName });
        } else {
          console.error(`[ERROR] Failed to extend expiry: ${output}`);
          resolve({ needsResume: false, vmName: null });
        }
      });
    },
  );

  // Resume VM if it was suspended
  if (needsResume && vmName) {
    console.log(`Resuming suspended VM: ${vmName}`);
    const resumeResult = await runCommand(getCommand("resume"), [vmName]);
    if (resumeResult.code === 0) {
      console.log(`[OK] Successfully resumed VM: ${vmName}`);
      if (resumeResult.stdout.trim()) {
        console.log(resumeResult.stdout.trim());
      }
    } else {
      console.error(`[WARN] Failed to resume VM ${vmName}`);
      console.error(`[WARN] ${(resumeResult.stderr || resumeResult.stdout).trim()}`);
      console.error("[WARN] Operator may need to manually resume the VM");
    }
  }

  console.log("===========================================\n");
}

// -- Handler: subscription removed -------------------------------------------

/**
 * Handle a subscription box that has disappeared (beacon burned or collected).
 *
 * This covers both ServiceCollect (server collected funds) and SubscriberCancel.
 * In both cases we destroy the VM.
 */
export async function handleSubscriptionRemoved(sub: TrackedSubscription): Promise<void> {
  const { state, beaconTokenId, boxId } = sub;

  console.log("\n========== SUBSCRIPTION REMOVED ==========");
  console.log(`Beacon:     ${beaconTokenId.slice(0, 16)}...`);
  console.log(`Box ID:     ${boxId}`);
  console.log(`Plan ID:    ${state.planId}`);
  console.log(`Subscriber: ${state.subscriber}`);
  console.log("------------------------------------------");

  // Look up the VM name by beacon token ID (or subscriber fallback) then destroy
  const script = `
import os, sys
from blockhost.vm_db import get_database

beacon_token_id = os.environ['BEACON_TOKEN_ID']
subscriber = os.environ['SUBSCRIBER']
db = get_database()
vm = db.get_vm_by_beacon(beacon_token_id) or db.get_vm_by_owner(subscriber)
if vm:
    print(vm['vm_name'])
else:
    sys.exit(1)
`;

  const lookupResult = spawnSync("python3", ["-c", script], {
    cwd: STATE_DIR,
    timeout: PYTHON_TIMEOUT_MS,
    env: { ...process.env, BEACON_TOKEN_ID: beaconTokenId, SUBSCRIBER: state.subscriber },
  });

  if (lookupResult.status !== 0) {
    console.warn(`[WARN] VM not found for beacon ${beaconTokenId.slice(0, 16)}... -- nothing to destroy`);
    console.log("==========================================\n");
    return;
  }

  const vmName = lookupResult.stdout.toString().trim();
  console.log(`Destroying VM: ${vmName}`);

  const { success, output } = await destroyVm(vmName);

  if (success) {
    console.log(`[OK] ${output}`);
  } else {
    console.error(`[ERROR] Failed to destroy VM ${vmName}: ${output}`);
  }

  // Release network resources (onion hidden service, etc.) regardless of
  // destroy success -- cleanup is safe to run even if the VM is already gone.
  networkHookCleanup(vmName, readNetworkMode());

  console.log("==========================================\n");
}
