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
import { ergoTreeFromAddress } from "./address.js";

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

interface NodeInfoResponse {
  fullHeight: number;
}

interface NodeBoxResponse {
  boxId: string;
  transactionId: string;
  index: number;
  value: number | string;
  ergoTree: string;
  creationHeight: number;
  assets: Array<{ tokenId: string; amount: number | string }>;
  additionalRegisters: Record<string, string>;
}

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

/** Normalize a node box response into our ErgoBox type. */
function normalizeNodeBox(raw: NodeBoxResponse): ErgoBox {
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
    additionalRegisters: raw.additionalRegisters,
  };
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
  private readonly nodeUrl: string;
  private readonly explorerUrl: string;

  constructor(nodeUrl: string, explorerUrl: string) {
    this.nodeUrl = trimUrl(nodeUrl);
    this.explorerUrl = trimUrl(explorerUrl);
  }

  private assertSecureForSecrets(): void {
    const url = new URL(this.nodeUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      throw new Error("Refusing to send secrets to a non-localhost HTTP node. Use HTTPS or localhost.");
    }
  }

  // -- Node helpers --

  private async nodeGet<T>(path: string): Promise<T> {
    const url = `${this.nodeUrl}${path}`;
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Node GET ${path} failed (${res.status}): ${body}`);
    }
    return (await res.json()) as T;
  }

  private async nodePost<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.nodeUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Node POST ${path} failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
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
    const info = await this.nodeGet<NodeInfoResponse>("/info");
    return info.fullHeight;
  }

  async getUnspentBoxes(address: string): Promise<ErgoBox[]> {
    const ergoTree = ergoTreeFromAddress(address);
    return this.getUnspentBoxesByErgoTree(ergoTree);
  }

  async getUnspentBoxesByErgoTree(ergoTree: string): Promise<ErgoBox[]> {
    const all: ErgoBox[] = [];
    const limit = 500;
    let offset = 0;
    while (true) {
      const boxes = await this.nodePost<NodeBoxResponse[]>(
        `/blockchain/box/unspent/byErgoTree?offset=${offset}&limit=${limit}`,
        ergoTree,
      );
      all.push(...boxes.map(normalizeNodeBox));
      if (boxes.length < limit) break;
      offset += limit;
    }
    return all;
  }

  async submitTx(signedTx: unknown): Promise<string> {
    // Node returns the transaction ID as a JSON string
    const txId = await this.nodePost<string>("/transactions", signedTx);
    return txId;
  }

  async signTx(
    unsignedTx: unknown,
    secrets: string[],
    inputsRaw?: string[],
  ): Promise<unknown> {
    this.assertSecureForSecrets();
    const body: Record<string, unknown> = {
      tx: unsignedTx,
      secrets: { dlog: secrets },
    };
    if (inputsRaw && inputsRaw.length > 0) {
      body["inputsRaw"] = inputsRaw;
    }
    return this.nodePost<unknown>("/wallet/transaction/sign", body);
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
    // Try the node first (faster, exact box lookup)
    try {
      const raw = await this.nodeGet<NodeBoxResponse>(
        `/utxo/byId/${boxId}`,
      );
      return normalizeNodeBox(raw);
    } catch {
      // Fall back to explorer (also returns spent boxes)
      const raw = await this.explorerGet<ExplorerBoxResponse>(
        `/boxes/${boxId}`,
      );
      return normalizeExplorerBox(raw);
    }
  }

  async getBoxesByTokenId(tokenId: string): Promise<ErgoBox[]> {
    assertSafePathSegment(tokenId, "tokenId");
    const all: ErgoBox[] = [];
    const limit = 500;
    let offset = 0;
    while (true) {
      const res = await this.explorerGet<ExplorerBoxListResponse>(
        `/boxes/byTokenId/${tokenId}/unspent?offset=${offset}&limit=${limit}`,
      );
      all.push(...res.items.map(normalizeExplorerBox));
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
export function createProvider(nodeUrl: string, explorerUrl: string): ErgoProvider {
  return new ErgoProviderImpl(nodeUrl, explorerUrl);
}
