/**
 * Shared path constants and environment configuration.
 */

import * as fs from "node:fs";

/** Root config directory */
export const CONFIG_DIR = process.env["BLOCKHOST_CONFIG_DIR"] ?? "/etc/blockhost";

/** Root state directory */
export const STATE_DIR = process.env["BLOCKHOST_STATE_DIR"] ?? "/var/lib/blockhost";

/** Addressbook JSON file */
export const ADDRESSBOOK_PATH = `${CONFIG_DIR}/addressbook.json`;

/** web3-defaults.yaml config */
export const WEB3_DEFAULTS_PATH = `${CONFIG_DIR}/web3-defaults.yaml`;

/** blockhost.yaml config */
export const BLOCKHOST_CONFIG_PATH = `${CONFIG_DIR}/blockhost.yaml`;

/** Testing mode flag file */
export const TESTING_MODE_FILE = `${CONFIG_DIR}/.testing-mode`;

/** VMs database */
export const VMS_JSON_PATH = `${STATE_DIR}/vms.json`;

/** Minimum nanoERG for outputs (approx 0.001 ERG covers a simple box) */
export const MIN_ERG_FOR_BOX = 1_000_000n;

/** Timeout for Python subprocesses (ms) */
export const PYTHON_TIMEOUT_MS = 10_000;

/**
 * Return true when this engine is running against testnet.
 * Detected by the presence of TESTING_MODE_FILE.
 */
export function isTestnet(): boolean {
  return fs.existsSync(TESTING_MODE_FILE);
}
