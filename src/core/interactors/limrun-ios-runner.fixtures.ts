import { fileStore, type FileStoreOptions } from './limrun-ios-files.fixtures.ts';
import { createAppleApplicationTools } from '../../platform-runtime-apple-application-tools.ts';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, vi, type Mock } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';
import type { LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import { createLimrunIosRunner } from './limrun-ios-runner.ts';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

type Session = Parameters<LimrunRuntimeDependencies['ios']['createRunner']>[0];
type Manifest = {
  files: Array<{ path: string; mode: number }>;
  payloads: Array<{ path: string }>;
};
type RunnerFixture = {
  runner: Awaited<ReturnType<LimrunRuntimeDependencies['ios']['createRunner']>>;
  storage: ReturnType<typeof fileStore>;
  session: Session;
  directory: string;
  admit(): void;
  readonly admissionClosed: boolean | undefined;
  commands: Record<string, unknown>[];
  uploads: Manifest[];
  apiUrl: string;
  device: Session['device'];
  stopReadiness: Mock<() => void>;
  requests: string[];
  readonly manifest: Manifest | undefined;
  readonly environment: Record<string, string>;
  readonly command: Record<string, unknown> | undefined;
  readonly testRun: ServerResponse | undefined;
};

export async function fixture(
  options: {
    launchStatus?: number;
    holdLaunchErrorBody?: boolean;
    syncStatus?: number;
    holdReadiness?: boolean;
    holdGetenv?: boolean;
    holdAdmission?: boolean;
    canceledRunConflicts?: number;
    proof?: boolean;
    holdSnapshot?: boolean;
    holdShutdown?: boolean;
    failReset?: boolean;
    proxyHealthFailures?: number;
    idleMs?: number;
    simctlResult?: { code: number; stdout: string; stderr: string };
    loseTapReply?: 'completed' | 'started';
    busyTap?: boolean;
    screenshot?: Record<string, unknown>;
  } & FileStoreOptions = {},
): Promise<RunnerFixture> {
  const directory = await mkdtempForTest('limrun-runner-');
  const app = path.join(directory, 'AgentDeviceRunnerUITests-Runner.app');
  await fs.mkdir(path.join(app, 'PlugIns', 'AgentDeviceRunnerUITests.xctest'), { recursive: true });
  await fs.writeFile(path.join(app, 'Runner'), 'simulator runner', { mode: 0o755 });
  const requests: string[] = [];
  const commands: Record<string, unknown>[] = [];
  let manifest: Manifest | undefined;
  const uploads: Manifest[] = [];
  const environment: Record<string, string> = {};
  let command: Record<string, unknown> | undefined;
  let testRun: ServerResponse | undefined;
  let admitted: ServerResponse | undefined;
  let canceledRunConflicts = 0;
  const serveRunnerFault = (payload: Record<string, unknown>, response: ServerResponse) => {
    if (payload.command === 'uptime' && options.proxyHealthFailures) {
      options.proxyHealthFailures--;
      response.writeHead(502).end('upstream not listening');
      return true;
    }
    if (payload.command === 'tap' && options.loseTapReply) {
      response.destroy();
      return true;
    }
    if (payload.command === 'tap' && options.busyTap) {
      response.setHeader('X-Agent-Device-Runner-Auth', 'required');
      response.end(JSON.stringify({ ok: false, error: { code: 'RUNNER_BUSY', message: 'busy' } }));
      return true;
    }
    if (payload.command === 'status' && options.loseTapReply) {
      response.setHeader('X-Agent-Device-Runner-Auth', 'required');
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            lifecycleState: options.loseTapReply,
            lifecycleResponseJson: JSON.stringify({ ok: true, data: { recoveredTap: true } }),
          },
        }),
      );
      return true;
    }
    if (payload.command === 'targetReset' && options.failReset) {
      response.setHeader('X-Agent-Device-Runner-Auth', 'required');
      response.end(
        JSON.stringify({ ok: false, error: { code: 'RESET_FAILED', message: 'reset failed' } }),
      );
      return true;
    }
    return false;
  };
  const commandResults: Record<string, unknown> = {
    snapshot: {
      nodes: [
        {
          index: 0,
          type: 'Application',
          label: 'Settings',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 1,
          parentIndex: 0,
          type: 'Button',
          label: 'Continue',
          enabled: true,
          hittable: true,
          rect: { x: 20, y: 100, width: 150, height: 44 },
        },
      ],
      truncated: false,
      keyboard: { kind: 'absent' },
    },
    screenshot: options.screenshot ?? {},
  };
  const serveRunner = (request: IncomingMessage, response: ServerResponse, body: Buffer) => {
    if (!testRun) {
      response.writeHead(503).end();
      return;
    }
    if (
      request.url !== `/v1/ios_test/targetHttpPort${environment.PORT}/command` ||
      request.headers['x-agent-device-runner-token'] !== environment.TOKEN
    ) {
      response.writeHead(403).end();
      return;
    }
    const payload = JSON.parse(body.toString());
    commands.push(payload);
    if (serveRunnerFault(payload, response)) return;
    if (options.proof !== false || payload.command !== 'snapshot')
      response.setHeader('X-Agent-Device-Runner-Auth', 'required');
    if (payload.command === 'snapshot') {
      command = payload;
      if (options.holdSnapshot) return;
    }
    if (payload.command === 'shutdown') {
      if (options.holdShutdown) return;
      testRun.end();
      testRun = undefined;
    }
    response.end(
      JSON.stringify({ ok: true, data: commandResults[payload.command] ?? { uptime: 1 } }),
    );
  };
  const serveLaunch = (response: ServerResponse) => {
    if (canceledRunConflicts > 0) {
      canceledRunConflicts--;
      response.writeHead(409).end('A test run is already in progress');
      return;
    }
    if (options.launchStatus) {
      response.writeHead(options.launchStatus);
      response.flushHeaders();
      if (!options.holdLaunchErrorBody) response.end('test run unavailable');
      return;
    }
    testRun = response;
    admitted = response;
    response.once('close', () => {
      if (testRun === response) testRun = undefined;
      if (!response.writableEnded) canceledRunConflicts = options.canceledRunConflicts ?? 0;
    });
    if (options.holdAdmission) return;
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.flushHeaders();
  };
  const storage = fileStore(options);
  const server = createServer(async (request, response) => {
    requests.push(request.url!);
    if (request.headers.authorization !== 'Bearer instance-token') {
      response.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body = Buffer.concat(chunks);
    if (request.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
    if (storage.serve(request, response, body)) return;
    if (request.url === '/v1/ios_test/api/sync') {
      if (options.syncStatus) {
        response.writeHead(options.syncStatus).end('upload unavailable');
        return;
      }
      const size = body.readUInt32BE();
      manifest = JSON.parse(body.subarray(4, 4 + size).toString());
      uploads.push(manifest!);
      const xml = body.subarray(4 + size).toString();
      for (const key of ['PORT', 'TOKEN', 'BIND_IP']) {
        environment[key] = xml.match(
          new RegExp(`<key>AGENT_DEVICE_RUNNER_${key}</key><string>(.*?)</string>`),
        )![1]!;
      }
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === '/v1/ios_test/api/xctest/run') {
      serveLaunch(response);
      return;
    }
    serveRunner(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const stopReadiness: Mock<() => void> = vi.fn();
  const heldCommands = new Set([
    ...(options.holdReadiness ? ['bootstatus'] : []),
    ...(options.holdGetenv ? ['getenv'] : []),
  ]);
  const session = {
    apiUrl: `http://127.0.0.1:${address.port}/v1/ios_test/api`,
    token: 'instance-token',
    device: {
      id: 'limrun:ios:test',
      platform: 'apple',
      appleOs: 'ios',
      kind: 'simulator',
      name: 'Limrun iOS',
      booted: true,
    },
    client: {
      deviceInfo: { udid: 'remote-udid' },
      listApps: async () => [
        { bundleId: 'com.apple.Preferences', name: 'Settings', installType: 'System' },
      ],
      simctl: vi.fn((args: string[]) =>
        Object.assign(new EventEmitter(), {
          wait: () =>
            heldCommands.has(args[0]!)
              ? new Promise(() => {})
              : Promise.resolve(
                  args[0] === 'getenv'
                    ? {
                        code: 0,
                        stdout: args[2] === 'SIMULATOR_MAINSCREEN_SCALE' ? '3' : '10.244.1.2\n',
                        stderr: '',
                      }
                    : args[0] === 'list'
                      ? {
                          code: 0,
                          stdout: JSON.stringify({
                            devices: { ios: [{ udid: 'remote-udid', state: 'Booted' }] },
                          }),
                          stderr: '',
                        }
                      : (options.simctlResult ?? {
                          code: 0,
                          stdout:
                            args[0] === 'get_app_container'
                              ? `/containers/${args[2]}/${args[3]}`
                              : '',
                          stderr: '',
                        }),
                ),
          stop: stopReadiness,
        }),
      ),
    },
  } as unknown as Session;
  const host = {
    cwd: directory,
    env: {
      AGENT_DEVICE_LIMRUN_IOS_RUNNER_APP: app,
      ...(options.idleMs === undefined
        ? {}
        : { AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS: String(options.idleMs) }),
    },
  };
  const runner: Awaited<ReturnType<LimrunRuntimeDependencies['ios']['createRunner']>> =
    await createLimrunIosRunner(session, host, createAppleApplicationTools(host.env));
  cleanups.push(() => runner.dispose());
  return {
    runner,
    storage,
    session,
    directory,
    admit: () => {
      admitted?.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      admitted?.flushHeaders();
    },
    get admissionClosed() {
      return admitted?.destroyed;
    },
    commands,
    uploads,
    apiUrl: session.apiUrl,
    device: session.device,
    stopReadiness,
    requests,
    get manifest() {
      return manifest;
    },
    get environment() {
      return environment;
    },
    get command() {
      return command;
    },
    get testRun() {
      return testRun;
    },
  };
}
