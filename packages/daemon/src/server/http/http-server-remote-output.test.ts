import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { SessionStore } from '../../core/session-store.ts';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { deviceIdentity } from '@agent-device/kernel/device';
import type {
  PerfNativeCaptureLiveHandle,
  PerfNativeCaptureSnapshot,
} from '@agent-device/contracts/perf-runtime';
import type {
  DaemonArtifact,
  DaemonResponse,
  DaemonResponseData,
} from '@agent-device/kernel/contracts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import {
  DAEMON_HTTP_NETWORK_ACCESS_HEADER,
  DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
} from '@agent-device/contracts/daemon-http';
import { parsePerfRuntimeRequest } from '@agent-device/capture-kit/perf-runtime-plan';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { createDaemonHttpServer } from './http-server.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import {
  makeAndroidSession,
  makeIosAppSession,
} from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { screenshotRuntimeFixture } from '../../__tests__/support/screenshot-runtime-fixture.ts';
import { screenshotCommandSurface } from '../../__tests__/support/screenshot-command-surface-fake.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  cleanupDownloadableArtifact,
  listDownloadableArtifacts,
  trackDownloadableArtifact,
} from '../../resources/artifact-tracking.ts';
import { finalizeDaemonResponse } from '../request-finalization.ts';
import { runBatchCommands } from '../../sessions/handlers/session-batch.ts';
import { makeRecordRuntimeHarness } from '../../sessions/handlers/__tests__/record-runtime.fixtures.ts';

type RpcBody = {
  result?: Extract<DaemonResponse, { ok: true }>;
  error?: { data?: { code?: string; details?: { reason?: string; field?: string } } };
};

function successfulData(body: RpcBody): DaemonResponseData {
  expect(body.result?.ok, JSON.stringify(body)).toBe(true);
  expect(body.result!.data).toBeDefined();
  return body.result!.data!;
}

function localEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  delete env.AGENT_DEVICE_HTTP_AUTH_EXPORT;
  return env;
}

