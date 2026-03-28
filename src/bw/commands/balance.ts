/**
 * bw balance <role> [token]
 *
 * Query ERG and/or native token balance for an address or addressbook role.
 * Uses ErgoProvider (node + explorer) directly.
 *
 * Core function executeBalance() is used by fund-manager as well.
 */

import type { Addressbook } from "../../fund-manager/types.js";
import {
  resolveAddress,
  resolveToken,
  formatErg,
  formatToken,
  getProviderClient,
} from "../cli-utils.js";

// -- Types ------------------------------------------------------------------

export interface BalanceResult {
  address: string;
  nanoErg: bigint;
  tokenBalance?: bigint;
  tokenId?: string;
  tokenName?: string;
  tokenDecimals?: number;
}

// -- Core function (used by fund-manager) -----------------------------------

/**
 * Query ERG and optionally a native token balance for an address/role.
 *
 * @param roleOrAddr  Addressbook role or Base58 Ergo address
 * @param tokenArg    Optional: "erg", "stable", or 64-char hex token ID
 * @param book        Addressbook for role resolution
 */
export async function executeBalance(
  roleOrAddr: string,
  tokenArg: string | undefined,
  book: Addressbook,
): Promise<BalanceResult> {
  const address = resolveAddress(roleOrAddr, book);
  const provider = getProviderClient();

  const balance = await provider.getBalance(address);
  const result: BalanceResult = { address, nanoErg: balance.nanoErg };

  if (tokenArg) {
    const tokenId = resolveToken(tokenArg);

    if (tokenId === "") {
      // Requested "erg" — already have it
      return result;
    }

    const entry = balance.tokens.find((t) => t.tokenId === tokenId);
    result.tokenBalance = entry?.amount ?? 0n;
    result.tokenId = tokenId;
    result.tokenName = entry?.name;
    result.tokenDecimals = entry?.decimals;
  }

  return result;
}

// -- CLI handler ------------------------------------------------------------

export async function balanceCommand(
  args: string[],
  book: Addressbook,
): Promise<void> {
  if (args.length < 1) {
    console.error("Usage: bw balance <role> [token]");
    process.exit(1);
  }

  const [roleOrAddr, tokenArg] = args;
  if (!roleOrAddr) {
    console.error("Usage: bw balance <role> [token]");
    process.exit(1);
  }

  const result = await executeBalance(roleOrAddr, tokenArg, book);
  const provider = getProviderClient();

  console.log(`\nBalances for ${roleOrAddr} (${result.address}):\n`);
  console.log(`  ERG          ${formatErg(result.nanoErg)}`);

  if (result.tokenBalance !== undefined && result.tokenId) {
    const label = result.tokenName ?? result.tokenId.slice(0, 12) + "...";
    console.log(
      `  ${label.padEnd(12)} ${formatToken(result.tokenBalance, result.tokenDecimals ?? 0, "")}`,
    );
  } else if (!tokenArg) {
    // Show all token balances
    const balance = await provider.getBalance(result.address);
    for (const t of balance.tokens) {
      const label = t.name ?? t.tokenId.slice(0, 12) + "...";
      console.log(
        `  ${label.padEnd(12)} ${formatToken(t.amount, t.decimals ?? 0, "")}`,
      );
    }
  }

  console.log();
}
