#!/usr/bin/env -S npx tsx
/**
 * Dev-only ErgoScript compilation helpers.
 *
 * The runtime engine ships pre-compiled ErgoTree templates in
 * src/ergo/contracts.ts and substitutes the server pubkey at deploy time —
 * no JRE or Ergo node compiler is needed on the host. The helpers below
 * are only used to (re)generate those templates from the canonical source
 * (SUBSCRIPTION_SCRIPT_SOURCE in src/ergo/contracts.ts) by talking to a
 * local Ergo node's /script/p2sAddress endpoint.
 *
 * Run this only when changing the contract logic; commit the resulting
 * ErgoTree hex back into contracts.ts.
 */

/** Convert compressed pubkey hex to Base64 for ErgoScript fromBase64() */
export function pubKeyHexToBase64(pubKeyHex: string): string {
  if (pubKeyHex.length !== 66) {
    throw new Error(`Expected 66 hex char compressed public key, got ${pubKeyHex.length} chars`);
  }
  return Buffer.from(pubKeyHex, "hex").toString("base64");
}

/**
 * Compile ErgoScript to P2S address via Ergo node.
 */
export async function compileToP2SAddress(
  nodeUrl: string,
  source: string,
  apiKey?: string,
): Promise<string> {
  const url = `${nodeUrl.replace(/\/+$/, "")}/script/p2sAddress`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["api_key"] = apiKey;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ source, treeVersion: 0 }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ErgoScript compilation failed (${res.status}): ${body}`);
  }

  return ((await res.json()) as { address: string }).address;
}
