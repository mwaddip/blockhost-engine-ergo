/**
 * Subscription box scanner -- core of subscription change detection.
 *
 * Queries the Ergo node for all unspent boxes matching the subscription
 * ErgoTree, parses their registers, and returns a diff against the
 * previously known state.
 *
 * Discovery method:
 *   1. Query node for unspent boxes by subscription ErgoTree
 *   2. For each box: verify it has a beacon token, decode registers
 *   3. Diff against known state: detect CREATED, EXTENDED, REMOVED events
 *
 * Removal is guarded by a two-phase confirmation process:
 *   1. Known beacons are only checked for removal every VERIFY_INTERVAL
 *      (2h prod / 1min testing). Regular 30s scans ignore absent beacons.
 *   2. When a beacon is absent during verification, it enters a pending
 *      removal state. It must be absent for CONFIRM_COUNT consecutive
 *      checks at CONFIRM_INTERVAL (2min prod / 10s testing) before the
 *      scanner emits a REMOVED event.
 *   3. If the beacon reappears in any scan (including regular discovery
 *      scans between confirmations), the pending removal is cancelled.
 */

import * as fs from "fs";
import type { ErgoProvider } from "../ergo/provider.js";
import type { SubscriptionState, ErgoBox } from "../ergo/types.js";
import { decodeSubscriptionRegisters } from "../ergo/registers.js";
import { VMS_JSON_PATH } from "../paths.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Represents a known subscription box */
export interface TrackedSubscription {
  /** Box ID (Ergo's unique box identifier) */
  boxId: string;
  /** Beacon token ID (unique per subscription) */
  beaconTokenId: string;
  /** Parsed subscription state from registers */
  state: SubscriptionState;
  /** Raw box (for spending in withdraw) */
  box: ErgoBox;
  /** Unix ms when first observed */
  firstSeen: number;
}

/** What changed between two consecutive scans */
export interface ScanDiff {
  /** New subscription boxes */
  created: TrackedSubscription[];
  /** Boxes that disappeared (beacon burned or box spent) */
  removed: TrackedSubscription[];
  /** Same beacon token, different box ID -- subscriber extended */
  extended: { old: TrackedSubscription; new: TrackedSubscription }[];
}

// ── VMS entry shape (subset of what vms.json stores) ─────────────────────────

export interface VmsEntry {
  /** Beacon token ID for this subscription */
  beacon_token_id?: string;
  /** Box ID where the subscription lives */
  box_id?: string;
}

// ── Removal confirmation constants ──────────────────────────────────────────

/** Consecutive absent checks required before emitting REMOVED */
const CONFIRM_COUNT = 3;

// ── Scanner class ────────────────────────────────────────────────────────────

export class SubscriptionScanner {
  private known: Map<string, TrackedSubscription>; // keyed by beaconTokenId
  private pendingRemovals: Map<
    string,
    { count: number; lastCheckAt: number; sub: TrackedSubscription }
  >;
  private lastVerify: number;

  /** How often to check known beacons for removal (2h prod / 1min testing) */
  private readonly verifyIntervalMs: number;
  /** Minimum gap between consecutive confirmation checks (2min prod / 10s testing) */
  private readonly confirmIntervalMs: number;

  constructor(
    private provider: ErgoProvider,
    private subscriptionErgoTree: string,
    testing: boolean,
  ) {
    this.known = new Map();
    this.pendingRemovals = new Map();
    this.lastVerify = 0;
    this.verifyIntervalMs = testing ? 60_000 : 2 * 60 * 60 * 1000;
    this.confirmIntervalMs = testing ? 10_000 : 2 * 60 * 1000;
  }

  /** Restore known beacons from vms.json on startup to prevent re-provisioning */
  restoreFromVms(vmsData: VmsEntry[]): void {
    for (const entry of vmsData) {
      const beaconTokenId = entry.beacon_token_id;
      if (!beaconTokenId) continue;

      // Insert a placeholder to mark this beacon as already processed.
      // State/box are placeholders -- they will be replaced on next scan
      // when the actual box is found on chain.
      this.known.set(beaconTokenId, {
        boxId: entry.box_id ?? "restored",
        beaconTokenId,
        state: {} as SubscriptionState,
        box: {} as ErgoBox,
        firstSeen: 0,
      });
    }

    if (this.known.size > 0) {
      console.log(
        `[SCANNER] Restored ${this.known.size} known beacon(s) from vms.json`,
      );
    }
  }

  /** Alternative: restore directly from vms.json file on disk */
  restoreFromFile(): void {
    try {
      if (!fs.existsSync(VMS_JSON_PATH)) return;
      const db = JSON.parse(
        fs.readFileSync(VMS_JSON_PATH, "utf8"),
      ) as Record<string, unknown>;
      const vms = (db["vms"] ?? {}) as Record<string, Record<string, unknown>>;
      const entries: VmsEntry[] = [];
      for (const vm of Object.values(vms)) {
        entries.push({
          beacon_token_id: vm["beacon_token_id"] as string | undefined,
          box_id: vm["box_id"] as string | undefined,
        });
      }
      this.restoreFromVms(entries);
    } catch {
      // vms.json not readable -- start fresh
    }
  }

