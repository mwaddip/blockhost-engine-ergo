/**
 * bw config stable [tokenId]
 *
 * Read or set the payment token configuration.
 *
 * Read path: print current payment_token from web3-defaults.yaml.
 * Write path: update blockchain.payment_token in web3-defaults.yaml.
 */

import * as fs from "fs";
import * as yaml from "js-yaml";
import type { Addressbook } from "../../fund-manager/types.js";
import { WEB3_DEFAULTS_PATH } from "../../paths.js";

/**
 * CLI handler
 */
export async function configCommand(
  args: string[],
  _book: Addressbook,
): Promise<void> {
  const [subCommand, ...rest] = args;

  if (subCommand === "stable") {
    await configStableCommand(rest);
    return;
  }

  console.error("Usage: bw config stable [tokenId]");
  console.error("  tokenId: 64-char hex Ergo token ID");
  process.exit(1);
}

async function configStableCommand(args: string[]): Promise<void> {
  if (args.length === 0) {
    // Read current payment token
    if (!fs.existsSync(WEB3_DEFAULTS_PATH)) {
      console.error(`Config not found: ${WEB3_DEFAULTS_PATH}`);
      process.exit(1);
    }

    const raw = yaml.load(
      fs.readFileSync(WEB3_DEFAULTS_PATH, "utf8"),
    ) as Record<string, unknown> | null;

    const bc = raw?.["blockchain"] as Record<string, unknown> | undefined;
    const pt = bc?.["payment_token"] as string | undefined;

    if (!pt) {
      console.log(
        "No payment token configured (blockchain.payment_token not set).",
      );
    } else {
      console.log(`Payment token: ${pt}`);
    }
    return;
  }

  // Write path -- update payment token
  const [newToken] = args;
  if (!newToken) {
    console.error("Usage: bw config stable <tokenId>");
    process.exit(1);
  }

  // Validate: should be 64 hex chars
  if (!/^[0-9a-fA-F]{64}$/.test(newToken)) {
    console.error(
      `Invalid token ID: ${newToken}. Expected 64 hex characters.`,
    );
    process.exit(1);
  }

  if (!fs.existsSync(WEB3_DEFAULTS_PATH)) {
    console.error(`Config not found: ${WEB3_DEFAULTS_PATH}`);
    process.exit(1);
  }

  // Load existing config, update payment_token, write back
  const raw =
    (yaml.load(fs.readFileSync(WEB3_DEFAULTS_PATH, "utf8")) as Record<
      string,
      unknown
    >) ?? {};

  if (!raw["blockchain"]) {
    raw["blockchain"] = {};
  }
  const bc = raw["blockchain"] as Record<string, unknown>;
  bc["payment_token"] = newToken;

  fs.writeFileSync(WEB3_DEFAULTS_PATH, yaml.dump(raw), "utf8");
  console.log(`Payment token set to: ${newToken}`);
}
