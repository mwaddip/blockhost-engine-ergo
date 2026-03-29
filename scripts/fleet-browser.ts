/**
 * Fleet SDK browser bundle for Ergo signup page and wizard.
 *
 * Bundled by esbuild into a self-contained browser script that exposes
 * Fleet SDK on window.Fleet. No CDN dependency — works offline on ISOs.
 *
 * Usage in HTML:
 *   <script src="fleet-sdk.browser.js"></script>
 *   <script>
 *     var tx = new Fleet.TransactionBuilder(height)
 *       .from(utxos)
 *       .to(new Fleet.OutputBuilder(value, address))
 *       .sendChangeTo(changeAddr)
 *       .payMinFee()
 *       .build();
 *     var eip12 = tx.toEIP12Object();
 *   </script>
 */

import {
  TransactionBuilder,
  OutputBuilder,
  SAFE_MIN_BOX_VALUE,
  RECOMMENDED_MIN_FEE_VALUE,
} from "@fleet-sdk/core";

import {
  SInt,
  SLong,
  SByte,
  SColl,
  SPair,
} from "@fleet-sdk/serializer";

import { hex } from "@fleet-sdk/crypto";

(window as any).Fleet = {
  TransactionBuilder,
  OutputBuilder,
  SAFE_MIN_BOX_VALUE,
  RECOMMENDED_MIN_FEE_VALUE,
  SInt,
  SLong,
  SByte,
  SColl,
  SPair,
  hex,
};
