import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { LocalEngineService, LoggingService } from '@bizuri/offline-http';
import { LogsComponent } from '../logs/logs.component';
import { UnlockComponent } from '../unlock/unlock.component';

/**
 * Every request below uses plain HttpClient against the real contract paths.
 * OfflineHttpBackend intercepts by url and method, so this is exactly what the
 * generated @bizuri/api-client would produce, and proves the interception is
 * transparent to the caller.
 */

interface CatalogItem {
  itemId: string;
  itemCode: string;
  itemName: string;
  sellMode: string;
  sellingPrice: number | null;
  availableQty: number | null;
  taxCategoryRate: number | null;
  unitOfMeasureName: string | null;
}

interface CartLine {
  item: CatalogItem;
  quantity: number;
}

interface SaleDto {
  id: string;
  saleNumber: string;
  status: string;
  grandTotal: number;
  subtotal: number;
  taxTotal: number;
  createdAt: string;
}

@Component({
  selector: 'app-pos',
  standalone: true,
  imports: [CommonModule, FormsModule, UnlockComponent, LogsComponent],
  templateUrl: './pos.component.html',
  styleUrl: './pos.component.css',
})
export class PosComponent {
  private readonly http = inject(HttpClient);
  private readonly log = inject(LoggingService).getLogger('pos.component');
  readonly engine = inject(LocalEngineService);

  readonly tab = signal<'sell' | 'sales' | 'sync' | 'logs'>('sell');
  readonly search = signal('');
  readonly catalog = signal<CatalogItem[]>([]);
  readonly cart = signal<CartLine[]>([]);
  readonly sales = signal<SaleDto[]>([]);
  readonly busy = signal(false);
  readonly message = signal<{ kind: 'ok' | 'err'; text: string } | null>(null);

  readonly total = computed(() =>
    this.cart().reduce((sum, l) => sum + (l.item.sellingPrice ?? 0) * l.quantity, 0),
  );

  readonly canSell = computed(() => this.cart().length > 0 && !this.busy());

  constructor() {
    if (this.engine.status().tenantId) {
      void this.loadCatalog();
    }
  }

  onSignedIn(): void {
    void this.loadCatalog();
  }

  async loadCatalog(): Promise<void> {
    this.busy.set(true);
    try {
      const params = new HttpParams()
        .set('page', 0)
        .set('size', 50)
        .set('search', this.search());

      const res = await this.http
        .get<{ data: CatalogItem[] }>('/core/sales/catalog', { params })
        .toPromise();

      this.catalog.set(res?.data ?? []);
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(false);
    }
  }

  async loadSales(): Promise<void> {
    this.busy.set(true);
    try {
      const params = new HttpParams().set('page', 0).set('size', 25);
      const res = await this.http
        .get<{ data: SaleDto[] }>('/core/sales', { params })
        .toPromise();
      this.sales.set(res?.data ?? []);
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(false);
    }
  }

  add(item: CatalogItem): void {
    this.cart.update((lines) => {
      const existing = lines.find((l) => l.item.itemId === item.itemId);
      return existing
        ? lines.map((l) => (l.item.itemId === item.itemId ? { ...l, quantity: l.quantity + 1 } : l))
        : [...lines, { item, quantity: 1 }];
    });
  }

  changeQty(itemId: string, delta: number): void {
    this.cart.update((lines) =>
      lines
        .map((l) => (l.item.itemId === itemId ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );
  }

  clearCart(): void {
    this.cart.set([]);
  }

  async checkout(): Promise<void> {
    if (!this.canSell()) return;
    this.busy.set(true);
    this.message.set(null);

    const body = {
      intent: 'CONFIRM',
      lines: this.cart().map((l) => ({
        itemId: l.item.itemId,
        quantity: String(l.quantity),
      })),
      payments: [{ method: 'CASH', amount: this.total().toFixed(4) }],
    };

    try {
      const res = await this.http
        .post<{ data: SaleDto }>('/core/sales', body)
        .toPromise();

      const sale = res?.data;

      // A confirmation that reads "Sale undefined committed locally for
      // undefined" is worse than an error: the cashier is told the sale worked
      // and given nothing to write on the receipt. If the response is not the
      // shape we expect, say so and log the envelope we actually got, rather
      // than interpolating undefined into a reassuring sentence.
      if (!sale?.saleNumber) {
        this.log.error('Sale response was not the expected shape', undefined, {
          code: 'BAD_SALE_ENVELOPE',
          url: '/core/sales',
          context: { keys: res ? Object.keys(res) : [], received: typeof res },
        });
        this.message.set({
          kind: 'err',
          text:
            'The sale may have been saved, but the response could not be read. ' +
            'Check the Sales tab before re-entering it.',
        });
        return;
      }

      this.message.set({
        kind: 'ok',
        text: `Sale ${sale.saleNumber} committed locally for ${formatAmount(sale.grandTotal)}`,
      });
      this.clearCart();
      await Promise.all([this.loadCatalog(), this.engine.refresh()]);
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(false);
    }
  }

  async sync(): Promise<void> {
    this.busy.set(true);
    this.message.set(null);
    try {
      await this.engine.syncNow();
      this.message.set({ kind: 'ok', text: 'Sync complete' });
      await this.loadCatalog();
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(false);
    }
  }

  switchTab(tab: 'sell' | 'sales' | 'sync' | 'logs'): void {
    this.tab.set(tab);
    if (tab === 'sales') void this.loadSales();
    if (tab === 'sync') void this.engine.refresh();
  }

  private fail(err: unknown): void {
    const text =
      err instanceof HttpErrorResponse
        ? (err.error?.message ?? `Request failed (${err.status})`)
        : String(err);

    this.log.error(text, err, {
      ...(err instanceof HttpErrorResponse
        ? { code: String(err.status), url: err.url ?? null }
        : {}),
    });
    this.message.set({ kind: 'err', text });
  }
}

/** Money for a confirmation line. Zero is a real total; only absence is not. */
function formatAmount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : 'an unknown amount';
}
