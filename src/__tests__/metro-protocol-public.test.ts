import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildBundleUrl,
  normalizeBaseUrl,
  type MetroBridgeDescriptor,
  type MetroTunnelRequestMessage,
  type MetroTunnelResponseMessage,
} from '../metro.ts';

// Type-only contract fixtures — these verify that the public subpath types
// remain structurally stable. A rename or breaking shape change will fail
// the compile, not a runtime assertion.
({
  enabled: true,
  base_url: 'https://bridge.example.test',
  ios_runtime: {
    metro_host: 'runtime-1.metro.agent-device.dev',
    metro_port: 443,
    metro_bundle_url: 'https://runtime-1.metro.agent-device.dev/index.bundle?platform=ios',
  },
  android_runtime: {
    metro_host: 'bridge.example.test',
    metro_port: 443,
    metro_bundle_url:
      'https://bridge.example.test/api/metro/runtimes/runtime-1/index.bundle?platform=android',
  },
  upstream: { bundle_url: 'http://127.0.0.1:8081/index.bundle?platform=ios' },
  probe: { reachable: true, status_code: 200, latency_ms: 4, detail: 'ok' },
}) satisfies MetroBridgeDescriptor;

({
  type: 'ws-frame',
  streamId: 'stream-1',
  dataBase64: 'aGVsbG8=',
  binary: false,
}) satisfies MetroTunnelRequestMessage;

({
  type: 'http-response',
  requestId: 'req-1',
  status: 200,
  headers: { 'content-type': 'application/json' },
}) satisfies MetroTunnelResponseMessage;

test('public metro exports expose stable url helpers', () => {
  assert.equal(normalizeBaseUrl('https://bridge.example.test///'), 'https://bridge.example.test');
  assert.equal(
    buildBundleUrl('https://bridge.example.test/', 'ios'),
    'https://bridge.example.test/index.bundle?platform=ios&dev=true&minify=false',
  );
});
