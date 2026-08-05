import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import {
  LOG_COMPONENTS,
  LOG_LEVELS,
  LOG_SOURCES,
  type LogComponent,
  type LogLevel,
  type LogSource,
} from '@bizuri/local-store/browser';
import { LoggingService } from '@bizuri/offline-http';

/**
 * The system log viewer.
 *
 * Reads `/_engine/logs` through plain HttpClient like every other screen, so
 * the engine's own route table serves it and no special transport exists for
 * diagnostics.
 *
 * The table is dense on purpose. Thirteen columns is more than a layout wants,
 * but a log line is only useful next to its neighbours, so the alternative
 * (cards, or one column of expandable summaries) costs more rows on screen than
 * it saves in clarity. Wide fields are truncated in the row and shown in full
 * in the detail panel a click away.
 */

export interface SystemLogDto {
  id: string;
  seq: number;
  loggedAt: string;
  level: LogLevel;
  component: LogComponent;
  source: LogSource;
  logger: string;
  message: string;
  exception: string | null;
  userName: string | null;
  url: string | null;
  requestId: string | null;
  code: string | null;
  deviceId: string | null;
  thread: string | null;
  tenantId: string | null;
  context: Record<string, unknown> | null;
}

interface LogPage {
  data: SystemLogDto[];
  meta: { page: number; size: number; totalElements: number; totalPages: number };
}

const PAGE_SIZES = [25, 50, 100, 200];

@Component({
  selector: 'app-logs',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './logs.component.html',
  styleUrl: './logs.component.css',
})
export class LogsComponent {
  private readonly http = inject(HttpClient);
  private readonly log = inject(LoggingService).getLogger('logs.component');

  readonly levels = LOG_LEVELS;
  readonly components = LOG_COMPONENTS;
  readonly sources = LOG_SOURCES;
  readonly pageSizes = PAGE_SIZES;

  // Filters. '' means "all", which is why they are plain strings rather than
  // the union types: the empty option has to be representable.
  readonly component = signal<string>('');
  readonly level = signal<string>('');
  readonly source = signal<string>('');
  readonly search = signal<string>('');

  readonly page = signal(0);
  readonly size = signal(50);
  readonly autoRefresh = signal(false);

  readonly rows = signal<SystemLogDto[]>([]);
  readonly total = signal(0);
  readonly totalPages = signal(1);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly expanded = signal<string | null>(null);

  readonly from = computed(() => (this.total() === 0 ? 0 : this.page() * this.size() + 1));
  readonly to = computed(() => Math.min((this.page() + 1) * this.size(), this.total()));
  readonly canPrev = computed(() => this.page() > 0 && !this.busy());
  readonly canNext = computed(() => this.page() + 1 < this.totalPages() && !this.busy());

  readonly hasFilters = computed(
    () => !!(this.component() || this.level() || this.source() || this.search()),
  );

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    void this.load();

    // Re-fetch whenever a filter or the page changes. `untracked` around the
    // load keeps the signals it writes from re-triggering this effect.
    effect(() => {
      this.component();
      this.level();
      this.source();
      this.page();
      this.size();
      untracked(() => void this.load());
    });

    effect(() => {
      const on = this.autoRefresh();
      untracked(() => {
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        if (on) this.timer = setInterval(() => void this.load(), 4000);
      });
    });
  }

  async load(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);

    try {
      let params = new HttpParams()
        .set('page', String(this.page()))
        .set('size', String(this.size()));

      if (this.component()) params = params.set('component', this.component());
      if (this.level()) params = params.set('level', this.level());
      if (this.source()) params = params.set('source', this.source());
      if (this.search()) params = params.set('search', this.search());

      const res = await this.http
        .get<LogPage>('/_engine/logs', { params })
        .toPromise();

      this.rows.set(res?.data ?? []);
      this.total.set(res?.meta?.totalElements ?? 0);
      this.totalPages.set(res?.meta?.totalPages ?? 1);
    } catch (err) {
      const message =
        err instanceof HttpErrorResponse
          ? (err.error?.message ?? `Request failed (${err.status})`)
          : String(err);
      this.error.set(message);
      // Logging a failure to read the log is not circular: this entry is
      // written through the bridge, and it is exactly the breadcrumb needed
      // when the viewer itself is what is broken.
      this.log.error('Failed to load system logs', err, { code: 'LOG_READ_FAILED' });
    } finally {
      this.busy.set(false);
    }
  }

  applySearch(): void {
    this.page.set(0);
    void this.load();
  }

  setComponent(value: string): void {
    this.page.set(0);
    this.component.set(value);
  }

  setLevel(value: string): void {
    this.page.set(0);
    this.level.set(value);
  }

  setSource(value: string): void {
    this.page.set(0);
    this.source.set(value);
  }

  setSize(value: string): void {
    this.page.set(0);
    this.size.set(Number(value) || 50);
  }

  clearFilters(): void {
    this.page.set(0);
    this.search.set('');
    this.source.set('');
    this.level.set('');
    this.component.set('');
  }

  prev(): void {
    if (this.canPrev()) this.page.update((p) => p - 1);
  }

  next(): void {
    if (this.canNext()) this.page.update((p) => p + 1);
  }

  toggle(id: string): void {
    this.expanded.update((current) => (current === id ? null : id));
  }

  /** Human label for a component value, e.g. QUEUE_SERVICE → Queue service. */
  label(value: string): string {
    const lower = value.toLowerCase().replace(/_/g, ' ');
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }

  /** Context object rendered as key/value pairs for the detail panel. */
  contextPairs(row: SystemLogDto): { key: string; value: string }[] {
    if (!row.context) return [];
    return Object.entries(row.context).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    }));
  }
}
