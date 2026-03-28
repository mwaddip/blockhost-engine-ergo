/**
 * ab list — Show all addressbook entries
 */

import { loadAddressbook } from "../../bw/cli-utils.js";

export function listCommand(): void {
  const book = loadAddressbook();
  console.log(JSON.stringify(book, null, 2));
}
