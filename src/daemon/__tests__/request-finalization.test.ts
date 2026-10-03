import { test, expect } from 'vitest';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { finalizeDaemonResponse } from '../request-finalization.ts';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';
import type { DaemonArtifactType } from '@agent-device/kernel/contracts';
import type { DownloadableArtifactRegistration } from '../artifact-tracking.ts';

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

test('finalizeDaemonResponse keeps a network error code without the cause message', () => {
  const req: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'install-from-source',
    positionals: ['https://example.com/app.apk'],
    flags: {},
  };
  const response: DaemonResponse = {
    ok: false,
    error: normalizeError(
      new AppError(
        'COMMAND_FAILED',
        'The daemon failed to fetch the app source (network error code: ECONNREFUSED)',
        { networkErrorCode: 'ECONNREFUSED' },
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }),
      ),
    ),
  };

  const finalized = finalizeDaemonResponse(req, response, () => 'artifact-id');

  expect(finalized.ok).toBe(false);
  if (!finalized.ok) {
    expect(finalized.error.message).toBe(
      'The daemon failed to fetch the app source (network error code: ECONNREFUSED)',
    );
    expect(finalized.error.details).toMatchObject({ networkErrorCode: 'ECONNREFUSED' });
    expect(JSON.stringify(finalized.error)).not.toContain('10.0.0.1');
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

test('finalizeDaemonResponse registers an unexpected output artifact without a client path', () => {
  const req: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    meta: { tenantId: 'tenant-a' },
  };
  const response: DaemonResponse = {
    ok: true,
    data: {
      fallbackScreenshotPath: '/tmp/snapshot-fallback.png',
      artifacts: [
        {
          field: 'fallbackScreenshotPath',
          artifactType: 'screenshot',
          path: '/tmp/snapshot-fallback.png',
          fileName: 'snapshot-fallback.png',
        },
      ],
    },
  };

  const finalized = finalizeDaemonResponse(req, response, () => 'artifact-id');

  expect(finalized).toEqual({
    ok: true,
    data: {
      fallbackScreenshotPath: '/tmp/snapshot-fallback.png',
      artifacts: [
        {
          field: 'fallbackScreenshotPath',
          artifactType: 'screenshot',
          artifactId: 'artifact-id',
          fileName: 'snapshot-fallback.png',
          localPath: undefined,
        },
      ],
    },
  });
});

test('finalizeDaemonResponse leaves unrelated local-path artifacts unregistered', () => {
  const req: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'record',
    positionals: ['stop'],
  };
  const response: DaemonResponse = {
    ok: true,
    data: {
      artifacts: [
        {
          field: 'recordingPath',
          artifactType: 'screen-recording',
          path: '/tmp/recording.mp4',
          fileName: 'recording.mp4',
        },
      ],
    },
  };

  const finalized = finalizeDaemonResponse(req, response, () => {
    throw new Error('local-only artifact must not be registered');
  });

  expect(finalized).toEqual(response);
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

test('finalizeDaemonResponse registers the screenshot display rotation with its artifact', () => {
  const req: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'screenshot',
    positionals: [],
    meta: { tenantId: 'tenant-a', clientArtifactPaths: { path: '/client/shot.png' } },
  };
  const tracked: DownloadableArtifactRegistration[] = [];

  finalizeDaemonResponse(
    req,
    { ok: true, data: { path: '/tmp/shot.png', displayRotation: 'landscape-left' } },
    (registration) => {
      tracked.push(registration);
      return 'artifact-id';
    },
  );

  expect(tracked).toEqual([
    {
      artifactPath: '/tmp/shot.png',
      tenantId: 'tenant-a',
      artifactType: 'screenshot',
      fileName: 'shot.png',
      displayRotation: 'landscape-left',
    },
  ]);
});

test('finalizeDaemonResponse registers no display rotation for a value outside the rotation vocabulary', () => {
  const req: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'screenshot',
    positionals: [],
    meta: { clientArtifactPaths: { path: '/client/shot.png' } },
  };
  const tracked: DownloadableArtifactRegistration[] = [];

  finalizeDaemonResponse(
    req,
    { ok: true, data: { path: '/tmp/shot.png', displayRotation: 'sideways' } },
    (registration) => {
      tracked.push(registration);
      return 'artifact-id';
    },
  );

  expect(tracked).toHaveLength(1);
  expect(tracked[0]).not.toHaveProperty('displayRotation');
});

test('finalizeDaemonResponse registers the display rotation a handler put on its own artifact', () => {
  const req: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
  };
  const tracked: DownloadableArtifactRegistration[] = [];
  const fallbackArtifact = {
    field: 'fallbackScreenshotPath',
    artifactType: 'screenshot' as const,
    path: '/tmp/snapshot-fallback.png',
    fileName: 'snapshot-fallback.png',
    displayRotation: 'landscape-right' as const,
  };

  finalizeDaemonResponse(
    req,
    { ok: true, data: { artifacts: [fallbackArtifact] } },
    (registration) => {
      tracked.push(registration);
      return 'artifact-id';
    },
  );

  expect(tracked[0]?.displayRotation).toBe('landscape-right');
});

test('finalizeDaemonResponse registers no display rotation outside the vocabulary on a handler artifact', () => {
  const req: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
  };
  const tracked: DownloadableArtifactRegistration[] = [];
  const fallbackArtifact = {
    field: 'fallbackScreenshotPath',
    artifactType: 'screenshot' as const,
    path: '/tmp/snapshot-fallback.png',
    fileName: 'snapshot-fallback.png',
    displayRotation: 'sideways',
  };

  finalizeDaemonResponse(
    req,
    { ok: true, data: { artifacts: [fallbackArtifact] } },
    (registration) => {
      tracked.push(registration);
      return 'artifact-id';
    },
  );

  expect(tracked).toHaveLength(1);
  expect(tracked[0]).not.toHaveProperty('displayRotation');
});
