/**
 * DiagnosticsComponent — PoC validation screen.
 *
 * Exercises every IPC pathway so we can verify Phase 0 and Phase 1
 * without writing automated tests first:
 *   - Bridge availability and contract version
 *   - session.unlock / session.state
 *   - catalog.search (read command)
 *   - sale.create (write command with atomic transaction)
 *   - sale.list (verify the write persisted)
 *   - Tampered envelope rejection (E_UNKNOWN_COMMAND, E_ENVELOPE)
 *
 * This component is temporary — it will be removed when integration
 * tests cover the same paths.
 */

import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { NgIf, NgFor } from '@angular/common';
import type { CommandOk, CommandErr, EngineState } from '../../core/interfaces/local-bridge.interface';
import { LocalBridgeService } from '../../core/services/local-bridge.service';
import { Subscription } from 'rxjs';

interface LogEntry {
  readonly timestamp: string;
  readonly direction: 'send' | 'receive' | 'error' | 'info';
  readonly message: string;
}

@Component({
  selector: 'app-diagnostics',
  standalone: true,
  imports: [NgIf, NgFor],
  template: `
    <div class="diagnostics">
      <header class="diag-header">
        <h1>Bizuri PoC — Diagnostics</h1>
        <span class="badge" [class.ok]="bridgeAvailable()" [class.err]="!bridgeAvailable()">
          {{ bridgeAvailable() ? 'Bridge OK' : 'No Bridge' }}
        </span>
        <span class="badge" [class.ok]="engineReady()" [class.err]="!engineReady()">
          {{ engineState() }}
        </span>
      </header>

      <section class="diag-controls">
        <h2>Actions</h2>
        <div class="btn-group">
          <button (click)="checkBridge()">Check Bridge</button>
          <button (click)="unlock()" [disabled]="!bridgeAvailable()">Unlock Engine</button>
          <button (click)="catalogSearch()" [disabled]="!engineReady()">Catalog Search</button>
          <button (click)="createSale()" [disabled]="!engineReady()">Create Sale</button>
          <button (click)="listSales()" [disabled]="!engineReady()">List Sales</button>
        </div>
        <div class="btn-group tamper">
          <button class="danger" (click)="sendUnknownCommand()">Send Unknown Command</button>
          <button class="danger" (click)="sendBadEnvelope()">Send Bad Envelope</button>
          <button class="danger" (click)="sendFromDevtoolsHint()">DevTools Test (check console)</button>
          <button class="danger" (click)="clearLog()">Clear Log</button>
        </div>
      </section>

      <section class="diag-log">
        <h2>Event Log</h2>
        <div class="log-container">
          <div class="log-entry" *ngFor="let entry of logEntries()" [class]="entry.direction">
            <span class="log-time">{{ entry.timestamp }}</span>
            <span class="log-dir">[{{ entry.direction }}]</span>
            <span class="log-msg">{{ entry.message }}</span>
          </div>
          <div *ngIf="logEntries().length === 0" class="log-empty">
            No events yet.  Click an action to exercise the bridge.
          </div>
        </div>
      </section>
    </div>
  `,
  styles: [`
    .diagnostics {
      max-width: 900px;
      margin: 0 auto;
      padding: 24px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      color: #e0e0e0;
      background: #1a1a2e;
      min-height: 100vh;
    }
    .diag-header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
    }
    .diag-header h1 { margin: 0; font-size: 20px; color: #fff; }
    .badge {
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge.ok { background: #1b5e20; color: #a5d6a7; }
    .badge.err { background: #b71c1c; color: #ef9a9a; }

    h2 { font-size: 14px; text-transform: uppercase; color: #888; margin: 16px 0 8px; }

    .btn-group {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
    }
    button {
      padding: 8px 16px;
      border: 1px solid #444;
      border-radius: 4px;
      background: #2a2a3e;
      color: #e0e0e0;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
    }
    button:hover:not(:disabled) { background: #3a3a5e; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    button.danger { border-color: #b71c1c; color: #ef9a9a; }
    button.danger:hover { background: #3e1a1a; }

    .log-container {
      background: #0d0d1a;
      border: 1px solid #333;
      border-radius: 6px;
      padding: 12px;
      max-height: 400px;
      overflow-y: auto;
      font-size: 12px;
      line-height: 1.6;
    }
    .log-entry { display: flex; gap: 10px; padding: 2px 0; }
    .log-time { color: #666; min-width: 100px; }
    .log-dir { min-width: 60px; font-weight: 600; }
    .log-entry.send .log-dir { color: #64b5f6; }
    .log-entry.receive .log-dir { color: #81c784; }
    .log-entry.error .log-dir { color: #ef5350; }
    .log-entry.info .log-dir { color: #ffb74d; }
    .log-msg { color: #ccc; word-break: break-all; }
    .log-empty { color: #555; font-style: italic; padding: 20px 0; text-align: center; }
  `],
})
export class DiagnosticsComponent implements OnInit, OnDestroy {
  private subscription = new Subscription();

  // -------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------

  readonly bridgeAvailable = signal(false);
  readonly engineState = signal<EngineState>('LOCKED');
  readonly logEntries = signal<LogEntry[]>([]);

