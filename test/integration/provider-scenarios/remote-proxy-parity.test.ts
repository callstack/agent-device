import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { sendToDaemon } from '../../../src/daemon/client/daemon-client.ts';
import { createDaemonHttpServer } from '../../../src/daemon/server/http-server.ts';
import { resolveSessionRequestLogPath } from '../../../src/daemon/session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../../../src/daemon/types.ts';
import { createDaemonProxyServer } from '../../../src/remote/daemon-proxy.ts';
import { AppError, type DaemonError } from '@agent-device/kernel/errors';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../src/__tests__/test-utils/loopback.ts';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { createProviderScenarioHarness, type ProviderScenarioHarness } from './harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlDeviceLifecycleHandler,
  type FlatToolCall,
} from './providers.ts';
import { PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS } from './test-timeouts.ts';
import { createProviderTranscript, type ProviderScenarioTranscript } from './transcript.ts';

/**
 * #2198 slice B: the proxy publishes exactly what the daemon publishes. Both legs run the same
 * script over the same deterministic Simulator acquisition fixture; the only things allowed to
 * differ are transport timing and request identity.
 */

type ScenarioRequest = Omit<DaemonRequest, 'token'>;
type ScenarioLeg = (request: ScenarioRequest) => Promise<DaemonResponse>;

const SIM = PROVIDER_SCENARIO_IOS_SIMULATOR;
const APP = 'com.apple.Preferences';
const PROXY_TOKEN = 'proxy-parity-token';
const VOLATILE_KEYS = new Set([
  'requestId',
  'diagnosticId',
  'logPath',
  'timing',
  'durationMs',
  'elapsedMs',
  'timestamp',
  'capturedAt',
  'startedAt',
  'completedAt',
  'measuredAt',
  'maxMs',
  'p50Ms',
  'p95Ms',
  // Session identity minted per open; refs are compared, the generation stamp is not.
  'refsGeneration',
]);
/** Fields the wire may re-home (paths) or re-issue (ids) but must never lose. */
const PRESERVED_ERROR_KEYS = ['hint', 'details', 'diagnosticId', 'logPath'] as const;

type ParityWorld = {
  daemon: ProviderScenarioHarness;
  appleTool: { calls: FlatToolCall[] };
  runnerTranscript: ProviderScenarioTranscript;
  close: () => Promise<void>;
};

function scriptedTree() {
  return {
    nodes: [
      {
        index: 0,
        type: 'XCUIElementTypeCell',
        label: 'General',
        identifier: 'General',
        rect: { x: 16, y: 100, width: 360, height: 44 },
        enabled: true,
        hittable: true,
      },
      {
        index: 1,
        type: 'XCUIElementTypeApplication',
        label: 'Settings',
        identifier: APP,
        rect: { x: 0, y: 0, width: 393, height: 852 },
        enabled: true,
        hittable: true,
      },
    ],
    truncated: false,
  };
}

async function createParityWorld(): Promise<ParityWorld> {
  const runnerTranscript = createProviderTranscript([
    {
      command: 'ios.runner.snapshot',
      deviceId: SIM.id,
      platform: 'apple',
      repeat: true,
      result: scriptedTree,
    },
  ]);
  const appleTool = createRecordingAppleToolProvider({
    simctl: simctlDeviceLifecycleHandler('com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
      { name: SIM.name, udid: SIM.id },
    ]),
  });
  const daemon = await createProviderScenarioHarness({
    platformRuntime: true,
    appleRunnerProvider: () =>
      createAppleRunnerProviderFromTranscript(runnerTranscript, 'ios.runner'),
    appleToolProvider: () => appleTool.provider,
    deviceInventoryProvider: async () => [SIM],
  });
  return { daemon, appleTool, runnerTranscript, close: () => daemon.close() };
}

function parityScript(): readonly ScenarioRequest[] {
  const flags = { platform: 'ios', udid: SIM.id } as const;
  return [
    { session: 'default', command: 'open', positionals: [APP], flags },
    {
      session: 'default',
      command: 'snapshot',
      positionals: [],
      flags: { snapshotInteractiveOnly: true },
    },
    { session: 'default', command: 'snapshot', positionals: [], flags: { snapshotRaw: true } },
    {
      session: 'default',
      command: 'diff',
      positionals: ['snapshot'],
      flags: { snapshotInteractiveOnly: true },
    },
    { session: 'default', command: 'click', positionals: ['@e404'], flags: {} },
    { session: 'default', command: 'appstate', positionals: [], flags },
    { session: 'default', command: 'close', positionals: [], flags: {} },
    // A fresh session after cleanup starts its comparison state from nothing.
    { session: 'default', command: 'open', positionals: [APP], flags },
    {
      session: 'default',
      command: 'diff',
      positionals: ['snapshot'],
      flags: { snapshotInteractiveOnly: true },
    },
    { session: 'default', command: 'close', positionals: [], flags: {} },
  ];
}

