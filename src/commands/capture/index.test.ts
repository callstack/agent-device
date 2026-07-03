import { describe, expect, test } from 'vitest';
import type { CliFlags } from '../../cli/parser/cli-flags.ts';
import {
  alertCliReader,
  alertDaemonWriter,
  diffCliReader,
  screenshotCliReader,
  screenshotDaemonWriter,
  settingsCliReader,
  settingsDaemonWriter,
  snapshotCliReader,
  waitCliReader,
  waitDaemonWriter,
} from './index.ts';
import { snapshotCliOutput } from './output.ts';

function flags(overrides: Partial<CliFlags> = {}): CliFlags {
  return overrides as CliFlags;
}

function expectInvalidArgs(fn: () => unknown, messageFragment: string) {
  expect(fn).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining(messageFragment),
    }),
  );
}

describe('capture command interface', () => {
  test('reads snapshot flags', () => {
    expect(
      snapshotCliReader(
        [],
        flags({
          snapshotInteractiveOnly: true,
          snapshotDepth: 3,
          snapshotScope: 'Login',
          snapshotRaw: true,
          snapshotForceFull: true,
          timeoutMs: 10_000,
        }),
      ),
    ).toMatchObject({
      interactiveOnly: true,
      depth: 3,
      scope: 'Login',
      raw: true,
      forceFull: true,
      timeoutMs: 10_000,
    });
  });

  test('routes snapshot diagnostics warning to stderr output', () => {
    const output = snapshotCliOutput({
      result: {
        nodes: [],
        truncated: false,
        identifiers: {},
        snapshotDiagnostics: {
          stats: {
            count: 2,
            p50Ms: 400,
            p95Ms: 1_900,
            maxMs: 1_900,
            slowThresholdMs: 1_500,
            platform: 'ios',
          },
          warning: 'Warning: ios snapshots are slow in this run: p95 1900ms over 2 captures.',
        },
      },
    });

    expect(output.stderr).toBe(
      'Warning: ios snapshots are slow in this run: p95 1900ms over 2 captures.\n',
    );
    expect(output.text).not.toContain('snapshots are slow');
  });

  test('reads screenshot path and writes screenshot flags', () => {
    const input = screenshotCliReader(
      ['page.png'],
      flags({ screenshotFullscreen: true, screenshotMaxSize: 1024 }),
    );
    expect(input).toMatchObject({
      path: 'page.png',
      fullscreen: true,
      maxSize: 1024,
    });
    expect(screenshotDaemonWriter(input)).toMatchObject({
      command: 'screenshot',
      positionals: ['page.png'],
      options: {
        screenshotFullscreen: true,
        screenshotMaxSize: 1024,
      },
    });
  });

  test('reads and writes screenshot status-bar normalization flag', () => {
    const input = screenshotCliReader(['page.png'], flags({ screenshotNormalizeStatusBar: true }));
    expect(input).toMatchObject({
      path: 'page.png',
      normalizeStatusBar: true,
    });
    expect(screenshotDaemonWriter(input)).toMatchObject({
      command: 'screenshot',
      options: {
        screenshotNormalizeStatusBar: true,
      },
    });
  });

  test('reads diff snapshot input only', () => {
    expect(
      diffCliReader(['snapshot'], flags({ snapshotDepth: 4, out: './diff.json' })),
    ).toMatchObject({
      kind: 'snapshot',
      depth: 4,
      out: './diff.json',
    });
    expectInvalidArgs(() => diffCliReader(['screenshot'], flags()), 'Only diff snapshot');
  });

  test('reads and writes wait targets', () => {
    expect(waitCliReader(['text', 'Ready', '5000'], flags())).toMatchObject({
      text: 'Ready',
      timeoutMs: 5000,
    });
    expect(waitDaemonWriter({ text: 'Ready', timeoutMs: 5000 })).toMatchObject({
      command: 'wait',
      positionals: ['text', 'Ready', '5000'],
    });
    expectInvalidArgs(() => waitDaemonWriter({ text: 'Ready', ref: '@e1' }), 'exactly one');
  });

  test('reads and writes wait stable with defaults', () => {
    expect(waitCliReader(['stable'], flags())).toMatchObject({ stable: true });
    expect(waitDaemonWriter({ stable: true })).toMatchObject({
      command: 'wait',
      positionals: ['stable'],
    });
  });

  test('reads and writes wait stable with quietMs and timeoutMs', () => {
    expect(waitCliReader(['stable', '500', '10000'], flags())).toMatchObject({
      stable: true,
      quietMs: 500,
      timeoutMs: 10_000,
    });
    expect(waitDaemonWriter({ stable: true, quietMs: 500, timeoutMs: 10_000 })).toMatchObject({
      command: 'wait',
      positionals: ['stable', '500', '10000'],
    });
  });

  test('rejects wait stable combined with another target', () => {
    expectInvalidArgs(() => waitDaemonWriter({ stable: true, text: 'Ready' }), 'exactly one');
  });

  test('rejects wait stable timeoutMs without quietMs', () => {
    expectInvalidArgs(
      () => waitDaemonWriter({ stable: true, timeoutMs: 10_000 }),
      'quietMs before timeoutMs',
    );
  });

  test('reads and writes alert action and timeout', () => {
    expect(alertCliReader(['wait', '3000'], flags())).toMatchObject({
      action: 'wait',
      timeoutMs: 3000,
    });
    expect(alertDaemonWriter({ action: 'dismiss', timeoutMs: 1000 })).toMatchObject({
      command: 'alert',
      positionals: ['dismiss', '1000'],
    });
  });

  test('reads and writes settings input', () => {
    const input = settingsCliReader(['permission', 'grant', 'camera', 'limited'], flags());
    expect(input).toMatchObject({
      setting: 'permission',
      state: 'grant',
      permission: 'camera',
      mode: 'limited',
    });
    expect(settingsDaemonWriter(input)).toMatchObject({
      command: 'settings',
      positionals: ['permission', 'grant', 'camera', 'limited'],
    });
  });
});