async function withHttp(
  handleRequest: (request: DaemonRequest) => Promise<DaemonResponse>,
  run: (
    post: (params: Record<string, unknown>, remote?: boolean, tenant?: string) => Promise<RpcBody>,
    base: string,
  ) => Promise<void>,
  env = localEnv(),
): Promise<void> {
  const server = await createDaemonHttpServer({
    token: 'test-token',
    handleRequest,
    env,
    cwd: process.cwd(),
  });
  try {
    const base = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    await run(async (params, remote = true, tenant) => {
      const response = await fetch(`${base}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-token',
          ...(tenant ? { 'x-tenant': tenant } : {}),
          ...(remote
            ? { [DAEMON_HTTP_NETWORK_ACCESS_HEADER]: DAEMON_HTTP_PUBLIC_NETWORK_ACCESS }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'output',
          method: 'agent-device.command',
          params,
        }),
      });
      return (await response.json()) as RpcBody;
    }, base);
  } finally {
    await closeLoopbackServer(server);
  }
}

const outputCases = [
  { command: 'screenshot', positionals: ['/host/screenshot.png'] },
  { command: 'screenshot', positionals: [], flags: { out: '../screenshot.png' } },
  { command: 'screenshot', positionals: [], input: { path: '~/screenshot.png' } },
  { command: 'record', positionals: ['START', '/host/movie.mp4'] },
  { command: 'record', positionals: ['start'], flags: { out: '/host/movie.mp4' } },
  { command: 'record', positionals: ['start'], input: { path: '/host/movie.mp4' } },
  { command: 'perf', positionals: ['memory', 'snapshot'], flags: { out: '/host/heap.hprof' } },
  ...['start', 'stop', 'report'].flatMap((action) => [
    {
      command: 'perf',
      positionals: ['CPU', 'PROFILE', action, 'simpleperf', '', '/host/cpu.data'],
    },
    {
      command: 'perf',
      positionals: ['cpu', 'profile', action, 'simpleperf'],
      flags: { out: '/host/cpu.data' },
    },
  ]),
  ...['start', 'stop'].flatMap((action) => [
    { command: 'perf', positionals: ['TRACE', action, 'perfetto', '', '/host/trace.data'] },
    {
      command: 'perf',
      positionals: ['trace', action, 'perfetto'],
      flags: { out: '/host/trace.data' },
    },
  ]),
  { command: 'trace', positionals: ['start', '/host/trace.log'] },
  { command: 'trace', positionals: ['stop', '/host/trace.log'] },
];

test.each(outputCases)(
  'remote output admission normalizes $command $positionals $flags $input',
  async (params) => {
    await withHttp(
      async (request) => {
        const perf =
          request.command === 'perf'
            ? parsePerfRuntimeRequest({
                positionals: request.positionals,
                outPath: request.flags?.out,
              })
            : undefined;
        return { ok: true, data: { request, ...(perf ? { perf } : {}) } };
      },
      async (post) => {
        const body = await post({ ...params, meta: { cwd: '/host/chosen-root' } });
        expect(body.error).toBeUndefined();
        expect(body.result?.ok).toBe(true);
        const request = body.result?.data?.request as DaemonRequest;
        expect(request.meta).not.toHaveProperty('cwd');
        expect(request.flags).not.toHaveProperty('out');
        expect(request.input ?? {}).not.toHaveProperty('path');
        expect(JSON.stringify(request.positionals)).not.toContain('/host/');
        if (params.command === 'perf')
          expect(body.result?.data?.perf).not.toHaveProperty('outPath');
      },
    );
  },
);

for (const field of [
  'saveScript',
  'sessionSaveScript',
  'launchConsole',
  'baseline',
  'stepsFile',
  'searchPath',
  'metroProjectRoot',
  'metroRuntimeFile',
  'iosXctestrunFile',
  'iosXctestDerivedDataPath',
  'iosXctestEnvDir',
  'iosSimulatorDeviceSet',
]) {
  test.each(['flags', 'input'])(
    'remote admission refuses host field ' + field + ' in %s',
    async (carrier) => {
      let dispatched = false;
      await withHttp(
        async () => {
          dispatched = true;
          return { ok: true };
        },
        async (post) => {
          const body = await post({ command: 'open', [carrier]: { [field]: '/host/target' } });
          expect(body.error?.data).toMatchObject({
            code: 'INVALID_ARGS',
            details: {
              reason: 'REMOTE_HOST_INPUT_DENIED',
              field,
            },
          });
          expect(dispatched).toBe(false);
        },
      );
    },
  );
}

test.each(['marker', 'auth-hook', 'batch'] as const)(
  'remote screenshot preserves the host file and downloads generated PNG through %s',
  async (route) => {
    const root = mkdtempForTestSync('remote-output-');
    const victim = path.join(root, 'protected.png');
    fs.writeFileSync(victim, 'protected-content');
    const symlink = path.join(root, 'agent-device-screenshot-1700000000000-abc123.png');
    fs.symlinkSync(victim, symlink);
    const sessionStore = makeSessionStore('remote-output-sessions-');
    const effectiveSession = route === 'auth-hook' ? 'tenant-a:capture' : 'capture';
    sessionStore.publish(
      effectiveSession,
      makeAndroidSession(
        effectiveSession,
        route === 'auth-hook' ? { sessionScope: { kind: 'tenant', id: 'tenant-a' } } : {},
      ),
    );
    const runtime = screenshotRuntimeFixture();
    const leaseRegistry = new LeaseRegistry();
    const lease =
      route === 'auth-hook'
        ? leaseRegistry.allocateLease({
            tenantId: 'tenant-a',
            runId: 'run-a',
            leaseBackend: 'android-instance',
          })
        : undefined;
    const handler = createRequestHandler({
      host: createTestHostEnvironment(),
      createCommandSurface: screenshotCommandSurface,
      logPath: path.join(root, 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry,
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      deviceRuntimeGateway: runtime.gateway,
      trackDownloadableArtifact,
    });
    const env = localEnv();
    if (route === 'auth-hook') {
      const hook = path.join(root, 'hook.mjs');
      fs.writeFileSync(hook, "export default () => ({ tenantId: 'tenant-a' });");
      env.AGENT_DEVICE_HTTP_AUTH_HOOK = hook;
    }
    await withHttp(
      handler,
      async (post, base) => {
        const shot = { command: 'screenshot', positionals: [symlink], flags: { out: victim } };
        const body = await post(
          {
            ...(route === 'batch'
              ? {
                  command: 'batch',
                  flags: {
                    out: victim,
                    batchSteps: [{ ...shot, command: ' SCREENSHOT ' }],
                  },
                }
              : shot),
            session: 'capture',
            meta: {
              cwd: root,
              sessionExplicit: true,
              runId: 'run-a',
              ...(lease ? { leaseId: lease.leaseId, leaseBackend: lease.backend } : {}),
            },
          },
          route !== 'auth-hook',
        );
        expect(body.error).toBeUndefined();
        expect(body.result?.ok).toBe(true);
        expect(fs.readFileSync(victim, 'utf8')).toBe('protected-content');
        const data =
          route === 'batch'
            ? (body.result!.data!.results as Array<{ data: { artifacts: DaemonArtifact[] } }>)[0]
                ?.data
            : body.result?.data;
        const artifact = data?.artifacts?.[0];
        expect(artifact?.artifactId).toBeTypeOf('string');
        const download = await fetch(`${base}/artifacts/${artifact?.artifactId}`, {
          headers: { authorization: 'Bearer test-token' },
        });
        expect(download.status).toBe(200);
        const bytes = Buffer.from(await download.arrayBuffer());
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(runtime.captureScreenshot).toHaveBeenCalledTimes(1);
      },
      env,
    );
  },
);

test('local HTTP still honors capture destinations and cwd', async () => {
  const meta = { cwd: '/local/project' };
  await withHttp(
    async (request) => ({ ok: true, data: { request } }),
    async (post) => {
      const params = {
        command: 'screenshot',
        positionals: ['local.png'],
        flags: { out: 'flag.png' },
        meta,
      };
      const body = await post(params, false);
      expect(body.result?.data?.request).toMatchObject(params);
    },
  );
});

test('remote recording without client metadata stays in its session and downloads by ID', async () => {
  const harness = makeRecordRuntimeHarness('remote-record-output-');
  const root = mkdtempForTestSync('remote-record-victim-');
  const victim = path.join(root, 'protected.mp4');
  fs.writeFileSync(victim, 'protected-content');
  const start = harness.runtime.start.getMockImplementation()!;
  harness.runtime.start.mockImplementation(async (input) => {
    fs.writeFileSync(input.outputPath, 'generated-video');
    return await start(input);
  });
  await withHttp(
    async (request) =>
      finalizeDaemonResponse(
        request,
        await harness.run(request.positionals, request.meta, request.flags, request.internal),
        trackDownloadableArtifact,
      ),
    async (post, base) => {
      const started = await post({
        command: 'record',
        positionals: ['start', victim],
        meta: { cwd: root },
      });
      expect(started.result?.ok).toBe(true);
      const output = started.result?.data?.outPath as string;
      expect(path.dirname(output)).toBe(
        harness.sessionStore.resolveSessionDir(harness.sessionName),
      );
      expect(output).toMatch(/recording-[0-9a-f-]+\.mp4$/);
      expect(fs.readFileSync(victim, 'utf8')).toBe('protected-content');
      const stopped = await post({ command: 'record', positionals: ['stop'] });
      expect(stopped.result?.ok).toBe(true);
      const artifact = stopped.result?.data?.artifacts?.[0];
      expect(artifact?.artifactId).toBeTypeOf('string');
      const download = await fetch(`${base}/artifacts/${artifact?.artifactId}`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(download.status).toBe(200);
      expect(await download.text()).toBe('generated-video');
    },
  );
});

test.each(['local', 'local-client-destination', 'remote'] as const)(
  'recording output ownership follows its %s start rather than its stop caller',
  async (origin) => {
    const harness = makeRecordRuntimeHarness('mixed-origin-record-output-');
    const root = mkdtempForTestSync('mixed-origin-record-file-');
    const callerOutput = path.join(root, 'caller.mp4');
    const start = harness.runtime.start.getMockImplementation()!;
    harness.runtime.start.mockImplementation(async (input) => {
      fs.writeFileSync(input.outputPath, 'recorded-video');
      return await start(input);
    });
    await withHttp(
      async (request) =>
        finalizeDaemonResponse(
          request,
          await harness.run(request.positionals, request.meta, request.flags, request.internal),
          trackDownloadableArtifact,
        ),
      async (post) => {
        const started = await post(
          {
            command: 'record',
            positionals: ['start', callerOutput],
            ...(origin === 'local-client-destination'
              ? { meta: { clientArtifactPaths: { outPath: '/client/copied.mp4' } } }
              : {}),
          },
          origin === 'remote',
        );
        expect(started.result?.ok, JSON.stringify(started)).toBe(true);
        const stopped = await post(
          { command: 'record', positionals: ['stop'] },
          origin !== 'remote',
        );
        expect(stopped.result?.ok, JSON.stringify(stopped)).toBe(true);
        const artifactId = stopped.result?.data?.artifacts?.[0]?.artifactId;
        if (origin === 'remote') {
          expect(artifactId).toBeTypeOf('string');
          cleanupDownloadableArtifact(artifactId!);
        } else {
          expect(artifactId).toBeUndefined();
          const inventory = await listDownloadableArtifacts(undefined);
          expect(
            inventory.some(
              ({ filename }) => filename === 'caller.mp4' || filename === 'copied.mp4',
            ),
          ).toBe(false);
          expect(fs.readFileSync(callerOutput, 'utf8')).toBe('recorded-video');
        }
      },
    );
  },
);

test.each(['local', 'remote'] as const)(
  'trace output ownership follows its %s start through a different stop caller',
  async (origin) => {
    const root = mkdtempForTestSync('mixed-origin-trace-');
    const callerOutput = path.join(root, 'caller.trace');
    const sessionStore = makeSessionStore('mixed-origin-trace-session-');
    sessionStore.publish('capture', makeAndroidSession('capture'));
    const handler = createRequestHandler({
      host: createTestHostEnvironment(),
      createCommandSurface: screenshotCommandSurface,
      logPath: path.join(root, 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      trackDownloadableArtifact,
    });
    await withHttp(handler, async (post, base) => {
      const started = await post(
        { command: 'trace', session: 'capture', positionals: ['start', callerOutput] },
        origin === 'remote',
      );
      expect(started.result?.ok).toBe(true);
      const output = started.result?.data?.outPath as string;
      fs.appendFileSync(output, 'recorded-trace');
      const stopped = await post(
        { command: 'trace', session: 'capture', positionals: ['stop'] },
        origin !== 'remote',
      );
      expect(stopped.result?.ok).toBe(true);
      const artifactId = stopped.result?.data?.artifacts?.[0]?.artifactId;
      if (origin === 'remote') {
        expect(artifactId).toBeTypeOf('string');
        const download = await fetch(`${base}/artifacts/${artifactId}`, {
          headers: { authorization: 'Bearer test-token' },
        });
        expect(download.status).toBe(200);
        expect(await download.text()).toContain('recorded-trace');
      } else {
        expect(artifactId).toBeUndefined();
        expect(fs.readFileSync(callerOutput, 'utf8')).toContain('recorded-trace');
      }
    });
  },
);

test('nested remote dispatch normalizes host outputs again below HTTP', async () => {
  const root = mkdtempForTestSync('nested-remote-output-');
  const victim = path.join(root, 'protected.png');
  fs.writeFileSync(victim, 'protected-content');
  const sessionStore = makeSessionStore('nested-remote-session-');
  sessionStore.publish('capture', makeAndroidSession('capture'));
  const runtime = screenshotRuntimeFixture();
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: screenshotCommandSurface,
    logPath: path.join(root, 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: runtime.gateway,
    trackDownloadableArtifact,
  });
  const response = await handler({
    token: 'test-token',
    session: 'capture',
    command: 'screenshot',
    positionals: [victim],
    flags: { out: victim },
    meta: { cwd: root, sessionExplicit: true },
    internal: { publicNetworkOnly: true },
  });
  expect(response.ok).toBe(true);
  expect(fs.readFileSync(victim, 'utf8')).toBe('protected-content');
  if (response.ok) expect(response.data?.artifacts?.[0]?.artifactId).toBeTypeOf('string');
});

test.each(
  (
    [
      { kind: 'simpleperf', area: 'cpu' },
      { kind: 'xctrace', area: 'cpu' },
      { kind: 'perfetto', area: 'trace' },
      { kind: 'xctrace', area: 'trace' },
    ] as const
  ).flatMap((capture) =>
    (['remote', 'local', 'remote-local-stop', 'relocated'] as const).map((origin) => ({
      ...capture,
      origin,
    })),
  ),
)(
  '$origin $kind $area capture keeps producer output ownership through stop',
  async ({ kind, area, origin }) => {
    const root = mkdtempForTestSync('remote-native-perf-');
    const sessionStore = makeSessionStore('remote-native-perf-session-');
    const session =
      kind === 'xctrace'
        ? makeIosAppSession('capture')
        : makeAndroidSession('capture', { appBundleId: 'com.example.app' });
    const device = session.device;
    sessionStore.publish('capture', session);
    const base = screenshotRuntimeFixture().gateway;
    const inspectFacts: typeof base.inspectFacts = async (...args) => {
      const facts = await base.inspectFacts(...args);
      return {
        ...facts,
        operations: {
          ...facts.operations,
          perfNativeCaptureStart: { available: true },
          perfProfileReport: { available: true },
        },
      };
    };
    const handler = createRequestHandler({
      host: createTestHostEnvironment(),
      createCommandSurface: screenshotCommandSurface,
      logPath: path.join(root, 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      deviceRuntimeGateway: {
        ...base,
        inspectFacts,
        bind: async (request) => {
          const binding = await base.bind(request);
          return {
            ...binding,
            facts: await inspectFacts(request.device),
            operations: {
              ...binding.operations,
              perfNativeCaptureStart: async (input) => {
                let output = input.outPath;
                const snapshot = (stopped: boolean): PerfNativeCaptureSnapshot =>
                  ({
                    kind,
                    mode: area === 'cpu' ? 'cpu-profile' : 'trace',
                    ...(kind === 'xctrace'
                      ? {
                          perf: stopped ? 'stopped' : 'started',
                          template: 'Time Profiler',
                          platform: 'ios',
                          appBundleId: input.appId,
                          deviceId: device.id,
                        }
                      : {
                          action: stopped ? 'stop' : 'start',
                          platform: 'android',
                          type: area === 'cpu' ? 'cpu-profile' : 'trace',
                          packageName: input.appId,
                          appPid: '1712',
                          profilerPid: '6804',
                          state: stopped ? 'stopped' : 'running',
                          remotePath: '/data/local/tmp/generated-capture',
                          method: 'adb-shell-perfetto',
                          ...(stopped ? { sizeBytes: 17, durationMs: 2017 } : {}),
                        }),
                    outPath: output,
                  }) as PerfNativeCaptureSnapshot;
                const handle: PerfNativeCaptureLiveHandle = {
                  inspect: () => snapshot(false),
                  setOutputPath: (value) => {
                    output = value;
                  },
                  finish: async () => {
                    fs.mkdirSync(kind === 'xctrace' ? output : path.dirname(output), {
                      recursive: true,
                    });
                    fs.writeFileSync(
                      kind === 'xctrace' ? path.join(output, 'capture.bin') : output,
                      'generated-capture',
                    );
                    return { status: 'completed', result: snapshot(true) };
                  },
                  forceCleanup: async () => ({ status: 'cleaned' }),
                  [Symbol.asyncDispose]: async () => {},
                };
                return {
                  pendingHandle: new PendingTransferGuard(handle),
                  envelope: createDurableResourceEnvelope({
                    resourceKind: 'perf-capture',
                    sessionId: input.sessionId,
                    device: deviceIdentity(device),
                    owner: localRuntimeOwner(device.platform),
                    fence: input.fence,
                    lifecycle: 'open',
                    descriptor: { version: 1, body: { kind: 'fixture' } },
                  }),
                  response: snapshot(false),
                };
              },
              perfProfileReport: async ({ tracePath, outPath }) => {
                expect(
                  fs.readFileSync(
                    kind === 'xctrace' ? path.join(tracePath, 'capture.bin') : tracePath,
                    'utf8',
                  ),
                ).toBe('generated-capture');
                fs.writeFileSync(outPath, 'generated-report');
                return { outPath };
              },
            },
          };
        },
      },
      trackDownloadableArtifact,
    });
    await withHttp(handler, async (post, baseUrl) => {
      const positionals = (action: string) =>
        area === 'cpu' ? ['cpu', 'profile', action, kind] : ['trace', action, kind];
      const callerOutput = path.join(root, 'caller-capture');
      const started = await post(
        {
          command: 'perf',
          session: 'capture',
          positionals: positionals('start'),
          ...(origin === 'local' ? { flags: { out: callerOutput } } : {}),
        },
        origin !== 'local',
      );
      expect(successfulData(started).artifacts).toBeUndefined();
      const stopped = await post(
        {
          command: 'perf',
          session: 'capture',
          positionals: positionals('stop'),
          ...(origin === 'relocated' ? { flags: { out: callerOutput } } : {}),
          meta: { clientArtifactPaths: { outPath: '/client/capture' } },
        },
        origin !== 'remote-local-stop' && origin !== 'relocated',
      );
      const stoppedData = successfulData(stopped);
      expect(stoppedData).not.toHaveProperty('artifact');
      const artifact = stoppedData.artifacts?.[0];
      if (origin === 'local' || origin === 'relocated') {
        expect(artifact?.artifactId).toBeUndefined();
        expect(stoppedData.outPath).toBe(callerOutput);
        expect(
          fs.readFileSync(
            kind === 'xctrace' ? path.join(callerOutput, 'capture.bin') : callerOutput,
            'utf8',
          ),
        ).toBe('generated-capture');
        return;
      }
      expect(artifact?.artifactId).toBeTypeOf('string');
      const output = stoppedData.outPath as string;
      const download = await fetch(`${baseUrl}/artifacts/${artifact?.artifactId}`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(download.status).toBe(200);
      const payload = Buffer.from(await download.arrayBuffer());
      expect(
        kind === 'xctrace'
          ? gunzipSync(payload).includes(Buffer.from('generated-capture'))
          : payload.toString() === 'generated-capture',
      ).toBe(true);
      if (area === 'cpu') {
        expect(
          fs.readFileSync(kind === 'xctrace' ? path.join(output, 'capture.bin') : output, 'utf8'),
        ).toBe('generated-capture');
        const report = await post({
          command: 'perf',
          session: 'capture',
          positionals: positionals('report'),
        });
        const reportData = successfulData(report);
        const reportDownload = await fetch(
          `${baseUrl}/artifacts/${reportData.artifacts?.[0]?.artifactId}`,
          { headers: { authorization: 'Bearer test-token' } },
        );
        expect(reportDownload.status).toBe(200);
        expect(await reportDownload.text()).toBe('generated-report');
      } else await vi.waitFor(() => expect(fs.existsSync(output)).toBe(false));
    });
  },
);

test('batch recording keeps remote origin and generates a session-owned destination', async () => {
  const harness = makeRecordRuntimeHarness('remote-batch-record-');
  const response = await runBatchCommands(
    {
      token: 'test-token',
      session: harness.sessionName,
      command: 'batch',
      positionals: [],
      flags: { batchSteps: [{ command: 'record', positionals: ['start'] }] },
      meta: { cwd: '/client/chosen-root' },
      internal: { publicNetworkOnly: true },
    },
    harness.sessionName,
    async (request) =>
      await harness.run(request.positionals, request.meta, request.flags, request.internal),
  );
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const results = response.data?.results as Array<{ data: { outPath: string } }>;
  expect(path.dirname(results[0]!.data.outPath)).toBe(
    harness.sessionStore.resolveSessionDir(harness.sessionName),
  );
  await harness.run(['stop']);
});

test('remote perf memory output reaches the runtime only as a session artifact and downloads by ID', async () => {
  const root = mkdtempForTestSync('remote-perf-memory-');
  const victim = path.join(root, 'protected.hprof');
  fs.writeFileSync(victim, 'protected-content');
  const sessionStore = makeSessionStore('remote-perf-memory-session-');
  sessionStore.publish('capture', makeAndroidSession('capture'));
  const base = screenshotRuntimeFixture().gateway;
  const inspectFacts: typeof base.inspectFacts = async (...args) => {
    const facts = await base.inspectFacts(...args);
    return {
      ...facts,
      operations: { ...facts.operations, perfMemorySnapshot: { available: true } },
    };
  };
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: screenshotCommandSurface,
    logPath: path.join(root, 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: {
      ...base,
      inspectFacts,
      bind: async (request) => {
        const binding = await base.bind(request);
        return {
          ...binding,
          facts: await inspectFacts(request.device),
          operations: {
            ...binding.operations,
            perfMemorySnapshot: async ({ outPath, artifactsDir }) => {
              const output = outPath ?? path.join(artifactsDir, 'memory.hprof');
              fs.mkdirSync(path.dirname(output), { recursive: true });
              fs.writeFileSync(output, 'generated-heap');
              return { artifact: { path: output } };
            },
          },
        };
      },
    },
    trackDownloadableArtifact,
  });
  await withHttp(handler, async (post, baseUrl) => {
    const body = await post({
      command: 'perf',
      session: 'capture',
      positionals: ['memory', 'snapshot'],
      flags: { out: victim },
      meta: { cwd: root, sessionExplicit: true },
    });
    expect(body.error).toBeUndefined();
    expect(body.result?.ok).toBe(true);
    expect(fs.readFileSync(victim, 'utf8')).toBe('protected-content');
    const data = body.result?.data;
    expect((data!.artifact as { path: string }).path).toBe(
      path.join(sessionStore.resolveSessionDir('capture'), 'artifacts', 'memory.hprof'),
    );
    const download = await fetch(`${baseUrl}/artifacts/${data?.artifacts?.[0]?.artifactId}`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('generated-heap');
  });
});

test.each(['./capture.log', undefined])(
  'remote trace start/stop retains only a client destination (%s)',
  async (destination) => {
    const root = mkdtempForTestSync('remote-trace-client-');
    const clientRoot = path.join(root, 'client');
    const sessionStore = makeSessionStore('remote-trace-session-');
    sessionStore.publish('capture', makeAndroidSession('capture'));
    const handler = createRequestHandler({
      host: createTestHostEnvironment(),
      createCommandSurface: screenshotCommandSurface,
      logPath: path.join(root, 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      trackDownloadableArtifact,
    });
    await withHttp(handler, async (post, baseUrl) => {
      const req = {
        command: 'trace',
        session: 'capture',
        positionals: ['start', ...(destination ? [destination] : [])],
        meta: { cwd: clientRoot },
      };
      const clientPath = destination ? path.resolve(clientRoot, destination) : undefined;
      const started = await post({
        ...req,
        meta: {
          ...req.meta,
          ...(clientPath ? { clientArtifactPaths: { outPath: clientPath } } : {}),
        },
      });
      expect(started.result?.ok, JSON.stringify(started)).toBe(true);
      const output = started.result?.data?.outPath as string;
      fs.appendFileSync(output, 'generated-trace');
      const stopRequest = {
        token: 'test-token',
        command: 'trace',
        session: 'capture',
        positionals: ['stop'],
        meta: { cwd: clientRoot },
      };
      const stopped = await post(stopRequest);
      expect(stopped.result?.ok, JSON.stringify(stopped)).toBe(true);
      const artifact = stopped.result?.data?.artifacts?.[0];
      expect(artifact?.localPath).toBe(clientPath);
      expect(artifact?.fileName).toBe(path.basename(clientPath ?? output));
      const download = await fetch(`${baseUrl}/artifacts/${artifact?.artifactId}`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(download.status).toBe(200);
      expect(await download.text()).toContain('generated-trace');
      await vi.waitFor(() => expect(fs.existsSync(output)).toBe(false));
    });
  },
);

test('remote suite artifacts belong to fresh tenant/session invocations despite repeated caller request IDs', async () => {
  const root = mkdtempForTestSync('remote-suite-ownership-');
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  try {
    const sessionStore = new SessionStore(
      path.join(root, 'sessions'),
      createTestHostEnvironment({ cwd: root }),
    );
    const scriptPath = path.join(root, 'flow.ad');
    const script = 'context platform=android\nwait 0\n';
    fs.writeFileSync(scriptPath, script);
    const leaseRegistry = new LeaseRegistry();
    const leases = new Map(
      ['tenant-a', 'tenant-b'].map((tenantId) => [
        tenantId,
        leaseRegistry.allocateLease({
          tenantId,
          runId: tenantId,
          leaseBackend: 'android-instance',
        }),
      ]),
    );
    const registrations: Array<{ path: string; tenant?: string }> = [];
    const handler = createRequestHandler({
      host: createTestHostEnvironment({ cwd: root }),
      createCommandSurface: screenshotCommandSurface,
      logPath: path.join(root, 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry,
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      trackDownloadableArtifact: (entry) => {
        registrations.push({ path: entry.artifactPath, tenant: entry.tenantId });
        return trackDownloadableArtifact(entry);
      },
    });
    const hook = path.join(root, 'hook.mjs');
    fs.writeFileSync(hook, "export default ({ headers }) => ({ tenantId: headers['x-tenant'] });");
    const env = { ...localEnv(), AGENT_DEVICE_HTTP_AUTH_HOOK: hook };
    await withHttp(
      handler,
      async (post, baseUrl) => {
        const runSuite = async (tenant: string) => {
          const lease = leases.get(tenant)!;
          const body = await post(
            {
              command: 'test',
              session: 'capture',
              positionals: [scriptPath],
              flags: {
                replayScriptSources: [{ entry: scriptPath, files: { [scriptPath]: script } }],
              },
              meta: {
                requestId: 'caller-chosen-collision',
                cwd: '/client',
                sessionExplicit: true,
                runId: tenant,
                leaseId: lease.leaseId,
                leaseBackend: lease.backend,
                clientArtifactPaths: { artifactsDir: '/client/downloads' },
              },
            },
            false,
            tenant,
          );
          expect(body.result?.ok, JSON.stringify(body)).toBe(true);
          expect(body.result?.data?.executed).toBe(1);
          expect(body.result?.data?.artifacts?.[0]?.artifactId).toBeTypeOf('string');
          return body.result!.data!.artifacts![0]!;
        };
        const first = await runSuite('tenant-a');
        const firstPath = registrations[0]!.path;
        fs.writeFileSync(path.join(firstPath, 'private-a.txt'), 'tenant-a-private-marker');
        const second = await runSuite('tenant-b');
        const secondPath = registrations[1]!.path;
        expect(secondPath).not.toBe(firstPath);
        expect(path.dirname(firstPath)).toBe(
          path.join(sessionStore.resolveSessionDir('tenant-a:capture'), 'test-artifacts'),
        );
        expect(path.dirname(secondPath)).toBe(
          path.join(sessionStore.resolveSessionDir('tenant-b:capture'), 'test-artifacts'),
        );
        const download = await fetch(`${baseUrl}/artifacts/${second.artifactId}`, {
          headers: { authorization: 'Bearer test-token', 'x-tenant': 'tenant-b' },
        });
        expect(download.status).toBe(200);
        const archive = gunzipSync(Buffer.from(await download.arrayBuffer()));
        expect(archive.includes(Buffer.from('tenant-a-private-marker'))).toBe(false);
        await vi.waitFor(() => expect(fs.existsSync(secondPath)).toBe(false));
        expect(fs.readFileSync(path.join(firstPath, 'private-a.txt'), 'utf8')).toBe(
          'tenant-a-private-marker',
        );
        const third = await runSuite('tenant-a');
        expect(registrations[2]!.path).not.toBe(firstPath);
        const forbidden = await fetch(`${baseUrl}/artifacts/${first.artifactId}`, {
          headers: { authorization: 'Bearer test-token', 'x-tenant': 'tenant-b' },
        });
        expect(forbidden.status).toBe(401);
        for (const artifact of [first, third]) {
          const own = await fetch(`${baseUrl}/artifacts/${artifact.artifactId}`, {
            headers: { authorization: 'Bearer test-token', 'x-tenant': 'tenant-a' },
          });
          expect(own.status).toBe(200);
          await own.arrayBuffer();
        }
        await vi.waitFor(() => {
          expect(fs.existsSync(firstPath)).toBe(false);
          expect(fs.existsSync(registrations[2]!.path)).toBe(false);
        });
      },
      env,
    );
  } finally {
    cwd.mockRestore();
  }
});