/**
 * The published form of a response with transport identity removed: JSON drops `undefined`
 * exactly like the wire does, every path under the world's session root becomes the same
 * token, and per-request log files lose the request id in their name.
 */
function stripVolatile(value: unknown, sessionRoot: string): unknown {
  return stripVolatileKeys(JSON.parse(JSON.stringify(value)), sessionRoot);
}

function stripVolatileKeys(value: unknown, sessionRoot: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripVolatileKeys(entry, sessionRoot));
  if (typeof value === 'string') {
    return value
      .split(sessionRoot)
      .join('<session-root>')
      .replace(/\/requests\/[^/]+\.ndjson$/, '/requests/<request>.ndjson');
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !VOLATILE_KEYS.has(key))
      .map(([key, entry]) => [key, stripVolatileKeys(entry, sessionRoot)]),
  );
}

function sessionRootOf(daemon: ProviderScenarioHarness): string {
  return path.dirname(daemon.sessionDir());
}

const ERROR_ENVELOPE_KEYS = [
  'hint',
  'diagnosticId',
  'logPath',
  'logPathUnavailable',
  'diagnosticsRecord',
  'retriable',
  'supportedOn',
  'requestId',
] as const;

/**
 * The remote client raises daemon failures as `AppError`s whose details carry the error
 * envelope; fold that back into the daemon's own response shape so both legs compare alike.
 */
function responseFromClientError(error: unknown): DaemonResponse {
  if (!(error instanceof AppError)) throw error;
  const details: Record<string, unknown> = { ...(error.details ?? {}) };
  const envelope: Partial<Record<(typeof ERROR_ENVELOPE_KEYS)[number], unknown>> = {};
  for (const key of ERROR_ENVELOPE_KEYS) {
    if (key in details) {
      envelope[key] = details[key];
      delete details[key];
    }
  }
  delete envelope.requestId;
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(Object.keys(details).length > 0 ? { details } : {}),
      ...envelope,
    } as DaemonError,
  };
}

async function runLeg(leg: ScenarioLeg, legName: string): Promise<DaemonResponse[]> {
  const responses: DaemonResponse[] = [];
  for (const [index, request] of parityScript().entries()) {
    responses.push(await leg({ ...request, meta: { requestId: `${legName}-${index + 1}` } }));
  }
  return responses;
}

async function withProxiedWorld<T>(
  run: (context: { world: ParityWorld; proxied: ScenarioLeg }) => Promise<T>,
): Promise<T> {
  const world = await createParityWorld();
  const upstream = await createDaemonHttpServer({
    token: world.daemon.token,
    handleRequest: world.daemon.handleRequest,
    // Same composition as the daemon runtime: remote clients localize failure records.
    resolveRequestDiagnosticsPath: (ref) =>
      resolveSessionRequestLogPath(world.daemon.sessionDir(ref.session), ref.requestId),
  });
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${await listenOnLoopback(upstream)}`,
    upstreamToken: world.daemon.token,
    clientToken: PROXY_TOKEN,
  });
  // The remote client's own state dir: localized failure records land here, not in the
  // developer's real state dir.
  const clientStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-proxy-parity-'));
  try {
    const daemonBaseUrl = `http://127.0.0.1:${await listenOnLoopback(proxy)}/agent-device`;
    const proxied: ScenarioLeg = async (request) => {
      try {
        return await sendToDaemon(
          { ...request, flags: { ...request.flags, daemonBaseUrl, stateDir: clientStateDir } },
          { authToken: PROXY_TOKEN },
        );
      } catch (error) {
        return responseFromClientError(error);
      }
    };
    return await run({ world, proxied });
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
    await world.close();
    fs.rmSync(clientStateDir, { recursive: true, force: true });
  }
}

type LegRun = { responses: DaemonResponse[]; sessionRoot: string };

