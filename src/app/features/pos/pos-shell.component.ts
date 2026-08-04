import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { NgIf, NgFor, NgClass, DecimalPipe, SlicePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { LocalBridgeService } from '../../core/services/local-bridge.service';
import { TransportRouter } from '../../core/services/transport-router.service';
import type { CommandResult } from '../../core/interfaces/local-bridge.interface';

interface CatalogItem {
  itemId: string; itemCode: string; itemName: string;
  sellingPrice: string; availableQty: string; sellMode: string;
}

interface CartLine {
  itemId: string; itemCode: string; itemName: string;
  unitPrice: string; quantity: number;
}

interface SaleRow {
  id: string; saleNumber: string; status: string; syncState: string;
  grandTotal: string; clientName: string | null; createdAt: string;
}

type Tab = 'catalog' | 'cart' | 'sales' | 'sync';

@Component({
  selector: 'app-pos-shell',
  standalone: true,
  imports: [NgIf, NgFor, NgClass, DecimalPipe, SlicePipe, FormsModule],
  template: `
    <div class="pos-layout">
      <header class="pos-header">
        <div class="header-left">
          <h1 class="pos-title">Bizuri PoC</h1>
          <span class="status-badge" [class.ok]="engineState() === 'READY'" [class.warn]="engineState() !== 'READY'">
            {{ engineState() }}
          </span>
        </div>
        <div class="header-right">
          <span class="transport-badge" [class.online]="transportMode() === 'online'" [class.offline]="transportMode() === 'offline'">
            {{ transportMode() === 'online' ? 'Online' : 'Offline' }}
          </span>
          <span class="pending-badge" *ngIf="pendingCount() > 0">
            {{ pendingCount() }} pending
          </span>
          <span class="contract-ver">v{{ contractVersion() }}</span>
        </div>
      </header>

      <nav class="pos-tabs">
        <button
          *ngFor="let t of tabs"
          class="tab-btn"
          [class.active]="activeTab() === t.id"
          (click)="activeTab.set(t.id)"
        >
          {{ t.label }}
          <span class="tab-badge" *ngIf="t.id === 'cart' && cart.length">({{ cart.length }})</span>
        </button>
      </nav>

      <main class="pos-main">
        <section class="tab-panel" *ngIf="activeTab() === 'catalog'">
          <div class="panel-header">
            <h2>Catalog</h2>
            <input
              type="text"
              placeholder="Search items…"
              [(ngModel)]="catalogQuery"
              (input)="searchCatalog()"
              autofocus
            />
          </div>

          <div class="catalog-grid" *ngIf="catalogItems().length">
            <div
              class="catalog-card"
              *ngFor="let item of catalogItems()"
              (click)="addToCart(item)"
            >
              <div class="item-name">{{ item.itemName }}</div>
              <div class="item-code">{{ item.itemCode }}</div>
              <div class="item-footer">
                <span class="item-price">{{ item.sellingPrice }} RWF</span>
                <span class="item-stock" [class.low]="+item.availableQty < 10">
                  {{ item.availableQty }} {{ item.sellMode === 'WEIGHT' ? 'kg' : 'units' }}
                </span>
              </div>
            </div>
          </div>
          <div class="empty-state" *ngIf="!loadingCatalog() && !catalogItems().length">
            No items found.
          </div>
        </section>

        <section class="tab-panel" *ngIf="activeTab() === 'cart'">
          <div class="panel-header">
            <h2>Cart</h2>
            <button class="btn-sm btn-danger-outline" *ngIf="cart.length" (click)="clearCart()">Clear</button>
          </div>

          <div class="cart-table" *ngIf="cart.length">
            <div class="cart-row cart-header-row">
              <span>Item</span><span>Price</span><span>Qty</span><span>Line</span><span></span>
            </div>
            <div class="cart-row" *ngFor="let line of cart; let i = index">
              <span class="cart-item-name">{{ line.itemName }}</span>
              <span class="cart-price">{{ line.unitPrice }}</span>
              <span>
                <input type="number" class="qty-input" [ngModel]="line.quantity"
                  (ngModelChange)="updateQty(i, $event)" min="0.001" step="1" />
              </span>
              <span class="cart-line-total">{{ lineTotal(line) }} RWF</span>
              <span><button class="btn-icon" (click)="removeFromCart(i)" title="Remove">&times;</button></span>
            </div>
          </div>

          <div class="empty-state" *ngIf="!cart.length">
            Select items from the Catalog tab.
          </div>

          <div class="cart-summary" *ngIf="cart.length">
            <div class="summary-row">
              <span>Total</span>
              <strong>{{ cartTotal() }} RWF</strong>
            </div>
            <div class="summary-row">
              <label for="amountPaid">Amount paid</label>
              <input id="amountPaid" type="number" [(ngModel)]="amountPaid"
                class="amount-input" placeholder="0" min="0" />
            </div>
            <button class="btn-primary btn-full" (click)="checkout()" [disabled]="checkingOut()">
              {{ checkingOut() ? 'Processing…' : 'Complete Sale' }}
            </button>
            <p class="checkout-error" *ngIf="checkoutError()">{{ checkoutError() }}</p>
          </div>
        </section>

        <section class="tab-panel" *ngIf="activeTab() === 'sales'">
          <div class="panel-header">
            <h2>Recent Sales</h2>
            <button class="btn-sm" (click)="loadSales()">Refresh</button>
          </div>

          <table class="sales-table" *ngIf="sales().length">
            <thead>
              <tr>
                <th>Receipt</th><th>Total</th><th>Status</th><th>Sync</th><th>Date</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let sale of sales()">
                <td class="receipt-cell">{{ sale.saleNumber }}</td>
                <td>{{ sale.grandTotal }} RWF</td>
                <td><span class="pill ok">{{ sale.status }}</span></td>
                <td><span class="pill" [class.warn]="sale.syncState === 'PENDING'" [class.ok]="sale.syncState === 'SYNCED'">{{ sale.syncState }}</span></td>
                <td class="date-cell">{{ sale.createdAt | slice:0:10 }}</td>
              </tr>
            </tbody>
          </table>
          <div class="empty-state" *ngIf="!loadingSales() && !sales().length">
            No sales yet.
          </div>
        </section>

        <section class="tab-panel" *ngIf="activeTab() === 'sync'">
          <div class="panel-header">
            <h2>Sync Status</h2>
            <button class="btn-sm" (click)="forceSync()" [disabled]="syncing()">
              {{ syncing() ? 'Syncing…' : 'Sync Now' }}
            </button>
          </div>

          <div class="sync-cards">
            <div class="sync-card">
              <div class="sync-card-value">{{ syncStatus().pushed }}</div>
              <div class="sync-card-label">Pushed</div>
            </div>
            <div class="sync-card">
              <div class="sync-card-value">{{ syncStatus().pulled }}</div>
              <div class="sync-card-label">Pulled</div>
            </div>
            <div class="sync-card">
              <div class="sync-card-value">{{ syncStatus().pending }}</div>
              <div class="sync-card-label">Pending</div>
            </div>
            <div class="sync-card">
              <div class="sync-card-value" [class.warn]="syncStatus().state === 'ERROR'">
                {{ syncStatus().state }}
              </div>
              <div class="sync-card-label">Worker</div>
            </div>
          </div>

          <div class="sync-table-wrap" *ngIf="conflicts().length">
            <h3>Conflicts ({{ conflicts().length }})</h3>
            <div class="conflict-row" *ngFor="let c of conflicts()">
              <span class="conflict-entity">{{ c.entity }}/{{ c.entityId }}</span>
              <span class="conflict-detected">{{ conflictDate(c) }}</span>
              <button class="btn-sm" (click)="resolveConflict(c, 'local')">Keep Local</button>
              <button class="btn-sm btn-danger-outline" (click)="resolveConflict(c, 'remote')">Accept Remote</button>
            </div>
          </div>
        </section>
      </main>
    </div>
  `,
  styleUrls: ['./pos-shell.component.css'],
})
export class PosShellComponent implements OnInit, OnDestroy {
  private subs = new Subscription();

  constructor(
    private bridge: LocalBridgeService,
    private router: TransportRouter,
  ) {}

  // -------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------

  engineState = signal('LOCKED');
  transportMode = signal(this.router.mode);
  contractVersion = signal(0);
  pendingCount = signal(0);

  activeTab = signal<Tab>('catalog');
  tabs: { id: Tab; label: string }[] = [
    { id: 'catalog', label: 'Catalog' },
    { id: 'cart', label: 'Cart' },
    { id: 'sales', label: 'Sales' },
    { id: 'sync', label: 'Sync' },
  ];

  catalogQuery = '';
  catalogItems = signal<CatalogItem[]>([]);
  loadingCatalog = signal(false);

  cart: CartLine[] = [];
  /**
   * Bound to an `input[type=number]`, so Angular's number value accessor
   * writes a `number` here as soon as the user types — it is only a
   * string while the field is empty.  `checkout()` normalises it to the
   * decimal string the wire contract requires.
   */
  amountPaid: string | number = '';
  checkingOut = signal(false);
  checkoutError = signal('');

  sales = signal<SaleRow[]>([]);
  loadingSales = signal(false);

  syncStatus = signal({ pushed: 0, pulled: 0, pending: 0, state: 'IDLE' });
  syncing = signal(false);
  conflicts = signal<{ id: string; entity: string; entityId: string; detectedAt?: string; lastError?: string }[]>([]);

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  ngOnInit(): void {
    this.getEngineState();
    this.searchCatalog();
    this.loadSales();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  // -------------------------------------------------------------------
  // Engine
  // -------------------------------------------------------------------

  private getEngineState(): void {
    this.contractVersion.set(this.bridge.contractVersion ?? 0);
    this.subs.add(
      this.bridge.getEngineState().subscribe((r) => {
        if (r.ok) {
          this.engineState.set(r.data.engineState);
        }
      }),
    );
  }

  // -------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------

  searchCatalog(): void {
    this.loadingCatalog.set(true);
    this.subs.add(
      this.bridge.invoke<{ items: CatalogItem[]; total: number }>(
        'catalog.search',
        { query: this.catalogQuery, limit: 50 },
      ).subscribe((r) => {
        if (r.ok) {
          this.catalogItems.set(r.data.items);
        }
        this.loadingCatalog.set(false);
      }),
    );
  }

  addToCart(item: CatalogItem): void {
    const existing = this.cart.find((l) => l.itemId === item.itemId);
    if (existing) {
      existing.quantity += 1;
      this.cart = [...this.cart];
    } else {
      this.cart = [...this.cart, {
        itemId: item.itemId,
        itemCode: item.itemCode,
        itemName: item.itemName,
        unitPrice: item.sellingPrice,
        quantity: 1,
      }];
    }
  }

  updateQty(index: number, qty: number): void {
    if (qty <= 0) {
      this.removeFromCart(index);
      return;
    }
    this.cart[index].quantity = qty;
    this.cart = [...this.cart];
  }

  removeFromCart(index: number): void {
    this.cart = this.cart.filter((_, i) => i !== index);
  }

  clearCart(): void {
    this.cart = [];
    this.amountPaid = '';
    this.checkoutError.set('');
  }

  lineTotal(line: CartLine): string {
    return (parseFloat(line.unitPrice) * line.quantity).toFixed(2);
  }

  cartTotal(): string {
    return this.cart
      .reduce((sum, l) => sum + parseFloat(this.lineTotal(l)), 0)
      .toFixed(2);
  }

  /**
   * Money crosses the bridge as a decimal string — the sale handler parses
   * it with BigInt so no amount is ever exposed to float rounding.  The
   * number input hands us a `number`, so convert here rather than widening
   * the schema to accept numbers (`decimalToCents` calls `.split('.')` on
   * its argument and would throw on one).
   *
   * An empty or unparseable field means "paid exactly the cart total".
   */
  private normalisedAmountPaid(): string {
    const raw = this.amountPaid;

    if (raw === '' || raw === null || raw === undefined) {
      return this.cartTotal();
    }

    const numeric = typeof raw === 'number' ? raw : parseFloat(raw);

    if (!Number.isFinite(numeric)) {
      return this.cartTotal();
    }

    return numeric.toFixed(2);
  }

  checkout(): void {
    if (!this.cart.length) return;
    this.checkingOut.set(true);
    this.checkoutError.set('');

    const payload = {
      items: this.cart.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      amountPaid: this.normalisedAmountPaid(),
    };

    this.subs.add(
      this.bridge.invoke<{ sale: SaleRow; receiptNumber: string }>('sale.create', payload).subscribe((r) => {
        if (r.ok) {
          this.clearCart();
          this.loadSales();
          this.activeTab.set('sales');
        } else {
          this.checkoutError.set(`${r.code}: ${r.message}`);
        }
        this.checkingOut.set(false);
      }),
    );
  }

  // -------------------------------------------------------------------
  // Sales
  // -------------------------------------------------------------------

  loadSales(): void {
    this.loadingSales.set(true);
    this.subs.add(
      this.bridge.invoke<{ sales: SaleRow[]; total: number }>('sale.list', { limit: 30 }).subscribe((r) => {
        if (r.ok) {
          this.sales.set(r.data.sales);
        }
        this.loadingSales.set(false);
      }),
    );
  }

  // -------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------

  forceSync(): void {
    this.syncing.set(true);
    this.subs.add(
      this.bridge.invoke<{ pushed: number; pulled: number; pending: number; state: string }>(
        'sync.now',
      ).subscribe((r) => {
        if (r.ok) {
          this.syncStatus.set({
            pushed: r.data.pushed,
            pulled: r.data.pulled,
            pending: r.data.pending,
            state: r.data.state,
          });
          this.pendingCount.set(r.data.pending);
        }
        this.syncing.set(false);
      }),
    );
  }

  resolveConflict(conflict: { id: string }, resolution: 'local' | 'remote'): void {
    this.subs.add(
      this.bridge.invoke('sync.resolve', { conflictId: conflict.id, resolution }).subscribe((r) => {
        if (r.ok) {
          this.loadConflicts();
        }
      }),
    );
  }

  conflictDate(c: { detectedAt?: string; lastError?: string }): string {
    return c.detectedAt ?? c.lastError ?? '';
  }

  private loadConflicts(): void {
    this.subs.add(
      this.bridge.invoke<{ conflicts: { id: string; entity: string; entityId: string; detectedAt?: string; lastError?: string }[]; total: number }>('sync.conflicts').subscribe((r) => {
        if (r.ok) {
          this.conflicts.set(r.data.conflicts);
        }
      }),
    );
  }
}
