/**
 * Local Bridge — Re-exports from the canonical contract.
 *
 * Do NOT edit types here.  The single source of truth is
 *   ../../../../../shared/contracts.ts
 *
 * @see docs/Bizuri-Secure-IPC-Offline-Design.docx  Appendix A
 */

export {
  COMMAND_NAMES,
  ERROR_CODES,
  EVENT_TOPICS,
  type CommandName,
  type ErrorCode,
  type CommandEnvelope,
  type CommandOk,
  type CommandErr,
  type CommandResult,
  type EventTopic,
  type BridgeEvent,
  type EngineState,
  type BizuriLocalBridge,
  type ValidationFailure,
  type CommandHandler,
  type CommandDefinition,
} from '../../../../shared/contracts';