function assertPublishedParity(direct: LegRun, proxied: LegRun): void {
  const script = parityScript();
  assert.equal(proxied.responses.length, direct.responses.length);
  direct.responses.forEach((directResponse, index) => {
    const proxiedResponse = proxied.responses[index];
    const step = `${index + 1}:${script[index]?.command}`;
    assert.deepEqual(
      stripVolatile(proxiedResponse, proxied.sessionRoot),
      stripVolatile(directResponse, direct.sessionRoot),
      `proxy diverged from direct execution at step ${step}`,
    );
    if (directResponse.ok || !proxiedResponse || proxiedResponse.ok) return;
    assertErrorEnvelopeKept(directResponse.error, proxiedResponse.error, step);
  });
}

/**
 * The remote client may add to the envelope (it materializes the failure record locally,
 * which yields a logPath the daemon never published); it may not lose anything.
 */
function assertErrorEnvelopeKept(direct: DaemonError, proxied: DaemonError, step: string): void {
  for (const key of PRESERVED_ERROR_KEYS) {
    if (direct[key] === undefined) continue;
    assert.equal(
      typeof proxied[key],
      typeof direct[key],
      `proxy lost error.${key} at step ${step}`,
    );
  }
}

function baselineInitialized(response: DaemonResponse | undefined): boolean | undefined {
  if (!response?.ok) return undefined;
  return (response.data as { baselineInitialized?: boolean } | undefined)?.baselineInitialized;
}

/** The script exercised what it claims to: successes, one typed failure, a fresh baseline. */
function assertScriptOutcomes(responses: DaemonResponse[]): void {
  const [open, snapshot, raw, diff, missingRef, , , , freshDiff] = responses;
  assert.equal(open?.ok, true);
  assert.equal(snapshot?.ok, true);
  assert.equal(raw?.ok, true);
  assert.equal(baselineInitialized(diff), false);
  assert.equal(missingRef?.ok, false);
  assert.equal(
    baselineInitialized(freshDiff),
    true,
    'a session reopened after cleanup must not compare against the previous session tree',
  );
}

test(
  'Provider-backed integration proxy execution publishes what direct daemon execution publishes',
  async (t) => {
    if (await skipWhenLoopbackUnavailable(t, 'daemon proxy parity coverage')) return;

    const directWorld = await createParityWorld();
    let direct: LegRun;
    try {
      direct = {
        responses: await runLeg(
          async (request) =>
            await directWorld.daemon.handleRequest({ ...request, token: directWorld.daemon.token }),
          'direct',
        ),
        sessionRoot: sessionRootOf(directWorld.daemon),
      };
    } finally {
      await directWorld.close();
    }

    const proxied = await withProxiedWorld(async ({ world, proxied: leg }) => ({
      responses: await runLeg(leg, 'proxied'),
      sessionRoot: sessionRootOf(world.daemon),
    }));

    assertPublishedParity(direct, proxied);
    assertScriptOutcomes(direct.responses);
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

test(
  'Provider-backed integration proxy clients contending for one device fail at lease admission',
  async (t) => {
    if (await skipWhenLoopbackUnavailable(t, 'daemon proxy parity coverage')) return;

    await withProxiedWorld(async ({ world, proxied }) => {
      const flags = { platform: 'ios', udid: SIM.id } as const;
      const first = await proxied({
        session: 'first',
        command: 'open',
        positionals: [APP],
        flags,
        meta: { cwd: '/workspace/first' },
      });
      assert.equal(first.ok, true, JSON.stringify(first));

      const callsBefore = world.appleTool.calls.length;
      const remainingBefore = world.runnerTranscript.remaining.length;
      const second = await proxied({
        session: 'second',
        command: 'open',
        positionals: [APP],
        flags,
        meta: { cwd: '/workspace/second' },
      });
      assert.equal(second.ok, false);
      if (second.ok) return;
      assert.equal(second.error.code, 'DEVICE_IN_USE');
      assert.equal(typeof second.error.hint, 'string');

      const callsAfter = world.appleTool.calls.slice(callsBefore);
      assert.deepEqual(
        callsAfter.filter(([, subcommand]) => subcommand !== 'list'),
        [],
        `the refused open must not reach platform work: ${JSON.stringify(callsAfter)}`,
      );
      assert.equal(world.runnerTranscript.remaining.length, remainingBefore);

      const close = await proxied({
        session: 'first',
        command: 'close',
        positionals: [],
        flags: {},
        meta: { cwd: '/workspace/first' },
      });
      assert.equal(close.ok, true, JSON.stringify(close));
    });
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);
