import { validateCommand, buildErrorResponse } from '../validation-pipeline';
import type { ValidationContext } from '../validation-pipeline';
import { EngineStateMachine } from '../engine-state';
import { COMMAND_SCHEMAS } from '../command-schemas';

jest.mock('electron');

import { BrowserWindow } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

function makeEvent(origin = 'http://localhost:4200') {
  return {
    sender: { id: 1, destroy: jest.fn(), isDestroyed: () => false },
    senderFrame: { origin },
  } as unknown as IpcMainInvokeEvent;
}

function makeContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  const mainWindow = {
    id: 1,
    webContents: { send: jest.fn(), openDevTools: jest.fn() },
    loadURL: jest.fn(),
    on: jest.fn(),
  };
  return {
    event: makeEvent(),
    mainWindow: mainWindow as never,
    allowedOrigin: 'http://localhost:4200',
    engineState: new EngineStateMachine(),
    ...overrides,
  };
}

import type { CommandDefinition } from '../../shared/contracts';

function findCommand(name: string): CommandDefinition | undefined {
  const schema = COMMAND_SCHEMAS.get(name as CommandDefinition['name']);
  if (!schema && name !== 'session.state' && name !== 'session.unlock' && name !== 'engine.health'
    && name !== 'sale.create') {
    return undefined;
  }
  return {
    name: name as CommandDefinition['name'],
    handler: () => ({}),
    requiresUnlock: name !== 'session.unlock' && name !== 'session.state' && name !== 'engine.health',
    rateLimit: 60,
    schema,
  };
}

