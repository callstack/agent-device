import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { legacyDispatchCapture } from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { test, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from '@agent-device/capture-kit/png';
import { maestroReplayBackendPlugin } from '@agent-device/maestro/replay-backend';
import type {
  ReplayBackendCommand,
  ReplayBackendHost,
  ReplaySessionObservation,
  ReplaySessionStore,
} from '@agent-device/contracts/replay-backend';
import { LeaseRegistry } from '../../resources/lease-registry.ts';

import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { screenshotRuntimeFixture } from '../../__tests__/support/screenshot-runtime-fixture.ts';
import { screenshotCommandSurface as testCreateCommandSurface } from '../../__tests__/support/screenshot-command-surface-fake.ts';
import {
  ANDROID_EMULATOR,
  mkdtempForTestSync,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { makeSession } from '../../__tests__/support/session-factories.ts';
import { resolveSessionScreenshotsDir } from '@agent-device/daemon-contracts/session-artifact-paths';

// `scroll` still executes through legacy platform dispatch; this route binds its fake at the
// facts/bind seam like the neighbouring screenshot router tests do.
vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    getAndroidBlockingDialogObservation: vi.fn(async () => ({ status: 'clear' }) as const),
  };
});

beforeEach(() => {
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
});

/**
 * A remote Maestro flow arrives over the daemon's public network surface, so its flow script
 * is untrusted: a `takeScreenshot` step may not choose a destination on the daemon host, and
 * every step's capture must belong to that step alone. The run dispatches its steps onto one
 * session through the real request path here, with the flow's own request id on each nested
 * request — the replay dispatch envelope keeps that id, so two steps of one flow share it.
 */
test('a remote flow with two takeScreenshot steps reports two distinct, intact captures', async () => {
  const root = mkdtempForTestSync('remote-maestro-screenshot-');
  const flowPath = path.join(root, 'two-shots.yaml');
  const flowText = [
    '---',
    '- takeScreenshot: flow-shot.png',
    '- takeScreenshot: flow-shot-2.png',
    '',
  ].join('\n');
  fs.writeFileSync(flowPath, flowText);

  const sessionStore = makeSessionStore('agent-device-router-maestro-screenshot-');
  sessionStore.publish('default', makeSession('default', { device: ANDROID_EMULATOR }));
  const runtime = screenshotRuntimeFixture();
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: runtime.gateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const flowRequestId = 'req.remote-flow.1';
  const dispatchedPaths: string[] = [];
  const dispatchedPositionals: string[][] = [];
  const invoke: ReplayBackendCommand['invoke'] = async (request) => {
    // The untrusted flow path must not reach the daemon host as a destination.
    dispatchedPositionals.push([...(request.positionals ?? [])]);
    const response = await handler({
      token: request.token,
      session: request.session,
      command: request.command,
      positionals: request.positionals,
      flags: request.flags,
      meta: { requestId: flowRequestId },
    });
    if (request.command === 'screenshot' && response.ok) {
      dispatchedPaths.push(response.data?.path as string);
    }
    return response;
  };

  const response = await maestroReplayBackendPlugin.create(maestroReplayHost()).runReplay({
    request: {
      token: 'test-token',
      session: 'default',
      command: 'run',
      positionals: [flowPath],
      flags: {
        replayBackend: 'maestro',
        replayScriptSource: { entry: flowPath, files: { [flowPath]: flowText } },
      },
    },
    host: { env: {}, cwd: root },
    publicNetworkOnly: true,
    session: {
      name: 'default',
      logPath: path.join(root, 'session.ndjson'),
      store: maestroSessionStoreFixture(),
      observationStore: maestroObservationStoreFixture(),
    },
    invoke,
  });

  expect(response.ok).toBe(true);
  expect(dispatchedPositionals).toEqual([[], []]);

  // Each step asked the daemon once and received its own minted capture file.
  expect(dispatchedPaths).toHaveLength(2);
  const [first, second] = dispatchedPaths;
  expect(first).not.toBe(second);
  const mintDir = resolveSessionScreenshotsDir(sessionStore.resolveSessionDir('default'));
  for (const capturePath of dispatchedPaths) {
    expect(path.dirname(capturePath)).toBe(mintDir);
    const base = path.basename(capturePath);
    // The minted name carries the flow's own request id beside its per-capture suffix.
    expect(base.startsWith(`${flowRequestId}-`)).toBe(true);
    expect(base.endsWith('.png')).toBe(true);
    const image = PNG.sync.read(fs.readFileSync(capturePath));
    expect(image.width).toBeGreaterThan(0);
  }
  // The flow-authored names never landed anywhere on the daemon host, and the run's own
  // artifact list reports exactly the two captures.
  expect(fs.readdirSync(mintDir)).toHaveLength(2);
  expect(fs.existsSync(path.join(root, 'flow-shot.png'))).toBe(false);
  if (response.ok) {
    expect(response.data?.artifactPaths).toEqual(dispatchedPaths);
  }
});

function maestroReplayHost(): ReplayBackendHost {
  return {
    appendTraceEvent: () => {},
    buildBuiltinVars: () => ({}),
    readScriptSourceFile: (bundle, resolvedPath) => {
      const source = bundle.files[resolvedPath];
      if (source === undefined) throw new Error(`script source was not sent: ${resolvedPath}`);
      return source;
    },
    scriptSourceRequiredMessage: 'the script source bundle is required',
    resolveTargetDevice: async () => ANDROID_EMULATOR,
    requestSignal: () => undefined,
    buildActionFailureResponse: async () => ({
      ok: false,
      error: { code: 'REPLAY_DIVERGENCE', message: 'unused on a passing run' },
    }),
  };
}

function maestroSessionStoreFixture(): ReplaySessionStore {
  return {
    get: () => undefined,
    lookup: () => undefined,
    getRuntimeHints: () => undefined,
    ensureSessionDir: () => '/tmp/session',
    assertSelectorMatches: () => {},
    resolveOpenRuntimeHints: () => undefined,
  };
}

function maestroObservationStoreFixture(): ReplaySessionObservation {
  return {
    get: () => undefined,
    bindAuthority: () => {
      throw new Error('the host owns observation');
    },
  };
}
