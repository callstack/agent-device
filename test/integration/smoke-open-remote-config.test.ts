import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../src/__tests__/test-utils/loopback.ts';
import { runCli } from '../../src/cli.ts';

// Smoke coverage for the repo-local remote host flow: connect to a remote profile,
// prepare Metro through the host bridge, and reuse connection runtime hints on open.

class ExitSignal extends Error {
  public readonly code: number;

  constructor(code: number) {
    super(`EXIT_${code}`);
    this.code = code;
  }
}

type CliJsonResult = {
  code: number | null;
  json?: any;
  stdout: string;
  stderr: string;
};

async function runCliJson(args: string[], env?: NodeJS.ProcessEnv): Promise<CliJsonResult> {
  let code: number | null = null;
  let stdout = '';
  let stderr = '';

  const originalEnv = process.env;
  const originalExit = process.exit;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.env = {
    ...process.env,
    ...env,
  };
  (process as any).exit = ((nextCode?: number) => {
    throw new ExitSignal(nextCode ?? 0);
  }) as typeof process.exit;
  (process.stdout as any).write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  (process.stderr as any).write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    await runCli(args);
  } catch (error) {
    if (error instanceof ExitSignal) {
      code = error.code;
    } else {
      throw error;
    }
  } finally {
    process.env = originalEnv;
    process.exit = originalExit;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const json = parseCliJson(stdout);
  return {
    code,
    json,
    stdout,
    stderr,
  };
}