describe('validateCommand', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const mainWindow = { id: 1, webContents: {}, loadURL: jest.fn(), on: jest.fn() };
    (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue(mainWindow);
  });

  function validEnvelope(overrides = {}) {
    return {
      v: 1,
      id: 'req-001',
      name: 'session.state',
      issuedAt: new Date().toISOString(),
      payload: {},
      ...overrides,
    };
  }

  describe('Gate 1: sender identity', () => {
    it('rejects when sender window is not main window', () => {
      (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue(null);
      const result = validateCommand(validEnvelope(), makeContext(), findCommand);
      expect(result.valid).toBe(false);
      expect(result.failure!.code).toBe('E_SENDER');
    });
  });

  describe('Gate 2: command allow-list', () => {
    it('rejects unknown command names', () => {
      const result = validateCommand(
        { v: 1, id: 'r1', name: 'evil.command', issuedAt: new Date().toISOString(), payload: {} },
        makeContext(),
        findCommand,
      );
      expect(result.valid).toBe(false);
      expect(result.failure!.code).toBe('E_UNKNOWN_COMMAND');
      expect(result.failure!.message).not.toContain('evil');
    });
  });

  describe('Gate 3: envelope shape', () => {
    it('rejects non-object body', () => {
      // A string body has no .name property, so gate 2 catches it
      // as an unknown command before gate 3 runs.
      const result = validateCommand('not-an-object', makeContext(), findCommand);
      expect(result.valid).toBe(false);
      expect(result.failure!.code).toBe('E_UNKNOWN_COMMAND');
    });

    it('rejects missing version', () => {
      const result = validateCommand(
        { id: 'r1', name: 'session.state', issuedAt: new Date().toISOString(), payload: {} },
        makeContext(),
        findCommand,
      );
      expect(result.valid).toBe(false);
    });

    it('rejects wrong version', () => {
      const result = validateCommand(
        { v: 2, id: 'r1', name: 'session.state', issuedAt: new Date().toISOString(), payload: {} },
        makeContext(),
        findCommand,
      );
      expect(result.valid).toBe(false);
      expect(result.failure!.details).toEqual({ expected: 1, received: 2 });
    });

    it('rejects missing id', () => {
      const result = validateCommand(
        { v: 1, name: 'session.state', issuedAt: new Date().toISOString(), payload: {} },
        makeContext(),
        findCommand,
      );
      expect(result.valid).toBe(false);
    });

    it('rejects missing issuedAt', () => {
      const result = validateCommand(
        { v: 1, id: 'r1', name: 'session.state', payload: {} },
        makeContext(),
        findCommand,
      );
      expect(result.valid).toBe(false);
    });

    it('rejects invalid issuedAt', () => {
      const result = validateCommand(
        { v: 1, id: 'r1', name: 'session.state', issuedAt: 'not-a-date', payload: {} },
        makeContext(),
        findCommand,
      );
      expect(result.valid).toBe(false);
    });

    it('rejects missing payload field', () => {
      const result = validateCommand(
        { v: 1, id: 'r1', name: 'session.state', issuedAt: new Date().toISOString() },
        makeContext(),
        findCommand,
      );
      expect(result.valid).toBe(false);
    });
  });

  describe('Gate 4: schema validation', () => {
    it('rejects when payload does not match schema', () => {
      const result = validateCommand(
        validEnvelope({ name: 'session.unlock', payload: { badField: 123 } }),
        makeContext(),
        findCommand,
      );
      expect(result.valid).toBe(false);
      expect(result.failure!.code).toBe('E_SCHEMA');
    });

    it('passes when payload matches schema', () => {
      const result = validateCommand(
        validEnvelope({ name: 'session.unlock', payload: { passphrase: 'test' } }),
        makeContext(),
        findCommand,
      );
      expect(result.valid).toBe(true);
    });

    it('passes when no schema is registered for the command', () => {
      // Use a command that has NO schema in COMMAND_SCHEMAS for this test,
      // and a findCommand that returns no schema either.
      const result = validateCommand(
        validEnvelope({ name: 'session.state', payload: null }),
        makeContext(),
        (name) => ({
          name: name as CommandDefinition['name'],
          handler: () => ({}),
          requiresUnlock: false,
          // no schema key → gate 4 skips validation
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('never exposes schema paths in the error message', () => {
      const result = validateCommand(
        validEnvelope({ name: 'sale.create', payload: {} }),
        makeContext(),
        findCommand,
      );
      expect(result.valid).toBe(false);
      expect(result.failure!.message).not.toContain('items');
      expect(result.failure!.message).toBe('Schema validation failed.');
    });
  });

  describe('Gate 5: session scope', () => {
    it('rejects locked commands when engine is LOCKED', () => {
      const result = validateCommand(
        validEnvelope({ name: 'sale.create', payload: { items: [{ itemId: 'x', quantity: 1 }], amountPaid: '100' } }),
        makeContext(),
        findCommand,
      );
      expect(result.valid).toBe(false);
      expect(result.failure!.code).toBe('E_LOCKED');
    });

    it('allows unlocked commands when engine is LOCKED', () => {
      const result = validateCommand(
        validEnvelope({ name: 'session.unlock', payload: { passphrase: 'test' } }),
        makeContext(),
        findCommand,
      );
      expect(result.valid).toBe(true);
    });

    it('rejects locked commands when engine is FATAL', () => {
      const engine = new EngineStateMachine();
      engine.markFatal('db gone');
      const result = validateCommand(
        validEnvelope({ name: 'sale.create', payload: { items: [{ itemId: 'x', quantity: 1 }], amountPaid: '100' } }),
        makeContext({ engineState: engine }),
        findCommand,
      );
      expect(result.valid).toBe(false);
      expect(result.failure!.code).toBe('E_LOCKED');
    });
  });

  describe('Gate 6: rate and size limiting', () => {
    it('rejects oversized envelopes', () => {
      // Build an envelope with a huge id field to trigger the size limit.
      // Gate 4 schema check passes because command.schema is set explicitly.
      const hugeId = 'x'.repeat(70_000);
      const noSchemaFinder = (name: string): CommandDefinition | undefined => ({
        name: name as CommandDefinition['name'],
        handler: () => ({}),
        requiresUnlock: false,
        schema: {}, // empty schema — validates anything
      });
      const result = validateCommand(
        {
          v: 1,
          id: hugeId,
          name: 'session.state',
          issuedAt: new Date().toISOString(),
          payload: {},
        },
        makeContext(),
        noSchemaFinder,
      );
      expect(result.valid).toBe(false);
      expect(result.failure!.code).toBe('E_RATE_LIMIT');
    });

    it('passes for normal-sized envelopes', () => {
      const result = validateCommand(
        validEnvelope({ name: 'session.state' }),
        makeContext(),
        findCommand,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('pipeline short-circuit', () => {
    it('stops at the first failing gate', () => {
      (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue(null);
      // Gate 1 (sender) fails — gates 2-6 should not run
      const result = validateCommand('not-even-an-object', makeContext(), findCommand);
      expect(result.valid).toBe(false);
      expect(result.failure!.code).toBe('E_SENDER');
    });
  });
});

describe('buildErrorResponse', () => {
  it('builds a CommandErr with the failure details', () => {
    const response = buildErrorResponse(
      { code: 'E_LOCKED', message: 'Engine locked.', retryable: false },
      'req-001',
    );
    expect(response.v).toBe(1);
    expect(response.id).toBe('req-001');
    expect(response.ok).toBe(false);
    expect(response.code).toBe('E_LOCKED');
    expect(response.message).toBe('Engine locked.');
  });

  it('defaults id to "unknown" when not provided', () => {
    const response = buildErrorResponse(
      { code: 'E_INTERNAL', message: 'Error.', retryable: false },
    );
    expect(response.id).toBe('unknown');
  });
});
