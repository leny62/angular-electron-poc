/**
 * Bizuri IPC Contract — Electron (main-process) copy.
 *
 * DUPLICATED INTENTIONALLY from shared/contracts.ts (project root).
 * In production this is a shared npm package; for the PoC, keeping
 * the Electron build self-contained avoids rootDir gymnastics.
 *
 * The Angular side imports from:
 *   src/app/core/interfaces/local-bridge.interface.ts
 * which re-exports from the same canonical source.
 *
 * @see docs/Bizuri-Secure-IPC-Offline-Design.docx  Appendix A
 */

export const COMMAND_NAMES = [
  'session.unlock',
  'session.state',
  'engine.health',
  'catalog.search',
  'stock.balance',
  'stock.adjust',
  'customer.create',
  'customer.search',
  'sale.create',
  'sale.get',
  'sale.list',
  'sync.now',
  'sync.conflicts',
  'sync.resolve',
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export const ERROR_CODES = [
  'E_SENDER',
  'E_UNKNOWN_COMMAND',
  'E_ENVELOPE',
  'E_SCHEMA',
  'E_LOCKED',
  'E_FORBIDDEN',
  'E_RATE_LIMIT',
  'E_STOCK',
  'E_CONFLICT',
  'E_STORAGE',
  'E_INTEGRITY',
  'E_INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface CommandEnvelope<P = unknown> {
  readonly v: 1;
  readonly id: string;
  readonly name: CommandName;
  readonly issuedAt: string;
  readonly payload: P;
  readonly idempotencyKey?: string;
}

export interface CommandOk<T> {
  readonly v: 1;
  readonly id: string;
  readonly ok: true;
  readonly data: T;
  readonly durableAt: string;
}

export interface CommandErr {
  readonly v: 1;
  readonly id: string;
  readonly ok: false;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export type CommandResult<T = unknown> = CommandOk<T> | CommandErr;

export const EVENT_TOPICS = [
  'sync.state',
  'sync.progress',
  'sync.conflict',
  'engine.health',
  'catalog.updated',
] as const;

export type EventTopic = (typeof EVENT_TOPICS)[number];

export interface BridgeEvent<T = unknown> {
  readonly v: 1;
  readonly topic: EventTopic;
  readonly at: string;
  readonly data: T;
}

export type EngineState = 'READY' | 'DEGRADED' | 'LOCKED' | 'FATAL' | 'DRAINING';

export interface BizuriLocalBridge {
  readonly available: true;
  readonly contractVersion: 1;
  invoke<T = unknown>(name: CommandName, payload: unknown): Promise<CommandResult<T>>;
  subscribe(topic: EventTopic, handler: (event: BridgeEvent) => void): () => void;
}

export interface ValidationFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export type CommandHandler<TResult = unknown> = (
  payload: unknown,
  envelope: CommandEnvelope,
) => TResult | Promise<TResult>;

export interface CommandDefinition {
  readonly name: CommandName;
  readonly handler: CommandHandler;
  readonly schema?: object;
  readonly rateLimit?: number;
  readonly requiresUnlock?: boolean;
}
