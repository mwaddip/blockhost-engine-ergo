/**
 * CLI utilities: addressbook loading, token/address resolution, provider loading.
 *
 * Ergo-specific: token = ErgoTokenId (64-char hex), ERG = "" (empty string).
 */

import * as fs from "fs";
import * as yaml from "js-yaml";
import { isValidAddress } from "../ergo/address.js";
import { createProvider } from "../ergo/provider.js";
import type { ErgoProvider } from "../ergo/provider.js";
import type { ErgoTokenId } from "../ergo/types.js";
import { loadNetworkConfig } from "../fund-manager/web3-config.js";
import type { Addressbook, AddressbookEntry } from "../fund-manager/types.js";
import { CONFIG_DIR, ADDRESSBOOK_PATH } from "../paths.js";

// ── Addressbook ────────────────────────────────────────────────────────────────

/**
 * Read /etc/blockhost/addressbook.json. Entries with invalid Base58 Ergo
 * addresses are dropped (logged via console.error). Returns an empty object
 * if the file does not exist.
 */
export function loadAddressbook(): Addressbook {
  try {
    if (!fs.existsSync(ADDRESSBOOK_PATH)) {
      return {};
    }

    const raw = fs.readFileSync(ADDRESSBOOK_PATH, "utf8");
    const book = JSON.parse(raw) as Addressbook;

    for (const [role, entry] of Object.entries(book)) {
      if (!isValidAddress(entry.address)) {
        console.error(
          `[ADDRESSBOOK] Invalid address for role '${role}': ${entry.address}`,
        );
        delete book[role];
      }
    }

    return book;
  } catch (err) {
    console.error(`[ADDRESSBOOK] Error loading: ${err}`);
    return {};
  }
}

// ── Address resolution ────────────────────────────────────────────────────────

/**
 * Resolve an addressbook role to its Base58 Ergo address.
 *
 * If roleOrAddress is already a valid Ergo address it is returned as-is.
 * Throws if the role is not found in the book and the value is not an address.
 */
export function resolveAddress(
  roleOrAddress: string,
  book: Addressbook,
): string {
  if (isValidAddress(roleOrAddress)) {
    return roleOrAddress;
  }

  const entry: AddressbookEntry | undefined = book[roleOrAddress];
  if (!entry) {
    throw new Error(
      `Unknown role '${roleOrAddress}': not in addressbook and not a valid address`,
    );
  }

  return entry.address;
}

// ── Token resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a token shortcut to an Ergo token ID.
 *
 *   "erg" | "nanoerg" | ""  -> "" (native ERG)
 *   "stable" | "stablecoin" -> reads payment_token from web3-defaults.yaml
 *   64-char hex             -> literal token ID
 *
 * Throws for unknown shortcuts.
 */
export function resolveToken(tokenOrShortcut: string): ErgoTokenId | "" {
  const lower = tokenOrShortcut.toLowerCase();

  if (lower === "erg" || lower === "nanoerg" || lower === "") {
    return "";
  }

  if (lower === "stable" || lower === "stablecoin") {
    return resolveStableToken();
  }

  // 64-char hex = Ergo token ID (= box ID of minting tx first input)
  if (/^[0-9a-fA-F]{64}$/.test(tokenOrShortcut)) {
    return tokenOrShortcut;
  }

  throw new Error(
    `Unknown token: '${tokenOrShortcut}'. Use 'erg', 'stable', or 64-char hex token ID.`,
  );
}

/** Load the payment token from web3-defaults.yaml (payment_token field). */
function resolveStableToken(): ErgoTokenId {
  const CONFIG_PATH = `${CONFIG_DIR}/web3-defaults.yaml`;

  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found: ${CONFIG_PATH}`);
  }

  const raw = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8")) as
    | Record<string, unknown>
    | null;
  const bc = raw?.["blockchain"] as Record<string, unknown> | undefined;
  const pt = bc?.["payment_token"] as string | undefined;

  if (!pt) {
    throw new Error(
      "blockchain.payment_token not set in web3-defaults.yaml — cannot resolve 'stable'",
    );
  }

  return resolveToken(pt); // recurse with the literal value
}

// ── Provider client ──────────────────────────────────────────────────────────

/**
 * Get an ErgoProvider configured from web3-defaults.yaml.
 */
export function getProviderClient(): ErgoProvider {
  const { explorerUrl, signerUrl, submitUrl } = loadNetworkConfig();
  return createProvider(explorerUrl, signerUrl, submitUrl);
}

// ── Amount parsing ───────────────────────────────────────────────────────────

/**
 * Parse a human-readable amount string into base units.
 *
 * "1.5" with decimals=9 -> 1_500_000_000n
 * "100" with decimals=0 -> 100n
 *
 * Uses string splitting (not floating-point) to preserve full precision.
 */
export function parseAmountToBaseUnits(amountStr: string, decimals: number): bigint {
  const parts = amountStr.split(".");
  const wholePart = parts[0] ?? "0";
  const fracPart = (parts[1] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(wholePart) * BigInt(10 ** decimals) + BigInt(fracPart || "0");
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/**
 * Format a nanoERG amount as a human-readable ERG string.
 *
 * Example: 1_500_000_000n -> "1.500000000 ERG"
 */
export function formatErg(nanoErg: bigint): string {
  const whole = nanoErg / 1_000_000_000n;
  const frac = (nanoErg < 0n ? -nanoErg : nanoErg) % 1_000_000_000n;
  return `${whole}.${frac.toString().padStart(9, "0")} ERG`;
}

/**
 * Format a native token amount.
 *
 * @param amount   Raw token units (BigInt)
 * @param decimals Token decimal places (default 0)
 * @param symbol   Token symbol string
 */
export function formatToken(amount: bigint, decimals = 0, symbol = ""): string {
  if (decimals === 0) {
    return `${amount.toString()} ${symbol}`.trim();
  }
  const factor = BigInt(10 ** decimals);
  const whole = amount / factor;
  const frac = (amount < 0n ? -amount : amount) % factor;
  return `${whole}.${frac.toString().padStart(decimals, "0")} ${symbol}`.trim();
}
