import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { DEFAULT_PROXY_LEASE_TTL_MS } from '@agent-device/contracts/lease-scope';
import { sendToDaemon } from '../../../src/daemon-client/daemon-client.ts';
import { LeaseRegistry } from '../../../src/daemon/lease-registry.ts';
import { createDaemonHttpServer } from '../../../src/daemon/server/http-server.ts';
import { resolveSessionRequestLogPath } from '../../../src/daemon/session-artifact-paths.ts';
import type { DaemonRequest, DaemonResponse } from '../../../src/daemon/daemon-request.ts';
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

type ParityWorldOptions = { leaseRegistry?: LeaseRegistry };

async function createParityWorld(options: ParityWorldOptions = {}): Promise<ParityWorld> {
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
    ...(options.leaseRegistry ? { leaseRegistry: options.leaseRegistry } : {}),
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
  run: (context: { world: ParityWorld; proxied: ScenarioLeg; upstream: http.Server }) => Promise<T>,
  options: ParityWorldOptions = {},
): Promise<T> {
  const world = await createParityWorld(options);
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
    return await run({ world, proxied, upstream });
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
    await world.close();
    fs.rmSync(clientStateDir, { recursive: true, force: true });
  }
}

/**
 * Every request the proxy forwards upstream, in order. Registering a second `request`
 * listener records without displacing the server's own handler, so the daemon behaves
 * exactly as it does untraced.
 */
function recordUpstreamRequests(upstream: http.Server): { forwarded: ForwardedRequest[] } {
  const forwarded: ForwardedRequest[] = [];
  upstream.on('request', (req, res) => {
    const route = (req.url ?? '').split('?', 1)[0] ?? '';
    const entry: ForwardedRequest = { method: req.method ?? '', route, body: '' };
    const end = res.end.bind(res);
    const write = res.write.bind(res);
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      entry.body += textOf(chunk);
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof res.write;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      entry.body += textOf(chunk);
      return (end as (...args: unknown[]) => http.ServerResponse)(chunk, ...rest);
    }) as typeof res.end;
    forwarded.push(entry);
  });
  return { forwarded };
}

/** One request the proxy forwarded, with the exact bytes the daemon answered it with. */
type ForwardedRequest = { method: string; route: string; body: string };

function textOf(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return '';
}

/**
 * What a published `snapshot --interactive-only` response is made of. #2198 forbids the
 * internal acquired tree, lineage, target-generation facts and runner quality payload from
 * crossing as wire payloads, so the guard is the KEY SET, not a size: an extra field is
 * small, and one added inside the payload grows the wire and the client's copy together.
 */
const PUBLISHED_RPC_ENVELOPE_KEYS = ['id', 'jsonrpc', 'result'] as const;
const PUBLISHED_SNAPSHOT_RESULT_KEYS = ['data', 'ok'] as const;
const PUBLISHED_SNAPSHOT_DATA_KEYS = [
  'appBundleId',
  'appName',
  'nodes',
  'refsGeneration',
  'snapshotDiagnostics',
  'truncated',
  'visibility',
  'warnings',
] as const;

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

/**
 * #2198: "the regular-snapshot trace must prove the bridge adds no network round trip and
 * transfers only the published response." That was previously read off the RTT benchmark —
 * identical response bytes and an unchanged wall-clock slope — which is inference, not proof.
 * This asserts it: one `snapshot -i` behind the proxy forwards exactly one upstream request,
 * it is the RPC, and the bytes crossing are the published response and nothing else.
 *
 * The regression it guards is a second forwarded call per snapshot — a bridge, helper or
 * admin round trip appearing on the wire, which #2198 forbids outright.
 */
