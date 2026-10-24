import { describe, expect, test, vi } from 'vitest';
import type { NetworkDumpResult } from '@agent-device/contracts/network-runtime';
import type { LimrunNetworkCapture } from './network-capture.ts';
import { bindLimrunNetworkOperations } from './network-runtime.ts';

const appLogResult: NetworkDumpResult = Object.freeze({
  source: 'app-log' as const,
  backend: 'ios-simulator' as const,
  dump: Object.freeze({
    path: '/tmp/app.log',
    exists: true,
    scannedLines: 10,
    matchedLines: 1,
    entries: [],
    include: 'summary' as const,
    limits: { maxEntries: 25, maxPayloadChars: 2048, maxScanLines: 4000 },
  }),
  notes: [],
});

function fakeCapture(running: boolean): LimrunNetworkCapture & { start: ReturnType<typeof vi.fn> } {
  return {
    source: 'limrun-tunnel',
    running,
    start: vi.fn(async () => ({
      ok: true as const,
      hosts: ['api.example.com'],
      capturingBodies: true as const,
    })),
    stop: async () => ({ stopped: running }),
    readEntries: () => [
      {
        method: 'GET',
        url: 'https://api.example.com/v1/orders',
        status: 200,
        durationMs: 12,
        raw: 'GET https://api.example.com/v1/orders 200',
        line: 1,
      },
    ],
    notes: () => ['Likely certificate-pinned hosts: pinned.example.com.'],
  };
}

function dumpInput() {
  return {
    sessionId: 's',
    maxEntries: 25,
    include: 'summary' as const,
    maxPayloadChars: 2048,
    maxScanLines: 4000,
  };
}

describe('Limrun network operations', () => {
  test('a dump with no capture started reads the session app log', async () => {
    const appLogDump = vi.fn(async () => appLogResult);
    const operations = bindLimrunNetworkOperations({
      capture: fakeCapture(false),
      appLogDump,
    });

    const result = await operations.networkDump(dumpInput());

    expect(result).toBe(appLogResult);
    expect(appLogDump).toHaveBeenCalledTimes(1);
  });

  test('a dump with a running capture answers from the capture buffer with its source', async () => {
    const appLogDump = vi.fn(async () => appLogResult);
    const operations = bindLimrunNetworkOperations({ capture: fakeCapture(true), appLogDump });

    const result = await operations.networkDump(dumpInput());

    expect(result.source).toBe('provider');
    if (result.source !== 'provider') return;
    expect(result.backend).toBe('limrun-tunnel');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ url: 'https://api.example.com/v1/orders' });
    expect(result.notes?.join(' ')).toContain('pinned.example.com');
    expect(appLogDump).not.toHaveBeenCalled();
  });

  test('start reports the source, its hosts, and relaunch demand from the open app', async () => {
    const operations = bindLimrunNetworkOperations({
      capture: fakeCapture(false),
      appLogDump: async () => appLogResult,
    });

    const started = await operations.networkCaptureStart({
      sessionId: 's',
      appBundleId: 'com.example.app',
      hosts: ['api.example.com'],
    });

    expect(started).toEqual({
      started: true,
      source: 'limrun-tunnel',
      hosts: ['api.example.com'],
      requiresRelaunch: true,
      capturingBodies: true,
    });
  });

  test('start without an open app reports no relaunch demand', async () => {
    const operations = bindLimrunNetworkOperations({
      capture: fakeCapture(false),
      appLogDump: async () => appLogResult,
    });

    const started = await operations.networkCaptureStart({ sessionId: 's' });

    expect(started).toMatchObject({ started: true, requiresRelaunch: false });
  });

  test('a refused start carries its typed reason', async () => {
    const capture = fakeCapture(false);
    capture.start.mockResolvedValueOnce({
      ok: false,
      reason: 'tunnel-in-use',
      message: 'Limrun tunnel inspection could not start: already_active',
    });
    const operations = bindLimrunNetworkOperations({
      capture,
      appLogDump: async () => appLogResult,
    });

    const started = await operations.networkCaptureStart({ sessionId: 's' });

    expect(started).toMatchObject({ started: false, reason: 'tunnel-in-use' });
  });
});
