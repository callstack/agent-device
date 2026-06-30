import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../metro/client-metro-companion.ts', () => ({
  ensureMetroCompanion: vi.fn(),
}));

import { ensureMetroCompanion } from '../metro/client-metro-companion.ts';
import { prepareMetroRuntime } from '../metro/client-metro.ts';

const TEST_BRIDGE_SCOPE = {
  tenantId: 'tenant-1',
  runId: 'run-1',
  leaseId: 'lease-1',
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('prepareMetroRuntime starts the local companion only after bridge setup needs it', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-metro-companion-'));
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'metro-auto-companion-test',
      private: true,
      dependencies: {
        'react-native': '0.0.0-test',
      },
    }),
  );

  vi.mocked(ensureMetroCompanion).mockResolvedValue({
    pid: 123,
    spawned: true,
    statePath: path.join(projectRoot, '.agent-device', 'metro-companion.json'),
    logPath: path.join(projectRoot, '.agent-device', 'metro-companion.log'),
  });

  const fetchMock = vi.fn();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => 'packager-status:running',
  });
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({ ok: false, error: 'Metro companion is not connected' }),
  });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        ok: true,
        data: {
          enabled: true,
          base_url: 'https://proxy.example.test',
          status_url: 'https://proxy.example.test/status',
          bundle_url: 'https://runtime-1.metro.agent-device.dev/index.bundle?platform=ios',
          ios_runtime: {
            metro_host: 'runtime-1.metro.agent-device.dev',
            metro_port: 443,
            metro_bundle_url: 'https://runtime-1.metro.agent-device.dev/index.bundle?platform=ios',
          },
          android_runtime: {
            metro_host: 'proxy.example.test',
            metro_port: 443,
            metro_bundle_url:
              'https://proxy.example.test/api/metro/runtimes/runtime-1/index.bundle?platform=android',
          },
          upstream: {
            bundle_url:
              'https://public.example.test/index.bundle?platform=ios&dev=true&minify=false',
            host: '127.0.0.1',
            port: 8081,
            status_url: 'http://127.0.0.1:8081/status',
          },
          probe: {
            reachable: true,
            status_code: 200,
            latency_ms: 5,
            detail: 'ok',
          },
        },
      }),
  });
  vi.stubGlobal('fetch', fetchMock);

  try {
    const result = await prepareMetroRuntime({
      projectRoot,
      proxyBaseUrl: 'https://proxy.example.test',
      proxyBearerToken: 'shared-token',
      bridgeScope: TEST_BRIDGE_SCOPE,
      metroPort: 8081,
      reuseExisting: true,
      installDependenciesIfNeeded: false,
    });

    assert.equal(result.started, false);
    assert.equal(result.reused, true);
    assert.equal(result.bridge?.enabled, true);
    assert.equal(
      result.iosRuntime.bundleUrl,
      'https://runtime-1.metro.agent-device.dev/index.bundle?platform=ios',
    );
    assert.equal(result.iosRuntime.metroHost, 'runtime-1.metro.agent-device.dev');
    assert.equal(result.iosRuntime.metroPort, 443);
    assert.equal(
      result.androidRuntime.bundleUrl,
      'https://proxy.example.test/api/metro/runtimes/runtime-1/index.bundle?platform=android',
    );
    assert.equal(vi.mocked(ensureMetroCompanion).mock.calls.length, 1);
    assert.deepEqual(vi.mocked(ensureMetroCompanion).mock.calls[0]?.[0], {
      projectRoot,
      serverBaseUrl: 'https://proxy.example.test',
      bearerToken: 'shared-token',
      bridgeScope: TEST_BRIDGE_SCOPE,
      localBaseUrl: 'http://127.0.0.1:8081',
      launchUrl: undefined,
      profileKey: undefined,
      consumerKey: undefined,
      env: process.env,
    });
    assert.equal(fetchMock.mock.calls.length, 3);
    assert.equal(fetchMock.mock.calls[1]?.[0], 'https://proxy.example.test/api/metro/bridge');
    assert.equal(fetchMock.mock.calls[2]?.[0], 'https://proxy.example.test/api/metro/bridge');
    assert.deepEqual(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)), {
      tenantId: 'tenant-1',
      runId: 'run-1',
      leaseId: 'lease-1',
      timeout_ms: 10000,
    });
    assert.deepEqual(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)), {
      tenantId: 'tenant-1',
      runId: 'run-1',
      leaseId: 'lease-1',
      timeout_ms: 10000,
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareMetroRuntime rejects bridged descriptors without iOS bundle URLs', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-metro-descriptor-'));
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'metro-descriptor-test',
      private: true,
      dependencies: {
        'react-native': '0.0.0-test',
      },
    }),
  );

  const fetchMock = vi.fn();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => 'packager-status:running',
  });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        ok: true,
        data: {
          enabled: true,
          base_url: 'https://proxy.example.test',
          status_url: 'https://proxy.example.test/status',
          bundle_url: 'https://proxy.example.test/index.bundle?platform=ios',
          ios_runtime: {},
          android_runtime: {
            metro_bundle_url:
              'https://proxy.example.test/api/metro/runtimes/runtime-1/index.bundle?platform=android',
          },
          upstream: {
            bundle_url:
              'https://public.example.test/index.bundle?platform=ios&dev=true&minify=false',
          },
          probe: {
            reachable: true,
            status_code: 200,
            latency_ms: 5,
            detail: 'ok',
          },
        },
      }),
  });
  vi.stubGlobal('fetch', fetchMock);

  try {
    await assert.rejects(
      () =>
        prepareMetroRuntime({
          projectRoot,
          proxyBaseUrl: 'https://proxy.example.test',
          proxyBearerToken: 'shared-token',
          bridgeScope: TEST_BRIDGE_SCOPE,
          metroPort: 8081,
          reuseExisting: true,
          installDependenciesIfNeeded: false,
        }),
      /bridge descriptor is missing ios_runtime\.metro_bundle_url/,
    );
    assert.equal(vi.mocked(ensureMetroCompanion).mock.calls.length, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareMetroRuntime preserves the initial bridge error if companion startup fails', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-metro-companion-error-'));
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'metro-auto-companion-error-test',
      private: true,
      dependencies: {
        'react-native': '0.0.0-test',
      },
    }),
  );

  vi.mocked(ensureMetroCompanion).mockRejectedValue(new Error('companion startup failed'));

  const fetchMock = vi.fn();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => 'packager-status:running',
  });
  fetchMock.mockRejectedValueOnce(new Error('initial bridge auth failed'));
  vi.stubGlobal('fetch', fetchMock);

  try {
    await assert.rejects(
      () =>
        prepareMetroRuntime({
          projectRoot,
          publicBaseUrl: 'https://public.example.test',
          proxyBaseUrl: 'https://proxy.example.test',
          proxyBearerToken: 'shared-token',
          bridgeScope: TEST_BRIDGE_SCOPE,
          metroPort: 8081,
          reuseExisting: true,
          installDependenciesIfNeeded: false,
          probeTimeoutMs: 10,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /bridgeError=companion startup failed/);
        assert.match(error.message, /initialBridgeError=initial bridge auth failed/);
        assert.doesNotMatch(error.message, /metroCompanionLog=/);
        return true;
      },
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareMetroRuntime fails fast when initial bridge failure is non-retryable', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-metro-companion-401-'));
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'metro-initial-bridge-non-retryable-test',
      private: true,
      dependencies: {
        'react-native': '0.0.0-test',
      },
    }),
  );

  const fetchMock = vi.fn();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => 'packager-status:running',
  });
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ ok: false, error: 'invalid scope' }),
  });
  vi.stubGlobal('fetch', fetchMock);

  try {
    await assert.rejects(
      () =>
        prepareMetroRuntime({
          projectRoot,
          publicBaseUrl: 'https://public.example.test',
          proxyBaseUrl: 'https://proxy.example.test',
          proxyBearerToken: 'shared-token',
          bridgeScope: TEST_BRIDGE_SCOPE,
          metroPort: 8081,
          reuseExisting: true,
          installDependenciesIfNeeded: false,
          probeTimeoutMs: 10,
        }),
      /\/api\/metro\/bridge failed \(401\)/,
    );
    assert.equal(vi.mocked(ensureMetroCompanion).mock.calls.length, 0);
    assert.equal(fetchMock.mock.calls.length, 2);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareMetroRuntime fails fast on non-retryable bridge errors after companion startup', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-metro-companion-401-'));
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'metro-auto-companion-non-retryable-test',
      private: true,
      dependencies: {
        'react-native': '0.0.0-test',
      },
    }),
  );

  vi.mocked(ensureMetroCompanion).mockResolvedValue({
    pid: 123,
    spawned: true,
    statePath: path.join(projectRoot, '.agent-device', 'metro-companion.json'),
    logPath: path.join(projectRoot, '.agent-device', 'metro-companion.log'),
  });

  const fetchMock = vi.fn();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => 'packager-status:running',
  });
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({ ok: false, error: 'Metro companion is not connected' }),
  });
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ ok: false, error: 'invalid token' }),
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();

  try {
    let settled: unknown = 'pending';
    const preparePromise = prepareMetroRuntime({
      projectRoot,
      publicBaseUrl: 'https://public.example.test',
      proxyBaseUrl: 'https://proxy.example.test',
      proxyBearerToken: 'shared-token',
      bridgeScope: TEST_BRIDGE_SCOPE,
      metroPort: 8081,
      reuseExisting: true,
      installDependenciesIfNeeded: false,
      probeTimeoutMs: 10,
    });
    void preparePromise.then(
      () => {
        settled = 'resolved';
      },
      (error) => {
        settled = error;
      },
    );

    await vi.advanceTimersByTimeAsync(1);

    assert.notEqual(settled, 'pending');
    assert(settled instanceof Error);
    assert.match(settled.message, /bridgeError=\/api\/metro\/bridge failed \(401\)/);
    assert.match(settled.message, /initialBridgeError=\/api\/metro\/bridge failed \(409\)/);
    assert.match(settled.message, /metroCompanionLog=.*metro-companion\.log/);
    assert.equal(fetchMock.mock.calls.length, 3);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareMetroRuntime retries malformed retryable bridge responses after companion startup', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-metro-companion-html-'));
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'metro-auto-companion-html-test',
      private: true,
      dependencies: {
        'react-native': '0.0.0-test',
      },
    }),
  );

  vi.mocked(ensureMetroCompanion).mockResolvedValue({
    pid: 123,
    spawned: true,
    statePath: path.join(projectRoot, '.agent-device', 'metro-companion.json'),
    logPath: path.join(projectRoot, '.agent-device', 'metro-companion.log'),
  });

  const fetchMock = vi.fn();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => 'packager-status:running',
  });
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({ ok: false, error: 'Metro companion is not connected' }),
  });
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 503,
    text: async () => '<html>upstream unavailable</html>',
  });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        ok: true,
        data: {
          enabled: true,
          base_url: 'https://proxy.example.test',
          status_url: 'https://proxy.example.test/status',
          bundle_url: 'https://runtime-1.metro.agent-device.dev/index.bundle?platform=ios',
          ios_runtime: {
            metro_host: 'runtime-1.metro.agent-device.dev',
            metro_port: 443,
            metro_bundle_url: 'https://runtime-1.metro.agent-device.dev/index.bundle?platform=ios',
          },
          android_runtime: {
            metro_host: 'proxy.example.test',
            metro_port: 443,
            metro_bundle_url:
              'https://proxy.example.test/api/metro/runtimes/runtime-1/index.bundle?platform=android',
          },
          upstream: {
            bundle_url:
              'https://public.example.test/index.bundle?platform=ios&dev=true&minify=false',
          },
          probe: {
            reachable: true,
            status_code: 200,
            latency_ms: 5,
            detail: 'ok',
          },
        },
      }),
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();

  try {
    const preparePromise = prepareMetroRuntime({
      projectRoot,
      publicBaseUrl: 'https://public.example.test',
      proxyBaseUrl: 'https://proxy.example.test',
      proxyBearerToken: 'shared-token',
      bridgeScope: TEST_BRIDGE_SCOPE,
      metroPort: 8081,
      reuseExisting: true,
      installDependenciesIfNeeded: false,
      probeTimeoutMs: 10,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await preparePromise;

    assert.equal(result.bridge?.enabled, true);
    assert.equal(
      result.iosRuntime.bundleUrl,
      'https://runtime-1.metro.agent-device.dev/index.bundle?platform=ios',
    );
    assert.equal(result.iosRuntime.metroHost, 'runtime-1.metro.agent-device.dev');
    assert.equal(result.iosRuntime.metroPort, 443);
    assert.equal(fetchMock.mock.calls.length, 4);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