test(
  'a proxied snapshot forwards one upstream request and only the published response',
  {
    timeout: PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
  },
  async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    await withProxiedWorld(async ({ world, proxied, upstream }) => {
      const flags = { platform: 'ios', udid: SIM.id } as const;
      await proxied({ session: 'default', command: 'open', positionals: [APP], flags });

      // Record only the snapshot: the open above is setup and makes its own calls.
      const { forwarded } = recordUpstreamRequests(upstream);
      const response = await proxied({
        session: 'default',
        command: 'snapshot',
        positionals: [],
        flags: { snapshotInteractiveOnly: true },
      });
      assert.equal(response.ok, true);

      // The WHOLE wire conversation, not just the RPC, so any new call of any kind breaks
      // this. `GET /health` is the client's own ADR 0006 protocol-compatibility probe on the
      // remote path (`ensureRemoteDaemon`); it is not the bridge, and it predates the bridge.
      // The bridge itself contributes nothing: no helper, admin or acquisition route appears.
      assert.deepEqual(
        forwarded.map((entry) => `${entry.method} ${entry.route}`),
        ['GET /health', 'POST /rpc'],
        'a proxied snapshot must cross the wire only as the compat probe and the RPC',
      );

      // What crossed, read rather than sized, at every level of the payload. Comparing the
      // wire's `result` against the client's response would prove nothing — the client
      // publishes whatever `result` holds, so both sides move together — so each level is
      // pinned against its declared key set instead.
      const rpcBody = JSON.parse(forwarded.at(-1)?.body ?? '{}') as {
        result?: { data?: Record<string, unknown> };
      };
      assert.deepEqual(
        Object.keys(rpcBody).sort(),
        [...PUBLISHED_RPC_ENVELOPE_KEYS],
        'the upstream RPC body carried something beyond the JSON-RPC envelope',
      );
      assert.deepEqual(
        Object.keys(rpcBody.result ?? {}).sort(),
        [...PUBLISHED_SNAPSHOT_RESULT_KEYS],
        'the RPC result carried something beyond the published response',
      );
      assert.deepEqual(
        Object.keys(rpcBody.result?.data ?? {}).sort(),
        [...PUBLISHED_SNAPSHOT_DATA_KEYS],
        'the published snapshot payload carried a field it does not publish',
      );
      const sessionRoot = sessionRootOf(world.daemon);
      assert.deepEqual(
        stripVolatile(rpcBody.result, sessionRoot),
        stripVolatile(response, sessionRoot),
        'the result on the wire is not the response the client published',
      );
    });
  },
);

const LEASE_SCOPE = {
  tenantId: 'team-a',
  runId: 'run-a',
  clientId: 'client-a',
  deviceKey: SIM.id,
  leaseBackend: 'ios-simulator',
} as const;

