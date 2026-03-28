/**
 * Ergo API client wrapping fetch().
 *
 * Talks to two sources:
 *   - Ergo Node API (primary): box queries, tx signing, tx submission
 *   - Ergo Explorer API (indexed): balances, token metadata, tx history
 *
 * Signing architecture: the node's /wallet/transaction/sign endpoint handles
 * Schnorr/Sigma protocol complexity. We pass the unsigned tx + private key(s)
 * and the node returns the signed tx. No WASM or custom Sigma implementation
 * is needed.
 */

import type { ErgoBox } from "./types.js";


// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface TokenInfo {
  id: string;
  boxId: string;       // issuance box
  name: string;
  description: string;
  decimals: number;
  emissionAmount: bigint;
}

export interface BalanceInfo {
  nanoErg: bigint;
  tokens: Array<{
    tokenId: string;
    amount: bigint;
    name?: string;
    decimals?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface ErgoProvider {
  /** Get current blockchain height from the node. */
  getHeight(): Promise<number>;

  /** Get unspent boxes for an address (via node, using ErgoTree lookup). */
  getUnspentBoxes(address: string): Promise<ErgoBox[]>;

  /** Get unspent boxes by raw ErgoTree hex (node endpoint). */
  getUnspentBoxesByErgoTree(ergoTree: string): Promise<ErgoBox[]>;

  /** Submit a signed transaction to the node. Returns the transaction ID. */
  submitTx(signedTx: unknown): Promise<string>;

  /**
   * Sign an unsigned transaction using the node's wallet endpoint.
   * @param unsignedTx  The unsigned transaction object
   * @param secrets     Array of hex-encoded private keys (dlog secrets)
   * @param inputsRaw   Optional array of serialized input box hex strings
   * @returns The signed transaction object
   */
  signTx(unsignedTx: unknown, secrets: string[], inputsRaw?: string[]): Promise<unknown>;

  /** Get token metadata from the explorer. */
  getToken(tokenId: string): Promise<TokenInfo>;

  /** Get address balance (nanoErg + tokens) from the explorer. */
  getBalance(address: string): Promise<BalanceInfo>;

  /** Get transaction history for an address from the explorer. */
  getTransactions(address: string, offset: number, limit: number): Promise<unknown[]>;

  /** Get a specific box by ID from the node. */
  getBox(boxId: string): Promise<ErgoBox>;

  /** Get unspent boxes containing a specific token from the explorer. */
  getBoxesByTokenId(tokenId: string): Promise<ErgoBox[]>;
}

// ---------------------------------------------------------------------------
// JSON response types (internal, matching API shapes)
// ---------------------------------------------------------------------------


interface ExplorerTokenResponse {
  id: string;
  boxId: string;
  name: string;
  description: string;
  decimals: number;
  emissionAmount: number | string;
}

interface ExplorerBalanceResponse {
  confirmed: {
    nanoErgs: number | string;
    tokens: Array<{
      tokenId: string;
      amount: number | string;
      name?: string;
      decimals?: number;
    }>;
  };
}

interface ExplorerBoxResponse {
  boxId: string;
  transactionId: string;
  index: number;
  value: number | string;
  ergoTree: string;
  creationHeight: number;
  assets: Array<{ tokenId: string; amount: number | string }>;
  additionalRegisters: Record<string, { serializedValue: string } | string>;
}

interface ExplorerTxListResponse {
  items: unknown[];
  total: number;
}

interface ExplorerBoxListResponse {
  items: ExplorerBoxResponse[];
  total: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a JSON number or string into bigint. */
function toBigInt(value: number | string | bigint): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(value);
}

/** Normalize an explorer box response into our ErgoBox type. */
function normalizeExplorerBox(raw: ExplorerBoxResponse): ErgoBox {
  // Explorer returns registers as either { serializedValue: "hex" } objects
  // or plain hex strings depending on the endpoint
  const regs: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw.additionalRegisters)) {
    if (typeof val === "string") {
      regs[key] = val;
    } else if (val && typeof val === "object" && "serializedValue" in val) {
      regs[key] = val.serializedValue;
    }
  }

