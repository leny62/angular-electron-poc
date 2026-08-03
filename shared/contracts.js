"use strict";
/**
 * Bizuri IPC Contract — Canonical Definitions
 *
 * SINGLE SOURCE OF TRUTH for every type, constant, and interface that
 * crosses the Electron main-process ↔ Angular renderer boundary.
 *
 * Compiled into both sides.  Never edited independently.
 *
 * @see docs/Bizuri-Secure-IPC-Offline-Design.docx  Appendix A
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVENT_TOPICS = exports.ERROR_CODES = exports.COMMAND_NAMES = void 0;
// ---------------------------------------------------------------------------
// Command catalogue
// ---------------------------------------------------------------------------
exports.COMMAND_NAMES = [
    'session.unlock',
    'session.state',
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
];
// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------
exports.ERROR_CODES = [
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
];
// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
exports.EVENT_TOPICS = [
    'sync.state',
    'sync.progress',
    'sync.conflict',
    'engine.health',
    'catalog.updated',
];
//# sourceMappingURL=contracts.js.map