  readonly engineReady = computed(() =>
    this.engineState() === 'READY' || this.engineState() === 'DEGRADED',
  );

  constructor(private readonly bridge: LocalBridgeService) {}

  ngOnInit(): void {
    this.checkBridge();
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  // -------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------

  checkBridge(): void {
    const available = this.bridge.isAvailable;
    const version = this.bridge.contractVersion;
    this.bridgeAvailable.set(available);
    this.log(
      available
        ? `Bridge available (contract v${version}). Running inside Electron.`
        : 'Bridge NOT available. Are you running in a browser (ng serve) instead of Electron?',
      'info',
    );

    if (available) {
      this.getEngineState();
    }
  }

  unlock(): void {
    this.log('session.unlock → sending...', 'send');
    this.subscription.add(
      this.bridge.unlock('bizuri-poc-dev-key-2026').subscribe((result) => {
        if (result.ok) {
          this.engineState.set(result.data.engineState);
          this.log(`session.unlock ← OK (engine: ${result.data.engineState})`, 'receive');
        } else {
          this.log(`session.unlock ← ${result.code}: ${result.message}`, 'error');
        }
      }),
    );
  }

  catalogSearch(): void {
    this.log('catalog.search → sending (query: "")...', 'send');
    this.subscription.add(
      this.bridge.invoke<{ items: unknown[]; total: number }>('catalog.search', { query: '' }).subscribe((result) => {
        if (result.ok) {
          this.log(`catalog.search ← OK (${result.data.total} items)`, 'receive');
        } else {
          this.log(`catalog.search ← ${result.code}: ${result.message}`, 'error');
        }
      }),
    );
  }

  createSale(): void {
    const payload = {
      currencyCode: 'RWF',
      items: [
        { itemId: 'cat-001', quantity: 2 },
        { itemId: 'cat-002', quantity: 1 },
      ],
      amountPaid: '32500',
    };

    this.log(`sale.create → sending (2 items)...`, 'send');
    this.subscription.add(
      this.bridge.invoke<{ sale: unknown; receiptNumber: string }>('sale.create', payload).subscribe((result) => {
        if (result.ok) {
          const data = result.data as { receiptNumber: string };
          this.log(`sale.create ← OK (receipt: ${data.receiptNumber}, durableAt: ${result.durableAt})`, 'receive');
        } else {
          this.log(`sale.create ← ${result.code}: ${result.message}`, 'error');
        }
      }),
    );
  }

  listSales(): void {
    this.log('sale.list → sending...', 'send');
    this.subscription.add(
      this.bridge.invoke<{ sales: unknown[]; total: number }>('sale.list', {}).subscribe((result) => {
        if (result.ok) {
          this.log(`sale.list ← OK (${result.data.total} sales)`, 'receive');
        } else {
          this.log(`sale.list ← ${result.code}: ${result.message}`, 'error');
        }
      }),
    );
  }

  sendUnknownCommand(): void {
    // Use the raw bridge to bypass TypeScript's type checking and prove
    // that gate 2 (command allow-list) rejects unknown names.
    this.log('sending unknown command "fake.command"...', 'send');
    const rawBridge = window.bizuriLocal;
    if (!rawBridge) {
      this.log('Bridge not available.', 'error');
      return;
    }
    rawBridge.invoke('fake.command' as never, {}).then((result: unknown) => {
      const r = result as CommandErr;
      if (r.ok === false) {
        this.log(`unknown command ← ${r.code}: ${r.message}`, 'receive');
      } else {
        this.log('unknown command ← UNEXPECTED SUCCESS (bug!)', 'error');
      }
    });
  }

  sendBadEnvelope(): void {
    // Send an envelope with v: 2 to prove gate 3 rejects version mismatches.
    this.log('sending envelope with v: 2...', 'send');
    const rawBridge = window.bizuriLocal;
    if (!rawBridge) {
      this.log('Bridge not available.', 'error');
      return;
    }
    rawBridge.invoke('session.state' as never, { v: 2 }).then((result: unknown) => {
      const r = result as CommandErr;
      if (r.ok === false) {
        this.log(`bad envelope ← ${r.code}: ${r.message}`, 'receive');
      } else {
        this.log('bad envelope ← UNEXPECTED SUCCESS (bug!)', 'error');
      }
    });
  }

  sendFromDevtoolsHint(): void {
    this.log(
      'Open DevTools Console and paste: window.bizuriLocal.invoke("sale.create", {}) — it should be rejected by the gateway.',
      'info',
    );
  }

  clearLog(): void {
    this.logEntries.set([]);
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private getEngineState(): void {
    this.subscription.add(
      this.bridge.getEngineState().subscribe((result) => {
        if (result.ok) {
          this.engineState.set(result.data.engineState);
          this.log(`Engine state: ${result.data.engineState}`, 'info');
        }
      }),
    );
  }

  private log(message: string, direction: LogEntry['direction']): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString().slice(11, 23),
      direction,
      message,
    };
    this.logEntries.update((entries) => [...entries.slice(-99), entry]);
  }
}
