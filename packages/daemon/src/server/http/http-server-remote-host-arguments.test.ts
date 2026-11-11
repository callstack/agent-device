import { expect, test } from 'vitest';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import {
  DAEMON_HTTP_NETWORK_ACCESS_HEADER,
  DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
} from '@agent-device/contracts/daemon-http';
import { closeLoopbackServer, listenOnLoopback } from '@agent-device/test-kit';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { createDaemonHttpServer } from './http-server.ts';

type RpcBody = {
  result?: { ok: boolean; data?: { positionals?: string[] } };
  error?: { data?: { code?: string; details?: { reason?: string; field?: string } } };
};

async function withHttp(
  handleRequest: (request: DaemonRequest) => Promise<DaemonResponse>,
  run: (post: (params: Record<string, unknown>) => Promise<RpcBody>) => Promise<void>,
  remote = true,
): Promise<void> {
  const env = { ...process.env };
  delete env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  const server = await createDaemonHttpServer({
    token: 'test-token',
    handleRequest,
    env,
    cwd: process.cwd(),
  });
  try {
    const base = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    await run(async (params) => {
      const response = await fetch(`${base}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-token',
          ...(remote
            ? { [DAEMON_HTTP_NETWORK_ACCESS_HEADER]: DAEMON_HTTP_PUBLIC_NETWORK_ACCESS }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'host-argument',
          method: 'agent-device.command',
          params,
        }),
      });
      return (await response.json()) as RpcBody;
    });
  } finally {
    await closeLoopbackServer(server);
  }
}

const hostArgumentCases = [
  ...[
    'file:///tmp/agent-device-file-probe.txt',
    'FILE:///tmp/agent-device-file-probe.txt',
    'file:/tmp/agent-device-file-probe.txt',
    ' \tfile:///tmp/agent-device-file-probe.txt\n',
    'fi\tle:///tmp/agent-device-file-probe.txt',
    'file://localhost/tmp/agent-device-file-probe.txt',
    'file:///C:/Users/operator/probe.txt',
  ].map((url) => ({
    field: 'url',
    request: { command: 'open', positionals: [url], flags: { platform: 'web' } },
  })),
  { field: 'url', request: { command: 'open', positionals: ['file:///tmp/probe.txt'] } },
  {
    field: 'url',
    request: { command: 'open', positionals: ['browser', 'file:///tmp/probe.txt'] },
  },
  { field: 'app', request: { command: 'open', input: { app: 'file:///tmp/probe.txt' } } },
  {
    field: 'url',
    request: { command: 'open', input: { app: 'browser', url: 'file:///tmp/probe.txt' } },
  },
  {
    field: 'launchUrl',
    request: {
      command: 'open',
      positionals: ['browser'],
      flags: { launchUrl: 'file:///tmp/probe.txt' },
    },
  },
  {
    field: 'launchUrl',
    request: {
      command: 'open',
      positionals: ['browser'],
      runtime: { launchUrl: 'file:///tmp/probe.txt' },
    },
  },
  {
    field: 'launchUrl',
    request: { command: 'open', input: { app: 'browser', launchUrl: 'file:///tmp/probe.txt' } },
  },
  {
    field: 'launchUrl',
    request: {
      command: 'runtime',
      positionals: ['set'],
      flags: { launchUrl: 'file:///tmp/probe.txt' },
    },
  },
  { field: 'appPath', request: { command: 'install', positionals: ['/host/App.app'] } },
  {
    field: 'appPath',
    request: { command: 'reinstall', positionals: ['com.example', '/host/App.apk'] },
  },
  {
    field: 'installSource',
    request: {
      command: 'install_source',
      positionals: [],
      meta: { installSource: { kind: 'path', path: '/host/App.apk' } },
    },
  },
  { field: 'payload', request: { command: 'push', positionals: ['com.example', '/host/p.json'] } },
  { field: 'payload', request: { command: 'push', positionals: ['com.example', '{p}.json'] } },
  {
    field: 'template',
    request: {
      command: 'perf',
      positionals: ['cpu', 'profile', 'start', 'xctrace', '/host/t.tracetemplate'],
    },
  },
  {
    field: 'template',
    request: { command: 'perf', positionals: ['trace', 'start', 'xctrace', 'T.tracetemplate'] },
  },
  {
    field: 'template',
    request: {
      command: 'perf',
      positionals: ['cpu', 'profile', 'start', 'xctrace', 'package.json'],
    },
  },
];

test.each(
  hostArgumentCases.flatMap((entry) =>
    (['direct', 'batch'] as const).map((route) => ({ ...entry, route })),
  ),
)('remote admission refuses host argument $field via $route: $request.command', async (entry) => {
  let dispatched = false;
  await withHttp(
    async () => {
      dispatched = true;
      return { ok: true };
    },
    async (post) => {
      const { meta, ...step } = entry.request as typeof entry.request & { meta?: object };
      const body = await post(
        entry.route === 'batch'
          ? { command: 'batch', meta, flags: { batchSteps: [step] } }
          : entry.request,
      );
      expect(body.error?.data).toMatchObject({
        code: 'INVALID_ARGS',
        details: { reason: 'REMOTE_HOST_INPUT_DENIED', field: entry.field },
      });
      expect(dispatched).toBe(false);
    },
  );
});

test('local admission keeps file URLs available to the host operator', async () => {
  const positionals = ['file:///tmp/operator-owned.txt'];
  await withHttp(
    async (request) => ({ ok: true, data: { positionals: request.positionals } }),
    async (post) => {
      const body = await post({ command: 'open', positionals, flags: { platform: 'web' } });
      expect(body.result).toMatchObject({ ok: true, data: { positionals } });
    },
    false,
  );
});

test.each([
  { command: 'open', positionals: ['https://example.com/file:///tmp/probe.txt'] },
  { command: 'open', positionals: ['http://example.com'] },
  { command: 'open', positionals: ['about:blank'] },
  { command: 'open', positionals: ['com.example.app', 'example://open'] },
  { command: 'open', positionals: ['com.example.app'], runtime: { launchUrl: 'example://open' } },
  {
    command: 'install',
    positionals: ['/client/App.app'],
    meta: { uploadedArtifactId: 'upload-1' },
  },
  { command: 'push', positionals: ['com.example', '{"aps":{"alert":"hi"}}'] },
  { command: 'perf', positionals: ['cpu', 'profile', 'start', 'xctrace', 'Time Profiler'] },
])('remote admission keeps client-owned $command arguments', async (request) => {
  await withHttp(
    async (dispatched) => ({ ok: true, data: { positionals: dispatched.positionals } }),
    async (post) => {
      const body = await post(request);
      expect(body.result?.ok).toBe(true);
      expect(body.result?.data?.positionals).toEqual(request.positionals);
    },
  );
});
