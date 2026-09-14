import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import type { CliFlags } from '@agent-device/contracts/command';
import { getFlagDefinitionsForKey } from './flag-registry.ts';
import type { FlagDefinition } from './flag-types.ts';
import { resolveConfigBackedFlagDefaults } from '../../cli-schema/cli-config.ts';
import { recordActionEntry } from '../../daemon/session-action-recorder.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeTempWorkspace } from '../../__tests__/cli-config-fixtures.ts';

/**
 * These are planted-divergence tests, not membership snapshots. A snapshot would
 * re-list the admitted/recorded keys and drift exactly like the two hand-maintained
 * allowlists it replaced; these plant a divergence in the ONE declaration and require
 * the production derivation to follow it, which a second list could not do.
 *
 * Like #2421's `command-input-option-field.test.ts`, the plant lands BEFORE the surface
 * is built. `cli-config.ts` freezes `PROJECT_CONFIG_FLAG_KEYS` and the recorder freezes
 * `RECORDED_FLAG_KEYS` at their own module load, so each test resets the graph, writes
 * the divergence onto the live declaration, and only then imports the consumer — so what
 * it observes is the real derivation running over the planted declaration.
 */

const OPERATOR_CLI_FLAGS: CliFlags = { json: false, help: false, version: false };

function writeProjectConfig(project: string, entries: Record<string, unknown>): void {
  fs.writeFileSync(path.join(project, 'agent-device.json'), JSON.stringify(entries), 'utf8');
}

function declarationFor(key: 'daemonBaseUrl' | 'overlayRefs'): FlagDefinition {
  const declaration = getFlagDefinitionsForKey(key)[0];
  assert.ok(declaration, `expected a declaration for ${key}`);
  return declaration;
}

test('project-config admission follows the declaration: an undeclared key is refused, a planted declaration is admitted', async () => {
  // Shipped: the declaration declines project config, so the same file the shipped
  // derivation reads is rejected.
  assert.equal(declarationFor('daemonBaseUrl').projectConfig, false);
  const shipped = makeTempWorkspace();
  try {
    writeProjectConfig(shipped.project, { daemonBaseUrl: 'https://daemon.example.test' });
    assert.throws(
      () =>
        resolveConfigBackedFlagDefaults({
          command: 'devices',
          cwd: shipped.project,
          cliFlags: OPERATOR_CLI_FLAGS,
          env: { HOME: shipped.home },
        }),
      /not allowed in project config file/,
    );
  } finally {
    fs.rmSync(shipped.root, { recursive: true, force: true });
  }

  // Planted: flip the declaration before `cli-config` builds, and the identical file is
  // admitted. A hand-maintained allowlist in `cli-config.ts` could not follow this.
  vi.resetModules();
  const registry = await import('./flag-registry.ts');
  const planted = getInRegistry(registry, 'daemonBaseUrl');
  Object.assign(planted, { projectConfig: true });
  const { resolveConfigBackedFlagDefaults: derivePlanted } =
    await import('../../cli-schema/cli-config.ts');
  const workspace = makeTempWorkspace();
  try {
    writeProjectConfig(workspace.project, { daemonBaseUrl: 'https://daemon.example.test' });
    const defaults = derivePlanted({
      command: 'devices',
      cwd: workspace.project,
      cliFlags: OPERATOR_CLI_FLAGS,
      env: { HOME: workspace.home },
    });
    assert.equal(defaults.daemonBaseUrl, 'https://daemon.example.test');
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('recorder sanitization follows the declaration: an undeclared key is dropped, a planted declaration is recorded', async () => {
  // Shipped: `overlayRefs` declines recording so it is dropped; `fps` (recorded) is the
  // control that proves the copy itself works.
  assert.equal(declarationFor('overlayRefs').recorded, false);
  const shipped = recordActionEntry(makeIosSession('default'), {
    command: 'screenshot',
    positionals: [],
    flags: { overlayRefs: true, fps: 5 },
    result: {},
  });
  assert.equal(shipped?.flags.overlayRefs, undefined, 'overlayRefs is undeclared for recording');
  assert.equal(shipped?.flags.fps, 5, 'fps is declared for recording');

  // Planted: flip the declaration before the recorder builds, and the production
  // `sanitizeFlags` now copies the same value.
  vi.resetModules();
  const registry = await import('./flag-registry.ts');
  const planted = getInRegistry(registry, 'overlayRefs');
  Object.assign(planted, { recorded: true });
  const { recordActionEntry: recordPlanted } =
    await import('../../daemon/session-action-recorder.ts');
  const recorded = recordPlanted(makeIosSession('default'), {
    command: 'screenshot',
    positionals: [],
    flags: { overlayRefs: true },
    result: {},
  });
  assert.equal(recorded?.flags.overlayRefs, true, 'a planted declaration is copied');
});

test('a flag declaration without both admission fields does not compile', () => {
  // @ts-expect-error projectConfig and recorded are required; omission is the fail-closed gate.
  const declaration: FlagDefinition = { key: 'json', names: ['--json'], type: 'boolean' };
  assert.ok(declaration);
});

test('a CLI-only key cannot opt into recording', () => {
  // `help` is a CLI token that never reaches `CommandFlags`, so `recorded: true`
  // is a type error — the guard the old `satisfies keyof CommandFlags` list held.
  // @ts-expect-error a non-recodable key must declare `recorded: false`.
  const declaration: FlagDefinition = {
    key: 'help',
    names: ['--help'],
    type: 'boolean',
    projectConfig: false,
    recorded: true,
  };
  assert.ok(declaration);
});

function getInRegistry(
  registry: typeof import('./flag-registry.ts'),
  key: 'daemonBaseUrl' | 'overlayRefs',
): FlagDefinition {
  const declaration = registry.getFlagDefinitionsForKey(key)[0];
  assert.ok(declaration, `expected a declaration for ${key}`);
  return declaration;
}
