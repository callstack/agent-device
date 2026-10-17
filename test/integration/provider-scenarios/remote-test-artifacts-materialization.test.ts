import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import {
  downloadRemoteArtifact,
  materializeRemoteArtifacts,
} from '@agent-device/remote/daemon-artifacts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import {
  createProviderScenarioHarness,
  withProviderScenarioResource,
  withProviderScenarioTempDir,
} from './harness.ts';
import { createProviderScenarioProxy } from './harness-proxy.ts';

const PROXY_TOKEN = 'remote-test-artifacts-proxy-token';

test('the composed daemon and client path materializes the directory produced by a test command', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'remote test-artifacts materialization coverage'))
    return;

  await withProviderScenarioResource(
    async () => await createProviderScenarioHarness({ deviceInventoryProvider: async () => [] }),
    async (daemon) => {
      await withProviderScenarioTempDir('agent-device-remote-suite-response-', async (tempDir) => {
        const sourceDir = path.join(tempDir, 'source');
        const daemonArtifactsRoot = path.join(tempDir, 'daemon-side');
        const clientRoot = path.join(tempDir, 'caller-side', 'artifacts');
        const scriptPath = path.join(sourceDir, 'flow.ad');
        const source = '';
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(scriptPath, source);

        const proxy = await createProviderScenarioProxy(daemon, { clientToken: PROXY_TOKEN });
        const request: DaemonWireRequest = {
          token: PROXY_TOKEN,
          session: 'default',
          command: 'test',
          positionals: [scriptPath],
          flags: { artifactsDir: daemonArtifactsRoot },
          meta: {
            cwd: sourceDir,
            requestId: 'remote-test-artifact-materialization',
            clientArtifactPaths: { artifactsDir: clientRoot },
          },
        };

        try {
          const rpc = await proxy.callCommand(
            PROXY_TOKEN,
            request.command,
            request.positionals,
            request.flags,
            { meta: request.meta, session: request.session },
          );
          assert.equal(rpc.statusCode, 200, JSON.stringify(rpc.json));
          const data = rpc.json.result?.data as
            | {
                total?: number;
                passed?: number;
                failed?: number;
                artifactsDir?: string;
                artifacts?: Array<{
                  artifactId?: string;
                  artifactType?: string;
                }>;
              }
            | undefined;
          assert.equal(data?.total, 1, JSON.stringify(rpc.json));
          assert.equal(data?.passed, 1, JSON.stringify(rpc.json));
          assert.equal(data?.failed, 0, JSON.stringify(rpc.json));
          const artifact = data?.artifacts?.[0];
          assert.ok(artifact, 'the test command did not register its directory artifact');
          assert.equal(artifact?.artifactType, 'test-artifacts');
          assert.equal(typeof artifact?.artifactId, 'string');
          const artifactId = artifact?.artifactId as string;

          assert.equal(proxy.forwarded.length, 1);
          const forwardedCommand = proxy.forwarded[0];
          assert.ok(forwardedCommand);
          assert.equal(forwardedCommand.method, 'POST');
          assert.equal(forwardedCommand.route, '/rpc');
          assert.equal(forwardedCommand.authorization, `Bearer ${daemon.token}`);
          assert.equal(forwardedCommand.statusCode, 200);
          const forwardedRpc = JSON.parse(forwardedCommand.requestBody) as {
            method?: string;
            params?: { command?: string };
          };
          assert.equal(forwardedRpc.method, 'agent_device.command');
          assert.equal(forwardedRpc.params?.command, 'test');

          const response: Extract<DaemonResponse, { ok: true }> = {
            ok: true,
            data: data as NonNullable<Extract<DaemonResponse, { ok: true }>['data']>,
          };
          const materialized = await materializeRemoteArtifacts(
            { baseUrl: proxy.baseUrl, token: PROXY_TOKEN },
            request,
            response,
          );
          assert.equal(materialized.ok, true);
          if (!materialized.ok) return;

          const materializedSuiteDir = materialized.data?.artifactsDir;
          if (typeof materializedSuiteDir !== 'string') {
            throw new Error('the artifact route did not materialize a suite directory');
          }
          assert.equal(path.dirname(materializedSuiteDir), clientRoot);
          assert.ok(fs.existsSync(materializedSuiteDir));
          const attemptDir = path.join(materializedSuiteDir, 'flow.ad', 'attempt-1');
          assert.equal(fs.readFileSync(path.join(attemptDir, 'replay.ad'), 'utf8'), source);
          const result = fs.readFileSync(path.join(attemptDir, 'result.txt'), 'utf8');
          assert.match(result, /status: passed/);

          assert.deepEqual(
            proxy.forwarded.map((entry) => [
              entry.method,
              entry.route,
              entry.authorization,
              entry.tenantId,
              entry.statusCode,
            ]),
            [
              ['POST', '/rpc', `Bearer ${daemon.token}`, undefined, 200],
              ['GET', `/artifacts/${artifactId}`, `Bearer ${daemon.token}`, undefined, 200],
            ],
            'the real daemon must produce and serve the artifact through the shared proxy',
          );
        } finally {
          await proxy.close();
        }
      });
    },
  );
});

test('directory downloads stage beside the destination and finish timeout cleanup before rejecting', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'remote test-artifacts atomic staging coverage')) return;

  const tempDir = mkdtempForTestSync('agent-device-remote-suite-timeout-');
  const clientRoot = path.join(tempDir, 'caller-side', 'artifacts');
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.write('partial archive');
  });

  try {
    const port = await listenOnLoopback(server);
    const download = downloadRemoteArtifact({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'daemon-token',
      artifactId: 'stalled-directory',
      destinationPath: clientRoot,
      requestScope: {},
      isDirectory: true,
      timeoutMs: 80,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stagingWhileActive = fs.existsSync(clientRoot)
      ? fs.readdirSync(clientRoot).filter((entry) => entry.startsWith('.agent-device-download-'))
      : [];
    await assert.rejects(download, /timed out/);
    assert.equal(stagingWhileActive.length, 1);
    assert.deepEqual(
      fs.existsSync(clientRoot)
        ? fs.readdirSync(clientRoot).filter((entry) => entry.startsWith('.agent-device-download-'))
        : [],
      [],
    );
  } finally {
    await closeLoopbackServer(server);
  }
});
