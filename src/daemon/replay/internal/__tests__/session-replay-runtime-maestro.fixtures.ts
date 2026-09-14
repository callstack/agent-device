import { vi } from 'vitest';

// The Maestro replay engine resolves a real device and — through the ADR 0012
// post-failure divergence capture — the real snapshot interactor. Neither fixture
// models a device runner, so both are stubbed here: `resolveTargetDevice` returns a
// fixed Android/iOS device, and the interactor rejects fast so failure-path tests
// keep exercising `divergence.screen: unavailable` deterministically.
//
// The Maestro-shaped device resolution lives in this fixtures module rather than
// per-sibling because Vitest allows only one `vi.mock` per module per file, so the
// Maestro family cannot reuse the differently-resolved device that
// `session-replay-runtime.test.ts` declares for itself.
vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveTargetDevice: vi.fn(async (flags) =>
      flags.platform === 'android'
        ? {
            platform: 'android',
            id: 'emulator-5554',
            name: 'Pixel',
            kind: 'emulator',
            booted: true,
          }
        : {
            platform: 'apple',
            appleOs: 'ios',
            id: 'sim-1',
            name: 'iPhone 17 Pro',
            kind: 'simulator',
            booted: true,
          },
    ),
  };
});

vi.mock('../../../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../../../daemon-request.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { SessionStore } from '../../../session-store.ts';
import { runReplayForTest } from '../../__tests__/replay-command-fixture.ts';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import {
  maestroScriptSourceBundleFor,
  replayScriptSourceBundleFor,
} from '../../../../__tests__/test-utils/replay-script-source.ts';
import { captureSnapshotThroughLegacyDispatchFixture } from '../../../__tests__/legacy-snapshot-capture-fixture.ts';
import { captureSnapshotWithInteractor } from '../../../snapshot-interactor-capture.ts';
import { seedReplayFixtureSession } from '../../__tests__/session-replay-runtime.fixtures.ts';

vi.mocked(captureSnapshotWithInteractor).mockImplementation(
  captureSnapshotThroughLegacyDispatchFixture,
);

export type CapturedInvocation = {
  command: string;
  positionals?: string[];
  input?: Record<string, unknown>;
  flags?: CommandFlags;
};

async function runReplayFixture(params: {
  label: string;
  script: string;
  files?: Record<string, string>;
  flags?: CommandFlags;
  invoke?: DaemonInvokeFn;
  sessionPlatform?: 'android' | 'ios';
}): Promise<{
  response: DaemonResponse;
  calls: CapturedInvocation[];
  root: string;
  scriptPath: string;
}> {
  const root = mkdtempForTestSync(`agent-device-replay-${params.label}-`);
  writeFixtureFiles(root, params.files);
  const isMaestro = params.flags?.replayBackend === 'maestro';
  const scriptPath = path.join(root, isMaestro ? 'flow.yaml' : 'flow.ad');
  fs.writeFileSync(scriptPath, params.script);
  const calls: CapturedInvocation[] = [];
  const invoke = createFixtureInvoke({ calls, delegate: params.invoke, isMaestro });
  const sessionStore = new SessionStore(path.join(root, 'state'));
  seedReplayFixtureSession(sessionStore, params.sessionPlatform);
  const scriptSource = isMaestro
    ? await maestroScriptSourceBundleFor(scriptPath)
    : replayScriptSourceBundleFor(scriptPath);
  const response = await runReplayForTest({
    req: fixtureReplayRequest({ root, scriptPath, flags: params.flags, isMaestro, scriptSource }),
    sessionName: 's',
    logPath: path.join(root, 'log'),
    sessionStore,
    invoke,
  });
  return { response, calls, root, scriptPath };
}

function writeFixtureFiles(root: string, files: Record<string, string> | undefined): void {
  for (const [name, contents] of Object.entries(files ?? {})) {
    fs.writeFileSync(path.join(root, name), contents);
  }
}

function createFixtureInvoke(params: {
  calls: CapturedInvocation[];
  delegate: DaemonInvokeFn | undefined;
  isMaestro: boolean;
}): DaemonInvokeFn {
  return async (req) => {
    params.calls.push({
      command: req.command,
      positionals: req.positionals,
      input: req.input,
      flags: req.flags,
    });
    if (params.delegate) return await params.delegate(req);
    if (params.isMaestro && req.command === 'snapshot') {
      return { ok: true, data: { createdAt: 0, nodes: [] } };
    }
    if (params.isMaestro && req.command === 'runtime') {
      return { ok: true, data: { viewport: { x: 0, y: 0, width: 400, height: 800 } } };
    }
    return { ok: true, data: {} };
  };
}

function fixtureReplayRequest(params: {
  root: string;
  scriptPath: string;
  flags: CommandFlags | undefined;
  isMaestro: boolean;
  scriptSource: ReplayScriptSourceBundle;
}): DaemonRequest {
  return {
    token: 't',
    session: 's',
    command: 'replay',
    positionals: [params.scriptPath],
    flags: {
      ...(params.flags ?? {}),
      ...(params.isMaestro && params.flags?.platform === undefined ? { platform: 'ios' } : {}),
      replayScriptSource: params.scriptSource,
    },
    meta: { cwd: params.root },
  };
}

function assertNoUnresolvedInterpolation(calls: CapturedInvocation[]): void {
  for (const call of calls) {
    for (const pos of call.positionals ?? []) {
      assert.equal(pos.includes('${'), false, `unresolved interpolation leaked: ${pos}`);
    }
  }
}

/**
 * The shared helpers plus the replay SUT entry. `runReplayForTest` rides the object
 * (not a re-export through the hoisted transform) so siblings reach the engine loaded
 * under the mocks above.
 */
export const maestroReplayFixture = Object.freeze({
  assertNoUnresolvedInterpolation,
  runReplayFixture,
  runReplayForTest,
});
