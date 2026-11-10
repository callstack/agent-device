import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { expect, test, vi } from 'vitest';
import {
  DAEMON_HTTP_NETWORK_ACCESS_HEADER,
  DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
} from '@agent-device/contracts/daemon-http';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { SessionStore } from '../../core/session-store.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { createDaemonHttpServer } from './http-server.ts';

const TOKEN = 'batch-maestro-trust-token';
const SCRIPT_CANARY = 'batch-maestro-script-executed';
const deniedReplay = {
  code: 'REPLAY_DIVERGENCE',
  details: { divergence: { cause: { code: 'UNAUTHORIZED' } } },
};
const deniedSuite = {
  total: 1,
  executed: 1,
  passed: 0,
  failed: 1,
  failures: [{ error: deniedReplay }],
};

const remoteCases = (['network-marker', 'auth-hook'] as const).flatMap((origin) =>
  (['host-runScript', 'missing-runScript', 'evalScript'] as const).map((kind) => ({
    origin,
    kind,
  })),
);

test.for(remoteCases)(
  'authenticated remote HTTP $origin batch → test rejects Maestro $kind before file access or execution',
  async ({ origin, kind }, t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const root = mkdtempForTestSync('agent-device-http-batch-maestro-trust-');
    const host = createTestHostEnvironment({ cwd: root, env: {} });
    const entry = path.join(root, 'flow.yaml');
    const scriptPath = path.join(root, kind === 'missing-runScript' ? 'missing.js' : 'host.js');
    const script = `output.result = ${JSON.stringify(SCRIPT_CANARY)}`;
    // runScript executes in a child process; its loopback request is the execution canary.
    const scriptRequests: string[] = [];
    const scriptCanaryServer = http.createServer((request, response) => {
      scriptRequests.push(request.url ?? '');
      response.end('ok');
    });
    const scriptCanaryPort = await listenOnLoopback(scriptCanaryServer);
    if (kind === 'host-runScript') {
      fs.writeFileSync(
        scriptPath,
        `http.post(${JSON.stringify(`http://127.0.0.1:${scriptCanaryPort}/ran`)})\n${script}`,
      );
    }
    const step =
      kind === 'evalScript'
        ? `evalScript: \${${script}}`
        : `runScript: ${JSON.stringify(scriptPath)}`;
    const flow = `appId: demo.app\n---\n- ${step}`;
    const source = { entry, files: { [entry]: flow } };
    fs.writeFileSync(entry, flow);
    const testRequest = {
      command: 'test',
      positionals: [entry],
      flags: {
        platform: 'ios',
        replayBackend: 'maestro',
        replayScriptSources: [source],
        artifactsDir: path.join(root, 'artifacts'),
      },
    };
    const batchRequest = {
      command: 'batch',
      positionals: [],
      flags: { batchSteps: [testRequest] },
    };
    const leaseRegistry = new LeaseRegistry();
    const lease =
      origin === 'auth-hook'
        ? leaseRegistry.allocateLease({ tenantId: 'maestro-trust', runId: 'maestro-trust-run' })
        : undefined;
    const handleRequest = createRequestHandler({
      host,
      createCommandSurface: fakeCreateCommandSurface,
      logPath: path.join(root, 'daemon.log'),
      token: TOKEN,
      sessionStore: new SessionStore(path.join(root, 'sessions'), host),
      leaseRegistry,
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      trackDownloadableArtifact: () => 'artifact-id',
    });
    const hookPath = path.join(root, 'auth-hook.mjs');
    if (origin === 'auth-hook') {
      fs.writeFileSync(hookPath, 'export default () => ({ tenantId: "maestro-trust" });');
    }
    const server = await createDaemonHttpServer({
      token: TOKEN,
      handleRequest,
      env: origin === 'auth-hook' ? { AGENT_DEVICE_HTTP_AUTH_HOOK: hookPath } : {},
      cwd: root,
    });
    const read = vi.spyOn(fs, 'readFileSync');
    const evaluate = vi.spyOn(vm, 'runInNewContext');
    try {
      const port = await listenOnLoopback(server);
      const post = async (request: Record<string, unknown>, status = 200) => {
        const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            ...(origin === 'network-marker'
              ? { [DAEMON_HTTP_NETWORK_ACCESS_HEADER]: DAEMON_HTTP_PUBLIC_NETWORK_ACCESS }
              : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'batch-maestro-trust',
            method: 'agent_device.command',
            params: {
              session: 'default',
              ...(lease ? { meta: { runId: lease.runId, leaseId: lease.leaseId } } : {}),
              ...request,
            },
          }),
        });
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(status);
        return body;
      };

      expect(
        await post(
          {
            command: 'replay',
            positionals: [entry],
            flags: { platform: 'ios', replayBackend: 'maestro', replayScriptSource: source },
          },
          500,
        ),
      ).toMatchObject({ error: { data: deniedReplay } });
      expect(await post(testRequest)).toMatchObject({ result: { ok: true, data: deniedSuite } });
      const batch = await post(batchRequest);
      expect(read.mock.calls.some(([file]) => file === scriptPath)).toBe(false);
      expect(scriptRequests).toEqual([]);
      expect(evaluate.mock.calls.some(([code]) => String(code).includes(SCRIPT_CANARY))).toBe(
        false,
      );
      expect(batch).toMatchObject({
        result: { ok: true, data: { results: [{ command: 'test', data: deniedSuite }] } },
      });
      if (kind === 'host-runScript') {
        expect(
          await post(
            {
              command: 'batch',
              flags: { batchSteps: [{ ...testRequest, internal: { publicNetworkOnly: false } }] },
            },
            400,
          ),
        ).toMatchObject({ error: { data: { code: 'INVALID_ARGS' } } });
      }

      if (kind !== 'missing-runScript') {
        const local = await handleRequest({ token: TOKEN, session: 'local', ...batchRequest });
        expect(local).toMatchObject({
          ok: true,
          data: { results: [{ data: { total: 1, passed: 1, failed: 0 } }] },
        });
        if (kind === 'host-runScript') {
          expect(scriptRequests).toEqual(['/ran']);
        } else {
          expect(
            evaluate.mock.calls.some(([code]) => String(code).includes(SCRIPT_CANARY)),
          ).toBe(true);
        }
      }
    } finally {
      read.mockRestore();
      evaluate.mockRestore();
      await closeLoopbackServer(server);
      await closeLoopbackServer(scriptCanaryServer);
    }
  },
);
