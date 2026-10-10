import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendCommandContext } from '../../../backend.ts';
import type { ArtifactAdapter } from '../../../io.ts';
import { createAgentDevice } from '../../../runtime.ts';
import {
  createMemorySessionStore,
  restrictedCommandPolicy,
} from '../../../command-runtime/runtime-factory.ts';

const artifacts = {
  resolveInput: async () => ({ path: '/tmp/input' }),
  reserveOutput: async (_ref, options) => ({
    path: `/tmp/${options.field}${options.ext}`,
    visibility: options.visibility ?? 'client-visible',
    publish: async () => undefined,
  }),
  createTempFile: async (options) => ({
    path: `/tmp/${options.prefix}${options.ext}`,
    visibility: 'internal',
    cleanup: async () => {},
  }),
} satisfies ArtifactAdapter;

// fallow-ignore-next-line complexity
test('diagnostics runtime commands call typed backend primitives and redact sensitive data', async () => {
  const contexts: BackendCommandContext[] = [];
  const device = createAgentDevice({
    backend: createDiagnosticsBackend(contexts),
    artifacts,
    sessions: createMemorySessionStore([
      { name: 'default', appId: 'app-1', appBundleId: 'com.example.app' },
    ]),
    policy: restrictedCommandPolicy(),
  });

  const logs = await device.observability.logs({
    session: 'default',
    limit: 10,
    levels: ['info'],
    search: 'ready',
  });
  assert.equal(logs.kind, 'diagnosticsLogs');
  assert.equal(logs.redacted, true);
  assert.match(logs.entries[0]?.message ?? '', /token=\[REDACTED\]/);
  assert.equal(logs.entries[0]?.metadata?.authorization, '[REDACTED]');

  const network = await device.observability.network({
    session: 'default',
    include: 'all',
    limit: 5,
  });
  assert.equal(network.kind, 'diagnosticsNetwork');
  assert.equal(network.redacted, true);
  assert.match(network.entries[0]?.url ?? '', /token=%5BREDACTED%5D/);
  assert.equal(network.entries[0]?.requestHeaders?.Authorization, '[REDACTED]');
  assert.deepEqual(JSON.parse(network.entries[0]?.requestBody ?? '{}'), {
    token: '[REDACTED]',
    nested: {
      apiKey: '[REDACTED]',
      items: [{ password: '[REDACTED]' }],
    },
  });
  assert.deepEqual(JSON.parse(network.entries[0]?.responseBody ?? '{}'), {
    ok: true,
    session: {
      authorization: '[REDACTED]',
    },
    items: [{ secret: '[REDACTED]' }],
  });

  const perf = await device.observability.perf({ session: 'default', sampleMs: 100 });
  assert.equal(perf.kind, 'diagnosticsPerf');
  assert.equal(perf.redacted, false);
  assert.equal(perf.metrics[0]?.name, 'cpu');

  assert.deepEqual(
    contexts.map((context) => ({ appId: context.appId, appBundleId: context.appBundleId })),
    [
      { appId: 'app-1', appBundleId: 'com.example.app' },
      { appId: 'app-1', appBundleId: 'com.example.app' },
      { appId: 'app-1', appBundleId: 'com.example.app' },
    ],
  );
});

test('diagnostics commands validate bounded windows', async () => {
  const device = createAgentDevice({
    backend: createDiagnosticsBackend([]),
    artifacts,
    policy: restrictedCommandPolicy(),
  });

  const network = await device.observability.network({ limit: 1, include: 'summary' });
  assert.equal(network.kind, 'diagnosticsNetwork');
  assert.equal(network.entries[0]?.requestHeaders, undefined);

  await assert.rejects(
    () => device.observability.logs({ limit: 501 }),
    /logs limit must be an integer between 1 and 500/,
  );
});

function createDiagnosticsBackend(contexts: BackendCommandContext[]): AgentDeviceBackend {
  return {
    platform: 'ios',
    readLogs: async (context) => {
      contexts.push(context);
      return {
        backend: 'fixture',
        redacted: false,
        entries: [
          {
            timestamp: '2026-04-16T00:00:00.000Z',
            level: 'info',
            message: 'ready token=secret',
            metadata: { authorization: 'Bearer secret' },
          },
        ],
      };
    },
    dumpNetwork: async (context) => {
      contexts.push(context);
      return {
        backend: 'fixture',
        entries: [
          {
            method: 'POST',
            url: 'https://example.test/path?token=secret',
            status: 200,
            requestHeaders: { Authorization: 'Bearer secret' },
            responseHeaders: { 'content-type': 'application/json' },
            requestBody:
              '{"token":"secret","nested":{"apiKey":"top-secret","items":[{"password":"hidden"}]}}',
            responseBody:
              '{"ok":true,"session":{"authorization":"Bearer secret"},"items":[{"secret":"classified"}]}',
          },
        ],
      };
    },
    measurePerf: async (context) => {
      contexts.push(context);
      return {
        backend: 'fixture',
        metrics: [{ name: 'cpu', value: 12.5, unit: '%' }],
      };
    },
  };
}