  /** Run one scan cycle, return diff */
  async scan(): Promise<ScanDiff> {
    // ── Fetch current unspent boxes at the subscription ErgoTree ──────────
    let boxes: ErgoBox[];
    try {
      boxes = await this.provider.getUnspentBoxesByErgoTree(
        this.subscriptionErgoTree,
      );
    } catch (err) {
      console.error(
        `[SCANNER] ErgoTree query failed: ${err instanceof Error ? err.message : err}`,
      );
      return { created: [], removed: [], extended: [] };
    }

    // ── Build current beacon map ─────────────────────────────────────────
    const currentBeacons = new Map<string, TrackedSubscription>();

    for (const box of boxes) {
      // A subscription box must have at least one token (the beacon)
      if (!box.assets || box.assets.length === 0) continue;

      // The beacon token is the first token in the box
      const beaconAsset = box.assets[0];
      if (!beaconAsset) continue;
      const beaconTokenId = beaconAsset.tokenId;

      // Decode subscription state from registers
      const partial = decodeSubscriptionRegisters(box.additionalRegisters);

      // Require at minimum that planId was decoded (basic validity check)
      if (partial.planId === undefined) {
        console.warn(
          `[SCANNER] Skipping box ${box.boxId}: registers missing or unparseable`,
        );
        continue;
      }

      // Build full state by combining register data with box metadata
      const state: SubscriptionState = {
        planId: partial.planId,
        subscriber: partial.subscriber ?? "",
        amountRemaining: partial.amountRemaining ?? 0n,
        ratePerInterval: partial.ratePerInterval ?? 0n,
        intervalBlocks: partial.intervalBlocks ?? 0,
        lastCollectedHeight: partial.lastCollectedHeight ?? 0,
        expiryHeight: partial.expiryHeight ?? 0,
        paymentTokenId: partial.paymentTokenId ?? "",
        beaconTokenId,
        userEncrypted: partial.userEncrypted ?? "",
        creationHeight: box.creationHeight,
      };

      // If we've already seen this beacon in this scan (edge case: two boxes
      // carry the same beacon token), keep the first one we encounter.
      if (!currentBeacons.has(beaconTokenId)) {
        currentBeacons.set(beaconTokenId, {
          boxId: box.boxId,
          beaconTokenId,
          state,
          box,
          firstSeen: this.known.get(beaconTokenId)?.firstSeen ?? Date.now(),
        });
      }
    }

    // ── Compute diff ─────────────────────────────────────────────────────
    const diff: ScanDiff = { created: [], removed: [], extended: [] };
    const now = Date.now();
    const isVerifyTime = now - this.lastVerify >= this.verifyIntervalMs;

    // Detect created and extended
    for (const [beaconId, current] of currentBeacons) {
      const known = this.known.get(beaconId);
      if (!known) {
        diff.created.push(current);
      } else if (known.boxId !== current.boxId) {
        diff.extended.push({ old: known, new: current });
      }

      // Beacon is present -- cancel any pending removal
      if (this.pendingRemovals.has(beaconId)) {
        console.log(
          `[SCANNER] Beacon ${beaconId.slice(0, 16)}... reappeared -- cancelling pending removal`,
        );
        this.pendingRemovals.delete(beaconId);
      }
    }

    // Check known beacons that are absent from this scan
    for (const [beaconId, known] of this.known) {
      if (currentBeacons.has(beaconId)) continue;

      const pending = this.pendingRemovals.get(beaconId);

      if (!pending) {
        // Not yet pending -- only start tracking during verification passes
        if (isVerifyTime) {
          console.log(
            `[SCANNER] Beacon ${beaconId.slice(0, 16)}... absent during verification -- starting confirmation (1/${CONFIRM_COUNT})`,
          );
          this.pendingRemovals.set(beaconId, {
            count: 1,
            lastCheckAt: now,
            sub: known,
          });
        }
        // Between verifications: ignore the absence
      } else if (now - pending.lastCheckAt >= this.confirmIntervalMs) {
        // Already pending -- enough time for the next confirmation check
        pending.count++;
        pending.lastCheckAt = now;

        if (pending.count >= CONFIRM_COUNT) {
          console.log(
            `[SCANNER] Beacon ${beaconId.slice(0, 16)}... confirmed removed after ${pending.count} checks`,
          );
          diff.removed.push(pending.sub);
          this.pendingRemovals.delete(beaconId);
        } else {
          console.log(
            `[SCANNER] Beacon ${beaconId.slice(0, 16)}... still absent (${pending.count}/${CONFIRM_COUNT})`,
          );
        }
      }
      // else: pending but too soon for next confirmation -- wait
    }

    if (isVerifyTime) {
      this.lastVerify = now;
    }

    // ── Persist new state ────────────────────────────────────────────────
    // Start with beacons found on chain
    const newKnown = new Map<string, TrackedSubscription>();
    for (const [beaconId, sub] of currentBeacons) {
      newKnown.set(beaconId, sub);
    }
    // Preserve beacons that are pending removal (absent but unconfirmed)
    for (const [beaconId] of this.pendingRemovals) {
      if (!newKnown.has(beaconId)) {
        const old = this.known.get(beaconId);
        if (old) newKnown.set(beaconId, old);
      }
    }

    this.known = newKnown;

    return diff;
  }

  /** Get all currently known subscriptions */
  getKnown(): TrackedSubscription[] {
    return Array.from(this.known.values());
  }

  /** Get known subscriptions as a map (keyed by beaconTokenId) */
  getKnownMap(): Map<string, TrackedSubscription> {
    return new Map(this.known);
  }
}