test(
  'Provider-backed integration proxy lease expiry tears the session down and a reacquired lease starts with no comparison state',
  async (t) => {
    if (await skipWhenLoopbackUnavailable(t, 'daemon proxy parity coverage')) return;

    let now = 1_000_000;
    const leaseRegistry = new LeaseRegistry({ now: () => now });
    await withProxiedWorld(
      async ({ world, proxied }) => {
        const session = 'leased';
        const flags = { platform: 'ios', udid: SIM.id } as const;
        const allocate = async (): Promise<string> => {
          const response = await proxied({
            session,
            command: 'lease_allocate',
            positionals: [],
            flags: {},
            meta: LEASE_SCOPE,
          });
          assert.equal(response.ok, true, JSON.stringify(response));
          const leaseId = (response.ok ? response.data : {})?.lease as { leaseId?: string };
          assert.equal(typeof leaseId?.leaseId, 'string');
          return leaseId.leaseId!;
        };
        const run = async (
          command: string,
          positionals: string[],
          leaseId: string,
          stepFlags: DaemonRequest['flags'] = flags,
        ) =>
          await proxied({
            session,
            command,
            positionals,
            flags: stepFlags,
            meta: { ...LEASE_SCOPE, leaseId },
          });

        const firstLease = await allocate();
        assert.equal((await run('open', [APP], firstLease)).ok, true);
        assert.equal(
          (await run('snapshot', [], firstLease, { snapshotInteractiveOnly: true })).ok,
          true,
        );
        assert.equal(
          baselineInitialized(
            await run('diff', ['snapshot'], firstLease, { snapshotInteractiveOnly: true }),
          ),
          false,
          'the leased session holds comparison state before it expires',
        );

        // The lease lapses without a heartbeat; the next request through the proxy finds it expired.
        now += DEFAULT_PROXY_LEASE_TTL_MS + 1;
        const expired = await run('diff', ['snapshot'], firstLease, {
          snapshotInteractiveOnly: true,
        });
        assert.equal(expired.ok, false);
        if (expired.ok) return;
        assert.equal(expired.error.code, 'UNAUTHORIZED');
        assert.equal(expired.error.details?.reason, 'LEASE_NOT_FOUND');
        assert.equal(typeof expired.error.hint, 'string');
        assert.equal(world.daemon.session(session), undefined, 'expiry tears the session down');

        const secondLease = await allocate();
        assert.notEqual(secondLease, firstLease);
        assert.equal((await run('open', [APP], secondLease)).ok, true);
        assert.equal(
          baselineInitialized(
            await run('diff', ['snapshot'], secondLease, { snapshotInteractiveOnly: true }),
          ),
          true,
          'a reacquired lease must not compare against the expired session tree',
        );
        assert.equal((await run('close', [], secondLease, {})).ok, true);
      },
      { leaseRegistry },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

test(
  'Provider-backed integration proxy lease heartbeat renews the lease and keeps the session and its comparison state',
  async (t) => {
    if (await skipWhenLoopbackUnavailable(t, 'daemon proxy parity coverage')) return;

    let now = 2_000_000;
    const leaseRegistry = new LeaseRegistry({ now: () => now });
    await withProxiedWorld(
      async ({ world, proxied }) => {
        const session = 'renewed';
        const flags = { platform: 'ios', udid: SIM.id } as const;
        const allocated = await proxied({
          session,
          command: 'lease_allocate',
          positionals: [],
          flags: {},
          meta: LEASE_SCOPE,
        });
        assert.equal(allocated.ok, true, JSON.stringify(allocated));
        const lease = (allocated.ok ? allocated.data : {})?.lease as { leaseId: string };
        const meta = { ...LEASE_SCOPE, leaseId: lease.leaseId };
        const run = async (
          command: string,
          positionals: string[],
          stepFlags: DaemonRequest['flags'],
        ) => await proxied({ session, command, positionals, flags: stepFlags, meta });

        assert.equal((await run('open', [APP], flags)).ok, true);
        assert.equal((await run('snapshot', [], { snapshotInteractiveOnly: true })).ok, true);
        const heartbeatExpiry = async (): Promise<number> => {
          const heartbeat = await run('lease_heartbeat', [], {});
          assert.equal(heartbeat.ok, true, JSON.stringify(heartbeat));
          const renewed = (heartbeat.ok ? heartbeat.data : {})?.lease as { expiresAt: number };
          return renewed.expiresAt;
        };

        // One explicit heartbeat through the proxy just before the lease would lapse moves the
        // expiry forward; a request past the old expiry but inside the new window still finds
        // the session and its diff baseline.
        const firstExpiry = await heartbeatExpiry();
        now = firstExpiry - 1_000;
        const renewedExpiry = await heartbeatExpiry();
        assert.ok(renewedExpiry > firstExpiry, 'the heartbeat moved the expiry forward');
        now = firstExpiry + 1_000;
        const diff = await run('diff', ['snapshot'], { snapshotInteractiveOnly: true });
        assert.equal(diff.ok, true, JSON.stringify(diff));
        assert.equal(baselineInitialized(diff), false, 'the renewed session kept its baseline');
        assert.notEqual(world.daemon.session(session), undefined);
        assert.equal((await run('close', [], {})).ok, true);
      },
      { leaseRegistry },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);
