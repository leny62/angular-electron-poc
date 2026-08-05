import { Component, inject, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LocalEngineService } from '@bizuri/offline-http';

@Component({
  selector: 'app-unlock',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './unlock.component.html',
  styleUrl: './unlock.component.css',
})
export class UnlockComponent {
  private readonly engine = inject(LocalEngineService);

  readonly email = signal('');
  readonly password = signal('');
  readonly subdomainSlug = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly signedIn = output<void>();

  async submit(): Promise<void> {
    if (this.busy()) return;

    const creds = {
      email: this.email().trim(),
      password: this.password(),
      subdomainSlug: this.subdomainSlug().trim(),
    };

    if (!creds.email || !creds.password || !creds.subdomainSlug) {
      this.error.set('All fields are required.');
      return;
    }

    this.busy.set(true);
    this.error.set(null);

    try {
      await this.engine.signIn(creds);
      this.signedIn.emit();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      this.busy.set(false);
    }
  }
}
