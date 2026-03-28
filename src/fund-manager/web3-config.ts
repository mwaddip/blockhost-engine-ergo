/**
 * Ergo network configuration loader.
 * Reads node URL, explorer URL, and network type from web3-defaults.yaml.
 */

import * as fs from "fs";
import * as yaml from "js-yaml";
import { WEB3_DEFAULTS_PATH } from "../paths.js";
import type { ErgoNetwork } from "../ergo/types.js";

export interface ErgoNetworkConfig {
  nodeUrl: string;        // e.g. "http://localhost:9053" — for indexed queries and tx submission
  explorerUrl: string;    // e.g. "https://api.ergoplatform.com" — for token/balance/box queries
  signerUrl: string;      // e.g. "http://127.0.0.1:9064" — local ergo-signer for tx signing
  network: ErgoNetwork;   // "mainnet" or "testnet"
  nodeApiKey?: string;    // API key for authenticated node endpoints (if using full node)
}

/**
 * Load Ergo network configuration from web3-defaults.yaml.
 * Falls back to sensible defaults (mainnet, localhost node, public explorer).
 */
export function loadNetworkConfig(): ErgoNetworkConfig {
  if (!fs.existsSync(WEB3_DEFAULTS_PATH)) {
    throw new Error(`Config not found: ${WEB3_DEFAULTS_PATH}`);
  }
  const raw = yaml.load(fs.readFileSync(WEB3_DEFAULTS_PATH, "utf8")) as Record<string, unknown> | null;
  const bc = raw?.["blockchain"] as Record<string, unknown> | undefined;

  return {
    nodeUrl: (bc?.["node_url"] as string) ?? "http://localhost:9053",
    explorerUrl: (bc?.["explorer_url"] as string) ?? "https://api.ergoplatform.com",
    signerUrl: (bc?.["signer_url"] as string) ?? "http://127.0.0.1:9064",
    network: ((bc?.["network"] as string) ?? "mainnet") as ErgoNetwork,
    nodeApiKey: (bc?.["node_api_key"] as string) ?? undefined,
  };
}
