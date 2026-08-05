/**
 * Hydration tiers.
 *
 * GENERATOR TARGET.  Emitted from `x-offline.hydrationTier` on each schema.
 *
 * The tier decides what the POS waits for on a cold start.  This is the
 * difference between "sell in 4 seconds" and "watch a spinner for a minute in
 * front of a customer", so it is a first-class part of the contract rather than
 * a runtime heuristic.
 *
 * Tier 1 must be complete before the engine reports READY.  Tiers 2 and 3
 * stream in behind it, and the UI degrades gracefully for each: no customer
 * list means walk-in only, no sales history means the Sales tab shows a
 * loading state.  Neither blocks a sale.
 */

import type { TableDescriptor } from './types';
import {
  CUSTOMERS,
  SALES,
  SALES_CATALOG,
  STOCK_BALANCES,
  TAX_CATEGORIES,
} from './tables';

export type HydrationTier = 1 | 2 | 3;

export interface TierAssignment {
  readonly tier: HydrationTier;
  readonly table: TableDescriptor;
  /**
   * What the renderer should show while this tier is still loading.  Null for
   * tier 1, because tier 1 gates READY: the user sees the unlock/hydration
   * screen, not a degraded POS.
   */
  readonly degradedMode: string | null;
}

export const HYDRATION_PLAN: readonly TierAssignment[] = [
  // ── Tier 1: the POS cannot sell without these ──────────────────────────
  { tier: 1, table: SALES_CATALOG, degradedMode: null },
  { tier: 1, table: STOCK_BALANCES, degradedMode: null },
  { tier: 1, table: TAX_CATEGORIES, degradedMode: null },

  // ── Tier 2: the POS can sell, with a reduced feature set ───────────────
  {
    tier: 2,
    table: CUSTOMERS,
    degradedMode: 'Customer lookup unavailable. Walk-in sales only.',
  },

  // ── Tier 3: history and reporting, never blocks selling ───────────────
  {
    tier: 3,
    table: SALES,
    degradedMode: 'Sales history still loading.',
  },
];

export const TIER_1_TABLES: readonly string[] = HYDRATION_PLAN.filter(
  (a) => a.tier === 1,
).map((a) => a.table.table);

export function tierFor(table: string): HydrationTier | undefined {
  return HYDRATION_PLAN.find((a) => a.table.table === table)?.tier;
}

/**
 * Tables to hydrate, ordered by tier.  Within a tier the order is the
 * declaration order above, which keeps the sequence deterministic and therefore
 * testable.
 */
export function hydrationOrder(): readonly TableDescriptor[] {
  return [...HYDRATION_PLAN].sort((a, b) => a.tier - b.tier).map((a) => a.table);
}

/**
 * How far back tier 3 pulls.  Unbounded history on a shop that has been
 * trading for three years is gigabytes; 90 days covers reprints, refunds, and
 * end-of-month reconciliation, which is everything a cashier does offline.
 */
export const TIER_3_HISTORY_DAYS = 90;
