import { test, expect } from 'vitest';
import { finalizeDaemonResponse } from '../request-finalization.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import type { DaemonArtifactType } from '../../kernel/contracts.ts';

test('finalizeDaemonResponse preserves handler error hints from details', () => {
  const req: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'open',
    positionals: [],
    flags: {},
  };
  const response: DaemonResponse = {
    ok: false,
    error: {
      code: 'DEVICE_IN_USE',
      message: 'Device is already in use by session "default".',
      details: {
        session: 'default',
        hint: 'Run agent-device session list and reuse --session default.',
      },
    },
  };

  const finalized = finalizeDaemonResponse(req, response, () => 'artifact-id');

  expect(finalized.ok).toBe(false);
  if (!finalized.ok) {
    expect(finalized.error.hint).toBe('Run agent-device session list and reuse --session default.');
  }
});

test('finalizeDaemonResponse registers downloadable artifact type', () => {
  const req: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'record',
    positionals: ['stop'],
    meta: { tenantId: 'tenant-a' },
  };
  const response: DaemonResponse = {
    ok: true,
    data: {
      artifacts: [
        {
          field: 'telemetryPath',
          artifactType: 'screen-recording-telemetry',
          path: '/tmp/telemetry.json',
          localPath: '/client/telemetry.json',
          fileName: 'telemetry.json',
        },
        {
          field: 'rawPath',
          artifactType: undefined,
          path: '/tmp/raw.bin',
          localPath: '/client/raw.bin',
          fileName: 'raw.bin',
        },
      ],
    },
  };
  const tracked: Array<{
    artifactPath: string;
    tenantId?: string;
    artifactType?: DaemonArtifactType;
    fileName?: string;
  }> = [];

  const finalized = finalizeDaemonResponse(req, response, (opts) => {
    tracked.push(opts);
    return `artifact-id-${tracked.length}`;
  });

  expect(finalized).toEqual({
    ok: true,
    data: {
      artifacts: [
        {
          field: 'telemetryPath',
          artifactType: 'screen-recording-telemetry',
          artifactId: 'artifact-id-1',
          fileName: 'telemetry.json',
          localPath: '/client/telemetry.json',
        },
        {
          field: 'rawPath',
          artifactId: 'artifact-id-2',
          fileName: 'raw.bin',
          localPath: '/client/raw.bin',
        },
      ],
    },
  });
  // The untyped artifact must omit the key entirely (optional wire contract),
  // not carry an explicit undefined — toEqual alone cannot tell these apart.
  const finalizedArtifacts =
    finalized.ok === true
      ? (finalized.data?.artifacts as Array<Record<string, unknown>>)
      : undefined;
  expect(finalizedArtifacts?.[1]).not.toHaveProperty('artifactType');
  expect(tracked).toEqual([
    {
      artifactPath: '/tmp/telemetry.json',
      tenantId: 'tenant-a',
      artifactType: 'screen-recording-telemetry',
      fileName: 'telemetry.json',
    },
    {
      artifactPath: '/tmp/raw.bin',
      tenantId: 'tenant-a',
      artifactType: undefined,
      fileName: 'raw.bin',
    },
  ]);
});

test('finalizeDaemonResponse keeps screenshot path fallback as screenshot artifact type', () => {
  const req: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'screenshot',
    positionals: [],
    meta: {
      clientArtifactPaths: {
        path: '/client/screenshot.png',
      },
      tenantId: 'tenant-a',
    },
  };
  const response: DaemonResponse = {
    ok: true,
    data: {
      path: '/tmp/screenshot.png',
    },
  };
  const tracked: Array<{
    artifactPath: string;
    tenantId?: string;
    artifactType?: DaemonArtifactType;
    fileName?: string;
  }> = [];

  const finalized = finalizeDaemonResponse(req, response, (opts) => {
    tracked.push(opts);
    return 'artifact-id';
  });

  expect(finalized).toEqual({
    ok: true,
    data: {
      path: '/tmp/screenshot.png',
      artifacts: [
        {
          field: 'path',
          artifactType: 'screenshot',
          artifactId: 'artifact-id',
          fileName: 'screenshot.png',
          localPath: '/client/screenshot.png',
        },
      ],
    },
  });
  expect(tracked).toEqual([
    {
      artifactPath: '/tmp/screenshot.png',
      tenantId: 'tenant-a',
      artifactType: 'screenshot',
      fileName: 'screenshot.png',
    },
  ]);
});
