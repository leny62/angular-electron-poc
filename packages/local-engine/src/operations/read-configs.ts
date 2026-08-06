/**
 * Reader configuration, one entry per generated route.
 *
 * Derivable from the TableDescriptor plus the operation's declared query
 * parameters, so the generator emits this file wholesale.
 */

import {
  rowToCustomer,
  rowToReceipt,
  rowToSalesCatalogItem,
  rowToStockBalance,
  rowToTaxCategory,
} from '@bizuri/local-store';
import type {
  CustomerRow,
  ReceiptRow,
  SaleLineRow,
  SalePaymentRow,
  SaleRow,
  SalesCatalogItemRow,
  StockBalanceRow,
  TaxCategoryRow,
} from '@bizuri/local-store';
import { rowToSale } from '@bizuri/local-store';
import type { OperationContext, OperationResult } from '../contracts';
import type { SqliteDatabase } from '../store/types';
import { makeReplicaGet, makeReplicaList } from './replica-readers';
import { loadSale } from './create-sale';

type Db = () => SqliteDatabase;

export function buildReaders(db: Db): Record<string, (ctx: OperationContext) => OperationResult<unknown>> {
  return {
    listSalesCatalog: makeReplicaList<SalesCatalogItemRow, unknown>(db, {
      table: 'sales_catalog',
      scope: ['tenant', 'branch'],
      baseWhere: 'deleted = 0',
      filters: {
        search: ['item_name', 'item_code', 'barcode'],
        equals: { sellMode: 'sell_mode' },
      },
      orderBy: 'item_name ASC',
      envelope: 'bare-page',
      map: rowToSalesCatalogItem,
    }),

    listStockBalances: makeReplicaList<StockBalanceRow, unknown>(db, {
      table: 'stock_balances',
      scope: ['tenant', 'branch'],
      baseWhere: 'deleted = 0',
      filters: { search: ['item_name', 'item_code'] },
      orderBy: 'item_name ASC',
      envelope: 'bare-page',
      map: rowToStockBalance,
    }),

    lookupStockBalance: makeReplicaGet<StockBalanceRow, unknown>(db, {
      table: 'stock_balances',
      scope: ['tenant', 'branch'],
      baseWhere: 'deleted = 0',
      lookup: [
        { param: 'itemId', column: 'item_id' },
        { param: 'barcode', column: 'item_code' },
        { param: 'itemCode', column: 'item_code' },
      ],
      envelope: 'bare-page',
      map: rowToStockBalance,
      notFoundLabel: 'Item',
    }),

    listTaxCategories: makeReplicaList<TaxCategoryRow, unknown>(db, {
      table: 'tax_categories',
      scope: ['tenant'],
      baseWhere: 'deleted = 0',
      filters: { search: ['name'] },
      orderBy: 'name ASC',
      envelope: 'wrapped-page',
      map: rowToTaxCategory,
    }),

    getTaxCategory: makeReplicaGet<TaxCategoryRow, unknown>(db, {
      table: 'tax_categories',
      scope: ['tenant'],
      baseWhere: 'deleted = 0',
      lookup: [{ param: 'taxCategoryId', column: 'id' }],
      envelope: 'wrapped-object',
      map: rowToTaxCategory,
      notFoundLabel: 'Tax category',
    }),

    listCustomers: makeReplicaList<CustomerRow, unknown>(db, {
      table: 'customers',
      scope: ['tenant'],
      baseWhere: 'deleted = 0',
      filters: {
        search: ['name', 'primary_phone', 'tin'],
        equals: { status: 'status' },
      },
      orderBy: 'name ASC',
      envelope: 'wrapped-page',
      map: rowToCustomer,
    }),

    getCustomer: makeReplicaGet<CustomerRow, unknown>(db, {
      table: 'customers',
      scope: ['tenant'],
      baseWhere: 'deleted = 0',
      // server_id too: the renderer may hold either identifier depending on
      // whether the customer has synced yet.
      lookup: [
        { param: 'customerId', column: 'id' },
        { param: 'customerId', column: 'server_id' },
      ],
      envelope: 'wrapped-object',
      map: rowToCustomer,
      notFoundLabel: 'Customer',
    }),

    listSales: makeReplicaList<SaleRow, unknown>(db, {
      table: 'sales',
      scope: ['tenant'],
      filters: {
        search: ['sale_number', 'client_full_name', 'client_phone'],
        equals: { status: 'status', branchId: 'branch_id', customerId: 'customer_id' },
        from: { fromDate: 'created_at' },
        to: { toDate: 'created_at' },
      },
      orderBy: 'created_at DESC',
      envelope: 'wrapped-page',
      map: (row) => shallowSale(row),
    }),

    getSale: (ctx: OperationContext): OperationResult<unknown> => {
      const saleId = ctx.request.pathParams['saleId'] as string;
      const handle = db();
      const row = handle
        .prepare(
          'SELECT id FROM sales WHERE tenant_id = ? AND (id = ? OR server_id = ?) LIMIT 1',
        )
        .get(ctx.tenantId, saleId, saleId) as { id: string } | undefined;

      if (!row) {
        return {
          status: 404,
          data: { success: false, message: 'Sale not found', errorCode: 'RESOURCE_NOT_FOUND' },
        };
      }
      return {
        status: 200,
        data: { success: true, message: 'Request successful', data: loadSale(handle, row.id) },
      };
    },

    listReceipts: makeReplicaList<ReceiptRow, unknown>(db, {
      table: 'receipts',
      scope: ['tenant'],
      filters: { search: ['receipt_number'] },
      orderBy: 'seq DESC',
      envelope: 'wrapped-page',
      map: rowToReceipt,
    }),

    getReceipt: makeReplicaGet<ReceiptRow, unknown>(db, {
      table: 'receipts',
      scope: ['tenant'],
      lookup: [{ param: 'receiptNumber', column: 'receipt_number' }],
      envelope: 'wrapped-object',
      map: rowToReceipt,
      notFoundLabel: 'Receipt',
    }),
  };
}

/**
 * Sale summary without child rows.
 *
 * A list of 20 sales would otherwise run 40 extra queries for lines and
 * payments that the list view never renders.
 */
function shallowSale(row: SaleRow) {
  return rowToSale(row, [] as SaleLineRow[], [] as SalePaymentRow[]);
}
