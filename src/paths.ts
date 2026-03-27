/**
 * Shared path constants and environment configuration.
 */

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
export const TESTING_MODE_FILE = "/etc/blockhost/.testing-mode";

/** VMs database */
export const VMS_JSON_PATH = `${STATE_DIR}/vms.json`;

/** Minimum nanoERG for outputs (approx 0.001 ERG covers a simple box) */
export const MIN_ERG_FOR_BOX = 1_000_000n;

/** Timeout for Python subprocesses (ms) */
export const PYTHON_TIMEOUT_MS = 10_000;