function parseCliJson(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    const embedded = stdout.match(/\{\s*"success"[\s\S]*\}\s*$/);
    if (!embedded) return undefined;
    try {
      return JSON.parse(embedded[0]);
    } catch {
      return undefined;
    }
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

test('connect prepares Metro and open reuses bridged runtime for remote daemon', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'remote open smoke coverage')) {
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-remote-open-smoke-'));
  const projectRoot = path.join(root, 'project');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'remote-open-smoke',
      version: '1.0.0',
      dependencies: {
        'react-native': '0.79.0',
      },
    }),
    'utf8',
  );

  const metroServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        connection: 'close',
      });
      res.end('packager-status:running');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const metroPort = await listenOnLoopback(metroServer);
  t.after(async () => {
    await closeLoopbackServer(metroServer);
  });

  let capturedBridgeRequest: any;
  let capturedOpenRpcRequest: any;
  const sharedToken = 'test-token';
  let hostPort = 0;
  const hostServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/agent-device/health') {
      res.writeHead(200, {
        'content-type': 'application/json',
        connection: 'close',
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/metro/bridge') {
      capturedBridgeRequest = {
        authorization: req.headers.authorization,
        token: req.headers['x-agent-device-token'],
        body: await readJsonBody(req),
      };
      res.writeHead(200, {
        'content-type': 'application/json',
        connection: 'close',
      });
      res.end(
        JSON.stringify({
          data: {
            enabled: true,
            base_url: `http://127.0.0.1:${hostPort}`,
            status_url: `http://127.0.0.1:${metroPort}/status`,
            bundle_url: 'https://qa-android.metro.agent-device.dev/index.bundle?platform=ios',
            ios_runtime: {
              metro_host: 'qa-android.metro.agent-device.dev',
              metro_port: 443,
              metro_bundle_url:
                'https://qa-android.metro.agent-device.dev/index.bundle?platform=ios',
              launch_url: 'myapp://ios-dev',
            },
            android_runtime: {
              metro_host: 'bridge.example.test',
              metro_port: 443,
              metro_bundle_url:
                'https://bridge.example.test/api/metro/runtimes/qa-android/index.bundle?platform=android',
              launch_url: 'myapp://android-dev',
            },
            upstream: {
              bundle_url:
                'https://public.example.test/index.bundle?platform=ios&dev=true&minify=false',
              host: '127.0.0.1',
              port: metroPort,
              status_url: `http://127.0.0.1:${metroPort}/status`,
            },
            probe: {
              reachable: true,
              status_code: 200,
              latency_ms: 1,
              detail: 'ok',
            },
          },
        }),
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/agent-device/rpc') {
      const rpcRequest = {
        authorization: req.headers.authorization,
        token: req.headers['x-agent-device-token'],
        body: await readJsonBody(req),
      };
      if (rpcRequest.body?.method === 'agent_device.lease.allocate') {
        res.writeHead(200, {
          'content-type': 'application/json',
          connection: 'close',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpcRequest.body?.id ?? 'remote-connect-smoke',
            result: {
              ok: true,
              data: {
                lease: {
                  leaseId: 'abc123abc123abc1',
                  tenantId: rpcRequest.body?.params?.tenantId,
                  runId: rpcRequest.body?.params?.runId,
                  backend: rpcRequest.body?.params?.backend,
                  createdAt: Date.now(),
                  heartbeatAt: Date.now(),
                  expiresAt: Date.now() + 60_000,
                },
              },
            },
          }),
        );
        return;
      }
      capturedOpenRpcRequest = rpcRequest;
      const runtime = capturedOpenRpcRequest.body?.params?.runtime;
      res.writeHead(200, {
        'content-type': 'application/json',
        connection: 'close',
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: capturedOpenRpcRequest.body?.id ?? 'remote-open-smoke',
          result: {
            ok: true,
            data: {
              session: 'qa-android',
              appName: 'Demo',
              appBundleId: 'com.example.demo',
              platform: 'android',
              target: 'mobile',
              device: 'Pixel',
              id: 'emulator-5554',
              serial: 'emulator-5554',
              runtime,
            },
          },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });
  hostPort = await listenOnLoopback(hostServer);
  t.after(async () => {
    await closeLoopbackServer(hostServer);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const remoteConfigPath = path.join(configDir, 'agent-device.remote.json');
  const stateDir = path.join(root, 'state');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      session: 'qa-android',
      platform: 'android',
      daemonBaseUrl: `http://127.0.0.1:${hostPort}/agent-device`,
      metroProjectRoot: '../project',
      metroProxyBaseUrl: `http://127.0.0.1:${hostPort}`,
      metroPreparePort: metroPort,
    }),
    'utf8',
  );

  const connectResult = await runCliJson(
    [
      'connect',
      '--remote-config',
      remoteConfigPath,
      '--tenant',
      'acme',
      '--run-id',
      'run-123',
      '--state-dir',
      stateDir,
      '--json',
    ],
    {
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: sharedToken,
    },
  );

  assert.equal(connectResult.code, null, `${connectResult.stderr}\n${connectResult.stdout}`);
  assert.equal(connectResult.json?.success, true, JSON.stringify(connectResult.json) ?? '');

  const result = await runCliJson(['open', 'Demo', '--state-dir', stateDir, '--json'], {
    AGENT_DEVICE_DAEMON_AUTH_TOKEN: sharedToken,
  });

  assert.equal(result.code, null, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.json?.success, true, JSON.stringify(result.json) ?? result.stdout);

  assert.equal(capturedBridgeRequest?.authorization, `Bearer ${sharedToken}`);
  assert.equal(capturedOpenRpcRequest?.authorization, `Bearer ${sharedToken}`);
  assert.equal(capturedOpenRpcRequest?.body?.method, 'agent_device.command');
  assert.equal(capturedOpenRpcRequest?.body?.params?.session, 'qa-android');
  assert.equal(capturedOpenRpcRequest?.body?.params?.command, 'open');
  assert.deepEqual(capturedOpenRpcRequest?.body?.params?.positionals, ['Demo']);
  assert.equal(capturedOpenRpcRequest?.body?.params?.meta?.leaseId, 'abc123abc123abc1');
  assert.deepEqual(capturedOpenRpcRequest?.body?.params?.runtime, {
    platform: 'android',
    metroHost: 'bridge.example.test',
    metroPort: 443,
    bundleUrl:
      'https://bridge.example.test/api/metro/runtimes/qa-android/index.bundle?platform=android',
    launchUrl: 'myapp://android-dev',
  });
  assert.equal(capturedBridgeRequest?.body?.ios_runtime, undefined);
  assert.equal(capturedBridgeRequest?.body?.tenantId, 'acme');
  assert.equal(capturedBridgeRequest?.body?.runId, 'run-123');
  assert.equal(capturedBridgeRequest?.body?.leaseId, 'abc123abc123abc1');
  assert.deepEqual(result.json?.data?.runtime, {
    platform: 'android',
    metroHost: 'bridge.example.test',
    metroPort: 443,
    bundleUrl:
      'https://bridge.example.test/api/metro/runtimes/qa-android/index.bundle?platform=android',
    launchUrl: 'myapp://android-dev',
  });
});
