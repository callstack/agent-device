import { describe, expect, test } from 'vitest';
import { doctorCliOutput, managementCliOutputFormatters, openCliOutput } from './output.ts';
import { markDoctorProgressRendered } from '../../utils/doctor-progress.ts';
import { withNoColor } from '../../__tests__/test-utils/color.ts';
import type { AppOpenResult } from '@agent-device/contracts/client';

describe('openCliOutput', () => {
  test('prints session state directory on a second line', () => {
    const output = openCliOutput({
      session: 'default',
      sessionStateDir: '/tmp/agent-device/sessions/cwd_123_default',
      identifiers: { session: 'default' },
    });

    expect(output.text).toBe(
      ['Opened: default', 'Session state: /tmp/agent-device/sessions/cwd_123_default'].join('\n'),
    );
    expect(output.data).toMatchObject({
      session: 'default',
      sessionStateDir: '/tmp/agent-device/sessions/cwd_123_default',
    });
  });

  test('keeps internal open timing out of public output data', () => {
    const result: AppOpenResult & { timing: { totalDurationMs: number } } = {
      session: 'default',
      sessionStateDir: '/tmp/agent-device/sessions/cwd_123_default',
      identifiers: { session: 'default' },
      timing: { totalDurationMs: 42 },
    };
    const output = openCliOutput(result);

    expect(output.data).not.toHaveProperty('timing');
  });

  test('preserves open warnings in JSON data and renders them immediately', () => {
    const warning =
      'Script publication was aborted by a second successful open; start a fresh session.';
    const output = openCliOutput({
      session: 'authoring',
      warnings: [warning],
      identifiers: { session: 'authoring' },
    });

    expect(output.data).toMatchObject({ warnings: [warning] });
    expect(output.text).toBe(`Opened: authoring\nWarning: ${warning}`);
  });

  // #1671 P1: the composed open --foreground snapshot must render on default
  // stdout through the PRODUCTION formatter route (the family-registry entry
  // the CLI resolves, not a helper mock), printing the same interactive tree
  // lines `snapshot -i` prints after the open confirmation.
  test('production formatter route renders the composed --foreground snapshot tree on default output', async () => {
    const { formatCliOutput } = await import('../cli-output.ts');
    const { attachRefs } = await import('@agent-device/kernel/snapshot');
    const nodes = attachRefs([
      { index: 0, type: 'Button', label: 'Sign In', depth: 0, hittable: true },
      { index: 1, type: 'TextField', label: 'Email', depth: 0, hittable: true },
    ]);
    const openResult: AppOpenResult = {
      session: 'default',
      sessionStateDir: '/tmp/agent-device/sessions/cwd_123_default',
      appBundleId: 'com.apple.Preferences',
      snapshot: { nodes, truncated: false, backend: 'xctest', refsGeneration: 1 },
      identifiers: { session: 'default' },
    };

    const openOutput = withNoColor(() =>
      formatCliOutput({ name: 'open', input: {}, result: openResult }),
    );
    const snapshotOutput = withNoColor(() =>
      formatCliOutput({
        name: 'snapshot',
        input: { interactiveOnly: true },
        result: { nodes, truncated: false, backend: 'xctest', refsGeneration: 1 },
      }),
    );

    if (!openOutput?.text || !snapshotOutput?.text) {
      throw new Error('production formatter route returned no text output');
    }
    // The tree lines are exactly what `snapshot -i` would print, appended
    // after the open confirmation lines.
    expect(openOutput.text).toBe(
      [
        'Opened: com.apple.Preferences',
        'Session state: /tmp/agent-device/sessions/cwd_123_default',
        snapshotOutput.text,
      ].join('\n'),
    );
    expect(openOutput.text).toContain('Sign In');
    expect(openOutput.text).toContain('Email');
    // --json carries the same presented snapshot payload snapshot -i emits.
    const openJsonSnapshot = (openOutput.data as { snapshot?: unknown }).snapshot;
    expect(openJsonSnapshot).toEqual(snapshotOutput.jsonData ?? snapshotOutput.data);
  });

  test('renders the initialSnapshotError warning without a tree when the composed capture failed', () => {
    const warning =
      'The session is open, but the initial interactive snapshot failed (COMMAND_FAILED: capture failed). Run: agent-device snapshot -i';
    const output = openCliOutput({
      session: 'default',
      warnings: [warning],
      initialSnapshotError: {
        code: 'COMMAND_FAILED',
        message: 'capture failed',
        hint: 'Retry with --debug and inspect diagnostics log for details.',
        diagnosticId: 'diag-1',
        logPath: '/tmp/req.ndjson',
        details: { reason: 'runner_unavailable' },
      },
      identifiers: { session: 'default' },
    });

    expect(output.text).toBe(`Opened: default\nWarning: ${warning}`);
    // The FULL error shape survives into public JSON output.
    expect(output.data).toMatchObject({
      initialSnapshotError: {
        code: 'COMMAND_FAILED',
        message: 'capture failed',
        hint: 'Retry with --debug and inspect diagnostics log for details.',
        diagnosticId: 'diag-1',
        logPath: '/tmp/req.ndjson',
        details: { reason: 'runner_unavailable' },
      },
    });
  });
});

