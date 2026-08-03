/**
 * Catalog command handlers.
 *
 * catalog.search — search the local catalog_item snapshot by code,
 *   name, or barcode.  The catalog is a read-side snapshot refreshed
 *   by the pull worker; commands never write to it directly.
 */

import type { CommandEnvelope } from '../../shared/contracts';
import type { SqliteDatabase } from '../../database/types';

export interface CatalogItem {
  itemId: string;
  branchId: string;
  itemCode: string;
  itemName: string;
  barcode: string | null;
  sellingPrice: string;
  discount: string;
  taxCategoryName: string | null;
  taxCategoryRate: string;
  availableQty: string;
  sellMode: string;
  updatedAt: string;
}

export interface CatalogSearchResult {
  items: CatalogItem[];
  total: number;
}

export interface CatalogContext {
  readonly db: () => SqliteDatabase;
  readonly branchId: string;
}

export function handleCatalogSearch(
  payload: unknown,
  _envelope: CommandEnvelope,
  ctx: CatalogContext,
): CatalogSearchResult {
  const db = ctx.db();
  const { query = '', limit = 25, offset = 0 } = (payload as {
    query?: string;
    limit?: number;
    offset?: number;
  }) ?? {};

  const searchPattern = `%${query}%`;

  const sql = `
    SELECT item_id AS itemId, branch_id AS branchId,
      item_code AS itemCode, item_name AS itemName,
      barcode, selling_price AS sellingPrice,
      discount, tax_category_name AS taxCategoryName,
      tax_category_rate AS taxCategoryRate,
      available_qty AS availableQty,
      sell_mode AS sellMode, updated_at AS updatedAt
    FROM catalog_item
    WHERE branch_id = ?
      AND (item_code LIKE ? OR item_name LIKE ? OR barcode LIKE ?)
    ORDER BY item_name ASC
    LIMIT ? OFFSET ?
  `;

  const items = db.prepare(sql).all(
    ctx.branchId,
    searchPattern,
    searchPattern,
    searchPattern,
    limit,
    offset,
  ) as unknown as CatalogItem[];

  const countRow = db.prepare(`
    SELECT COUNT(*) AS total FROM catalog_item
    WHERE branch_id = ?
      AND (item_code LIKE ? OR item_name LIKE ? OR barcode LIKE ?)
  `).get(ctx.branchId, searchPattern, searchPattern, searchPattern) as { total: number };

  return { items, total: countRow.total };
}