  return {
    boxId: raw.boxId,
    transactionId: raw.transactionId,
    index: raw.index,
    value: toBigInt(raw.value),
    ergoTree: raw.ergoTree,
    creationHeight: raw.creationHeight,
    assets: raw.assets.map((a) => ({
      tokenId: a.tokenId,
      amount: toBigInt(a.amount),
    })),
    additionalRegisters: regs,
  };
}

/** Strip trailing slashes from a URL. */
function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Reject values that could manipulate URL paths. */
function assertSafePathSegment(value: string, name: string): void {
  if (/[\/\?#]|\.\./.test(value)) {
    throw new Error(`Invalid ${name}: contains illegal URL characters`);
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class ErgoProviderImpl implements ErgoProvider {
  private readonly explorerUrl: string;
  private readonly signerUrl: string;
  private readonly submitUrl?: string;

  constructor(explorerUrl: string, signerUrl?: string, submitUrl?: string) {
    this.explorerUrl = trimUrl(explorerUrl);
    this.signerUrl = trimUrl(signerUrl ?? "http://127.0.0.1:9064");
    this.submitUrl = submitUrl ? trimUrl(submitUrl) : undefined;
  }

  private assertSecureForSecrets(): void {
    const url = new URL(this.signerUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      throw new Error("Refusing to send secrets to a non-localhost HTTP signer. Use HTTPS or localhost.");
    }
  }

  // -- Explorer helpers --

  private async explorerGet<T>(path: string): Promise<T> {
    const url = `${this.explorerUrl}/api/v1${path}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Explorer GET ${path} failed (${res.status}): ${body}`);
    }
    return (await res.json()) as T;
  }

  // -- ErgoProvider interface --

  async getHeight(): Promise<number> {
    // Use explorer for height — no node needed
    const info = await this.explorerGet<{ height: number }>("/info");
    return info.height;
  }

  async getUnspentBoxes(address: string): Promise<ErgoBox[]> {
    assertSafePathSegment(address, "address");
    const all: ErgoBox[] = [];
    const limit = 500;
    let offset = 0;
    while (true) {
      const resp = await this.explorerGet<ExplorerBoxListResponse>(
        `/boxes/unspent/byAddress/${address}?offset=${offset}&limit=${limit}`,
      );
      all.push(...resp.items.map(normalizeExplorerBox));
      if (resp.items.length < limit) break;
      offset += limit;
    }
    return all;
  }

  async getUnspentBoxesByErgoTree(ergoTree: string): Promise<ErgoBox[]> {
    assertSafePathSegment(ergoTree, "ergoTree");
    const all: ErgoBox[] = [];
    const limit = 500;
    let offset = 0;
    while (true) {
      const resp = await this.explorerGet<ExplorerBoxListResponse>(
        `/boxes/unspent/byErgoTree/${ergoTree}?offset=${offset}&limit=${limit}`,
      );
      all.push(...resp.items.map(normalizeExplorerBox));
      if (resp.items.length < limit) break;
      offset += limit;
    }
    return all;
  }

  async submitTx(signedTx: unknown): Promise<string> {
    const txJson = JSON.stringify(signedTx, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );

    // Build list of submission endpoints to try in order
    const endpoints: string[] = [];

    // 1. Configured submit_url (if set — e.g. a known reliable node)
    if (this.submitUrl) {
      endpoints.push(`${this.submitUrl}/transactions`);
    }

    // 2. ergo-relay P2P broadcast (if signer has /transactions endpoint)
    endpoints.push(`${this.signerUrl}/transactions`);

    // 3. Explorer mempool relay
    endpoints.push(`${this.explorerUrl}/api/v1/mempool/transactions/submit`);

    // 4. Local Ergo node (if running)
    endpoints.push("http://127.0.0.1:9053/transactions");
    endpoints.push("http://127.0.0.1:9052/transactions");

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: txJson,
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const data = await res.json() as { id: string } | string;
          return typeof data === "string" ? data : data.id;
        }
        // 400 = tx rejected (bad tx, not a connectivity issue)
        if (res.status === 400) {
          const text = await res.text().catch(() => "");
          throw new Error(`Transaction rejected: ${text}`);
        }
        // Other errors (403, 500, etc) — try next endpoint
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Transaction rejected")) throw err;
        // Timeout or network error — try next
      }
    }

    throw new Error("Transaction submission failed: all endpoints unreachable");
  }

  async signTx(
    unsignedTx: unknown,
    secrets: string[],
    inputsRaw?: string[],
  ): Promise<unknown> {
    this.assertSecureForSecrets();
    // Convert Fleet SDK tx to EIP-12 format if needed
    const tx = typeof (unsignedTx as any)?.toEIP12Object === "function"
      ? (unsignedTx as any).toEIP12Object()
      : unsignedTx;
    // Fetch current height for scripts that use HEIGHT (like subscription guard)
    let height: number | undefined;
    try {
      height = await this.getHeight();
    } catch { /* non-fatal — signer will use 0 */ }

    const body: Record<string, unknown> = {
      tx,
      secrets: { dlog: secrets },
      height,
    };
    if (inputsRaw && inputsRaw.length > 0) {
      body["inputsRaw"] = inputsRaw;
    }
    // Sign via ergo-relay (separate from node — no JRE needed)
    const url = `${this.signerUrl}/wallet/transaction/sign`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Signer POST /wallet/transaction/sign failed (${res.status}): ${text}`);
    }
    return (await res.json()) as unknown;
  }

  async getToken(tokenId: string): Promise<TokenInfo> {
    assertSafePathSegment(tokenId, "tokenId");
    const raw = await this.explorerGet<ExplorerTokenResponse>(
      `/tokens/${tokenId}`,
    );
    return {
      id: raw.id,
      boxId: raw.boxId,
      name: raw.name,
      description: raw.description,
      decimals: raw.decimals,
      emissionAmount: toBigInt(raw.emissionAmount),
    };
  }

  async getBalance(address: string): Promise<BalanceInfo> {
    assertSafePathSegment(address, "address");
    const raw = await this.explorerGet<ExplorerBalanceResponse>(
      `/addresses/${address}/balance/total`,
    );
    return {
      nanoErg: toBigInt(raw.confirmed.nanoErgs),
      tokens: raw.confirmed.tokens.map((t) => ({
        tokenId: t.tokenId,
        amount: toBigInt(t.amount),
        name: t.name,
        decimals: t.decimals,
      })),
    };
  }

  async getTransactions(
    address: string,
    offset: number,
    limit: number,
  ): Promise<unknown[]> {
    assertSafePathSegment(address, "address");
    const raw = await this.explorerGet<ExplorerTxListResponse>(
      `/addresses/${address}/transactions?offset=${offset}&limit=${limit}`,
    );
    return raw.items;
  }

  async getBox(boxId: string): Promise<ErgoBox> {
    assertSafePathSegment(boxId, "boxId");
    const raw = await this.explorerGet<ExplorerBoxResponse>(
      `/boxes/${boxId}`,
    );
    return normalizeExplorerBox(raw);
  }

  async getBoxesByTokenId(tokenId: string): Promise<ErgoBox[]> {
    assertSafePathSegment(tokenId, "tokenId");
    const all: ErgoBox[] = [];
    const limit = 500;
    let offset = 0;
    while (true) {
      // Use /boxes/byTokenId/{id} (returns both spent and unspent)
      // and filter for unspent (spentTransactionId === null)
      // Explorer caps limit at 100 for this endpoint
      const pageLimit = Math.min(limit, 100);
      const res = await this.explorerGet<ExplorerBoxListResponse>(
        `/boxes/byTokenId/${tokenId}?offset=${offset}&limit=${pageLimit}`,
      );
      const unspent = res.items.filter(
        (b) => !(b as any).spentTransactionId,
      );
      all.push(...unspent.map(normalizeExplorerBox));
      if (res.items.length < limit) break;
      offset += limit;
    }
    return all;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ErgoProvider from node and explorer URLs.
 */
export function createProvider(
  explorerUrl: string,
  signerUrl?: string,
  submitUrl?: string,
): ErgoProvider {
  return new ErgoProviderImpl(explorerUrl, signerUrl, submitUrl);
}