describe('artifactsCliOutput', () => {
  test('prints ready artifact URLs and preserves JSON data', () => {
    const output = managementCliOutputFormatters.artifacts({
      input: {},
      result: {
        provider: 'browserstack',
        providerSessionId: 'wd-1',
        status: 'ready',
        cloudArtifacts: [
          {
            provider: 'browserstack',
            providerSessionId: 'wd-1',
            kind: 'video',
            name: 'Session video',
            url: 'https://provider.example/video.mp4',
            availability: 'ready',
          },
        ],
      },
    });

    expect(output.text).toBe('video: Session video ready https://provider.example/video.mp4');
    expect(output.data).toMatchObject({
      cloudArtifacts: [{ url: 'https://provider.example/video.mp4' }],
    });
  });

  test('prints exact retry command for pending provider sessions', () => {
    const output = managementCliOutputFormatters.artifacts({
      input: {},
      result: {
        provider: 'aws-device-farm',
        providerSessionId: 'arn:aws:devicefarm:us-west-2:123:session/project/session/00000',
        status: 'pending',
        cloudArtifacts: [],
        message: 'AWS Device Farm artifacts are not ready yet.',
      },
    });

    expect(output.text).toBe(
      [
        'AWS Device Farm artifacts are not ready yet.',
        'Retry: agent-device artifacts arn:aws:devicefarm:us-west-2:123:session/project/session/00000 --provider aws-device-farm --json',
      ].join('\n'),
    );
  });

  test('prints daemon artifact inventory and preserves JSON data', () => {
    const output = managementCliOutputFormatters.artifacts({
      input: {},
      result: {
        source: 'daemon',
        status: 'ready',
        artifacts: [
          {
            id: 'artifact-1',
            artifactType: 'screenshot',
            filename: 'screenshot.png',
            mimeType: 'application/octet-stream',
            sizeBytes: 123,
            createdAt: '2026-07-02T12:00:00.000Z',
            expiresAt: '2026-07-02T12:15:00.000Z',
          },
        ],
      },
    });

    expect(output.text).toBe(
      'screenshot.png (screenshot): application/octet-stream 123 bytes id=artifact-1',
    );
    expect(output.data).toMatchObject({
      source: 'daemon',
      artifacts: [{ id: 'artifact-1', artifactType: 'screenshot', filename: 'screenshot.png' }],
    });
  });
});

describe('doctorCliOutput', () => {
  test('prints passing checks by default using test-style status markers', () => {
    const output = withNoColor(() =>
      doctorCliOutput({
        status: 'pass',
        summary: 'No blockers found.',
        checks: [
          {
            id: 'agent-device',
            status: 'pass',
            summary: 'agent-device 0.17.9 using /tmp/agent-device',
          },
          {
            id: 'device',
            status: 'pass',
            summary: 'Selected Pixel (android)',
          },
          {
            id: 'session',
            status: 'info',
            summary: 'No active session named default. Doctor will use the selected device.',
          },
        ],
      }),
    );

    expect(output.text).toBe(
      [
        'Doctor: pass',
        '✓ agent-device: agent-device 0.17.9 using /tmp/agent-device',
        '✓ device: Selected Pixel (android)',
        '- session: No active session named default. Doctor will use the selected device.',
      ].join('\n'),
    );
  });

  test('keeps warning and failure recovery details under the relevant row', () => {
    const output = withNoColor(() =>
      doctorCliOutput({
        status: 'fail',
        checks: [
          {
            id: 'device',
            status: 'fail',
            summary: 'No devices found.',
            command: 'agent-device devices',
          },
          {
            id: 'android-reverse',
            status: 'warn',
            summary: 'Android adb reverse is missing for Metro port 8081.',
            command: 'adb -s emulator-5554 reverse tcp:8081 tcp:8081',
          },
        ],
      }),
    );

    expect(output.text).toBe(
      [
        'Doctor: fail',
        '⨯ device: No devices found.',
        '  run: agent-device devices',
        '! android-reverse: Android adb reverse is missing for Metro port 8081.',
        '  run: adb -s emulator-5554 reverse tcp:8081 tcp:8081',
      ].join('\n'),
    );
  });

  test('prints only the summary after streamed progress rendered the checks', () => {
    const output = withNoColor(() => {
      markDoctorProgressRendered();
      return doctorCliOutput({
        status: 'pass',
        summary: 'No blockers found.',
        checks: [
          {
            id: 'device',
            status: 'pass',
            summary: 'Selected Pixel (android)',
          },
        ],
      });
    });

    expect(output.text).toBe(['Doctor: pass', 'No blockers found.'].join('\n'));
  });
});
