/**
 * ab up <name> <address> — Update entry's address in addressbook
 *
 * Accepts Base58-encoded Ergo addresses.
 * Preserves existing keyfile if present.
 */

import { loadAddressbook } from "../../bw/cli-utils.js";
import { addressbookSave } from "../../root-agent/client.js";
import { isValidAddress } from "../../ergo/address.js";
import { assertMutableRole } from "../index.js";

export async function upCommand(args: string[]): Promise<void> {
  if (args.length !== 2) {
    console.error("Usage: ab up <name> <address>");
    process.exit(1);
  }

  const [name, rawAddress] = args;
  if (!name || !rawAddress) {
    console.error("Usage: ab up <name> <address>");
    process.exit(1);
  }

  assertMutableRole(name);

  if (!isValidAddress(rawAddress)) {
    console.error(
      `Error: '${rawAddress}' is not a valid Ergo address (expected Base58-encoded address).`,
    );
    process.exit(1);
  }

  const book = loadAddressbook();

  if (!book[name]) {
    console.error(
      `Error: '${name}' not found in addressbook. Use 'ab add ${name} <address>' to create.`,
    );
    process.exit(1);
  }

  const entry = book[name];
  if (entry) {
    entry.address = rawAddress;
  }
  await addressbookSave(book as Record<string, unknown>);
  console.log(`Updated '${name}' → ${rawAddress}`);
}
