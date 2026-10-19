import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { getFlagDefinitionsForKey } from '@agent-device/command-registry/flag-registry';
import type { FlagDefinition } from '@agent-device/command-registry/flag-types';
import { makeIosSession } from '../__tests__/support/session-factories.ts';
import { recordActionEntry } from './session-action-recorder.ts';

test('recorder sanitization follows the declaration: an undeclared key is dropped, a planted declaration is recorded', async () => {
  assert.equal(declarationFor('overlayRefs').recorded, false);
  const shipped = recordActionEntry(makeIosSession('default'), {
    command: 'screenshot',
    positionals: [],
    flags: { overlayRefs: true, fps: 5 },
    result: {},
  });
  assert.equal(shipped?.flags.overlayRefs, undefined, 'overlayRefs is undeclared for recording');
  assert.equal(shipped?.flags.fps, 5, 'fps is declared for recording');

  vi.resetModules();
  const registry = await import('@agent-device/command-registry/flag-registry');
  const planted = declarationForIn(registry, 'overlayRefs');
  Object.assign(planted, { recorded: true });
  const { recordActionEntry: recordPlanted } = await import('./session-action-recorder.ts');
  const recorded = recordPlanted(makeIosSession('default'), {
    command: 'screenshot',
    positionals: [],
    flags: { overlayRefs: true },
    result: {},
  });
  assert.equal(recorded?.flags.overlayRefs, true, 'a planted declaration is copied');
});

function declarationFor(key: 'overlayRefs'): FlagDefinition {
  const declaration = getFlagDefinitionsForKey(key)[0];
  assert.ok(declaration, `expected a declaration for ${key}`);
  return declaration;
}

function declarationForIn(
  registry: typeof import('@agent-device/command-registry/flag-registry'),
  key: 'overlayRefs',
): FlagDefinition {
  const declaration = registry.getFlagDefinitionsForKey(key)[0];
  assert.ok(declaration, `expected a declaration for ${key}`);
  return declaration;
}
