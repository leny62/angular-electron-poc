import { Component, Output, EventEmitter, signal } from '@angular/core';
import { NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-unlock',
  standalone: true,
  imports: [NgIf, FormsModule],
  template: `
    <div class="unlock-screen">
      <div class="unlock-card">
        <div class="unlock-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v1"/>
            <circle cx="12" cy="16" r="1"/>
          </svg>
        </div>

        <h1>Bizuri PoC</h1>
        <p class="unlock-subtitle">Secure IPC &amp; Offline Operation</p>

        <div class="unlock-form">
          <label for="passphrase">Vault passphrase</label>
          <input
            id="passphrase"
            type="password"
            [(ngModel)]="passphrase"
            placeholder="Enter passphrase to unlock"
            (keyup.enter)="submit()"
            autofocus
          />
          <button
            class="btn-primary"
            [disabled]="!passphrase || loading()"
            (click)="submit()"
          >
            {{ loading() ? 'Unlocking…' : 'Unlock' }}
          </button>
        </div>

        <p class="unlock-error" *ngIf="error()">{{ error() }}</p>
        <p class="unlock-hint">Dev passphrase: <code>bizuri-poc-dev-key-2026</code></p>
      </div>
    </div>
  `,
  styleUrls: ['./unlock.component.css'],
})
export class UnlockComponent {
  @Output() unlocked = new EventEmitter<void>();

  passphrase = '';
  loading = signal(false);
  error = signal('');

  submit(): void {
    if (!this.passphrase) return;
    this.loading.set(true);
    this.error.set('');

    const bridge = window.bizuriLocal;
    if (!bridge) {
      this.error.set('Bridge not available. Are you running inside Electron?');
      this.loading.set(false);
      return;
    }

    bridge.invoke('session.unlock', { passphrase: this.passphrase }).then((result: unknown) => {
      const r = result as { ok: boolean; code?: string; message?: string };
      if (r.ok) {
        this.unlocked.emit();
      } else {
        this.error.set(r.message ?? r.code ?? 'Unlock failed.');
      }
      this.loading.set(false);
    });
  }
}
