import { Component } from '@angular/core';
import { DiagnosticsComponent } from './features/diagnostics/diagnostics.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [DiagnosticsComponent],
  template: '<app-diagnostics />',
})
export class AppComponent {}
