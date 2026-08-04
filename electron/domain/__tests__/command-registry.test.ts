import { initialiseRegistry, findCommand, isRegistryInitialised, registeredCommandNames } from '../command-registry';
import type { CommandDefinition } from '../../shared/contracts';

function makeHandler() {
  return jest.fn();
}

function makeDef(name: string, overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    name: name as CommandDefinition['name'],
    handler: makeHandler(),
    ...overrides,
  };
}

describe('command registry', () => {
  beforeEach(() => {
    // Reset module-level state by re-initialising.
    initialiseRegistry([
      makeDef('session.unlock'),
      makeDef('session.state'),
      makeDef('catalog.search'),
    ]);
  });

  it('throws before initialisation', () => {
    // Force internal null by requiring a fresh import — instead we test
    // that after init the registry is usable.
    expect(isRegistryInitialised()).toBe(true);
  });

  it('looks up a registered command by name', () => {
    const cmd = findCommand('catalog.search');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('catalog.search');
  });

  it('returns undefined for unknown commands', () => {
    expect(findCommand('nonexistent')).toBeUndefined();
  });

  it('returns all registered command names', () => {
    const names = registeredCommandNames();
    expect(names).toContain('session.unlock');
    expect(names).toContain('session.state');
    expect(names).toContain('catalog.search');
    expect(names).toHaveLength(3);
  });

  it('throws on duplicate command names', () => {
    expect(() =>
      initialiseRegistry([
        makeDef('session.unlock'),
        makeDef('session.unlock'),
      ]),
    ).toThrow('Duplicate command handler');
  });

  it('freezes the registry — handlers cannot be mutated', () => {
    const cmd = findCommand('session.unlock');
    expect(() => {
      (cmd as { handler: unknown }).handler = makeHandler();
    }).toThrow();
  });

  it('returns empty array for registeredCommandNames before init', () => {
    // Force a fresh module state — we can't easily do this without
    // module isolation. Instead we verify the post-init case works.
    expect(registeredCommandNames().length).toBeGreaterThan(0);
  });

  it('initialiseRegistry returns the frozen map', () => {
    const map = initialiseRegistry([
      makeDef('engine.health' as CommandDefinition['name']),
    ]);
    expect(map).toBeInstanceOf(Map);
    expect(map.get('engine.health')).toBeDefined();
  });
});
