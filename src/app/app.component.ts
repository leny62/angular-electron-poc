import { Component, signal, OnInit } from '@angular/core';
import { NgIf } from '@angular/common';
import { UnlockComponent } from './features/unlock/unlock.component';
import { PosShellComponent } from './features/pos/pos-shell.component';
import { LocalBridgeService } from './core/services/local-bridge.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NgIf, UnlockComponent, PosShellComponent],
  template: `
    <app-unlock *ngIf="engineState() === 'LOCKED' || engineState() === 'FATAL'" (unlocked)="onUnlocked()" />
    <app-pos-shell *ngIf="engineState() !== 'LOCKED' && engineState() !== 'FATAL'" />
  `,
})
export class AppComponent implements OnInit {
  engineState = signal('LOCKED');

  constructor(private bridge: LocalBridgeService) {}

  ngOnInit(): void {
    if (!this.bridge.isAvailable) {
      return;
    }
    this.bridge.getEngineState().subscribe((r) => {
      if (r.ok) {
        this.engineState.set(r.data.engineState);
      }
    });
  }

  onUnlocked(): void {
    this.engineState.set('READY');
  }
}
