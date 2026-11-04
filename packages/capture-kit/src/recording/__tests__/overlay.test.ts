import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createTestHost } from '../../host-environment.fixtures.ts';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { mkdtempForTestSync } from '../../tmp-dir.fixtures.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
    ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
    runCmd: vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'xcrun') {
        const outputPath = args[args.indexOf('-o') + 1]!;
        fs.writeFileSync(outputPath, 'compiled');
        fs.chmodSync(outputPath, 0o755);
        return { stdout: '', stderr: '', exitCode: 0 };
      }

      const outputPath = args[args.indexOf('--output') + 1]!;
      fs.writeFileSync(outputPath, `processed ${path.basename(cmd)}`);
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
  };
});

vi.mock('../video.ts', () => ({
  waitForPlayableVideo: vi.fn(async () => true),
}));

import {
  OVERLAY_BUDGET_MS,
  overlayRecordingTouches,
  startRecordingOverlayBudget,
} from '../overlay.ts';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import { waitForPlayableVideo } from '../video.ts';

function helperScriptArgs(): string[] {
  const helperCall = mockRunCmd.mock.calls.find(([cmd]) => cmd !== 'xcrun');
  return (helperCall?.[1] as string[] | undefined) ?? [];
}

const mockRunCmd = vi.mocked(runCmd);

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempForTestSync('agent-device-overlay-test-');
  vi.stubEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', path.join(tmpDir, 'swift-cache'));
  vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', path.join(tmpDir, 'claims'));
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('overlay burns touches through private copies and publishes a cached helper result', async () => {
  const validator = {
    kind: 'avfoundation' as const,
    executablePath: '/prepared/video-validator',
    env: {},
  };
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  await overlayRecordingTouches({
    validator,
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
  });
  fs.writeFileSync(videoPath, 'second original');
  await overlayRecordingTouches({
    validator,
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
  });

  const compileCalls = mockRunCmd.mock.calls.filter(([cmd, args]) => {
    return cmd === 'xcrun' && args[0] === '--no-cache' && args[1] === 'swiftc';
  });
  const helperCalls = mockRunCmd.mock.calls.filter(([cmd]) => cmd !== 'xcrun');

  expect(compileCalls).toHaveLength(1);
  expect(helperCalls).toHaveLength(2);
  expect(vi.mocked(waitForPlayableVideo).mock.calls[0]?.[1].validator).toBe(validator);

  const [helperCmd, helperArgs, helperOptions] = helperCalls[0]!;
  const inputPath = helperArgs[helperArgs.indexOf('--input') + 1]!;
  const outputPath = helperArgs[helperArgs.indexOf('--output') + 1]!;
  expect(inputPath).not.toBe(videoPath);
  expect(path.dirname(inputPath)).toBe(path.dirname(outputPath));
  expect(outputPath).toContain(path.join('swift-cache', 'attempts'));
  expect(helperArgs[helperArgs.indexOf('--events') + 1]).toBe(
    path.join(path.dirname(outputPath), 'events.json'),
  );
  expect(fs.existsSync(outputPath)).toBe(false);
  expect(fs.readFileSync(videoPath, 'utf8')).toBe(`processed ${path.basename(helperCmd)}`);
  expect(helperOptions?.env?.HOME).toBe(path.join(path.dirname(outputPath), 'home'));
  expect(helperOptions?.env?.CLANG_MODULE_CACHE_PATH).toBe(
    path.join(path.dirname(outputPath), 'module-cache'),
  );
});

test('overlay preserves Swift helper compile hints', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  const hint = 'Remove the stale Swift cache lock and retry.';
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  mockRunCmd.mockImplementationOnce(async () => {
    throw new AppError('COMMAND_FAILED', 'Timed out waiting for Swift cache lock', { hint });
  });

  await expect(
    overlayRecordingTouches({
      validator: undefined,
      host: createTestHost(),
      videoPath,
      telemetryPath,
      deadline: startRecordingOverlayBudget(),
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Failed to add touch overlays to the recording',
    details: {
      hint,
    },
  });
});

test('refuses an overlay that changes while the parent copies it', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'events.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');
  const create = fs.createReadStream;
  const spy = vi.spyOn(fs, 'createReadStream').mockImplementation(((source, options) => {
    const stream = create(source, options);
    if (typeof source === 'string' && path.basename(source) === 'output.mp4') {
      stream.once('end', () => fs.appendFileSync(source, 'late'));
    }
    return stream;
  }) as typeof fs.createReadStream);
  try {
    await expect(
      overlayRecordingTouches({
        host: createTestHost(),
        validator: undefined,
        videoPath,
        telemetryPath,
        deadline: startRecordingOverlayBudget(),
      }),
    ).rejects.toMatchObject({ details: { reason: 'recording_overlay_output_changed' } });
    expect(fs.readFileSync(videoPath, 'utf8')).toBe('original');
  } finally {
    spy.mockRestore();
  }
});

test.each(['input', 'output'] as const)(
  'a stalled %s copy is canceled by the finalization deadline and retains the raw video',
  async (stage) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const videoPath = path.join(tmpDir, 'recording.mp4');
    const telemetryPath = path.join(tmpDir, 'events.json');
    fs.writeFileSync(videoPath, 'original');
    fs.writeFileSync(telemetryPath, '{"events":[]}');
    let destroyed = false;
    let notifyRead!: () => void;
    const entered = new Promise<void>((resolve) => {
      notifyRead = resolve;
    });
    const create = fs.createReadStream;
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementation(((source, options) => {
      const target =
        stage === 'input'
          ? source === videoPath
          : typeof source === 'string' && path.basename(source) === 'output.mp4';
      if (!target) return create(source, options);
      return new Readable({
        read() {
          notifyRead();
        },
        destroy(error, callback) {
          destroyed = true;
          callback(error);
        },
      }) as fs.ReadStream;
    }) as typeof fs.createReadStream);
    const deadline = startRecordingOverlayBudget();
    try {
      const outcome = overlayRecordingTouches({
        host: createTestHost(),
        validator: undefined,
        videoPath,
        telemetryPath,
        deadline,
      }).then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      const first = await Promise.race([
        entered.then(() => 'entered'),
        outcome.then(() => 'completed'),
      ]);
      expect(first).toBe('entered');
      const started = performance.now();
      await vi.advanceTimersByTimeAsync(OVERLAY_BUDGET_MS);
      expect(await outcome).toMatchObject({
        status: 'rejected',
        error: { code: 'COMMAND_FAILED' },
      });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(destroyed).toBe(true);
      expect(fs.readFileSync(videoPath, 'utf8')).toBe('original');
      expect(mockRunCmd.mock.calls.filter(([command]) => command !== 'xcrun')).toHaveLength(
        stage === 'input' ? 0 : 1,
      );
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  },
);

test('caller cancellation waits for a stalled copy to close and preserves its typed reason', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'events.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');
  const cancel = new AbortController();
  let destroyed = false;
  const create = fs.createReadStream;
  const spy = vi.spyOn(fs, 'createReadStream').mockImplementation(((source, options) => {
    if (source !== videoPath) return create(source, options);
    return new Readable({
      read() {
        cancel.abort();
      },
      destroy(error, callback) {
        destroyed = true;
        callback(error);
      },
    }) as fs.ReadStream;
  }) as typeof fs.createReadStream);
  try {
    await expect(
      overlayRecordingTouches({
        host: createTestHost(),
        validator: undefined,
        videoPath,
        telemetryPath,
        deadline: startRecordingOverlayBudget(),
        signal: cancel.signal,
      }),
    ).rejects.toMatchObject({ details: { reason: 'request_canceled' } });
    expect(destroyed).toBe(true);
    expect(fs.readFileSync(videoPath, 'utf8')).toBe('original');
  } finally {
    spy.mockRestore();
  }
});

test('overlay defaults to the fast medium export preset', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  await overlayRecordingTouches({
    validator: undefined,
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
  });

  expect(helperScriptArgs()).toEqual(expect.arrayContaining(['--events', '--quality', 'medium']));
});

test('overlay forwards the requested high export preset', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  await overlayRecordingTouches({
    validator: undefined,
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
    exportQuality: 'high',
  });

  expect(helperScriptArgs()).toEqual(expect.arrayContaining(['--events', '--quality', 'high']));
});

test('overlay caps the helper frame rate at the caller fps only when one was asked for', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  await overlayRecordingTouches({
    validator: undefined,
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
  });
  expect(helperScriptArgs()).not.toContain('--max-fps');

  mockRunCmd.mockClear();
  await overlayRecordingTouches({
    validator: undefined,
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
    fps: 15,
  });
  const args = helperScriptArgs();
  expect(args[args.indexOf('--max-fps') + 1]).toBe('15');
});

test('overlay hands the helper what is left of its budget, inside the record request', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  await overlayRecordingTouches({
    validator: undefined,
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
  });

  const compileCall = mockRunCmd.mock.calls.find(([cmd]) => cmd === 'xcrun');
  const helperCall = mockRunCmd.mock.calls.find(([cmd]) => cmd !== 'xcrun');
  const args = helperScriptArgs();
  const exportMs = Number(args[args.indexOf('--timeout-ms') + 1]);
  expect(exportMs).toBeGreaterThan(0);
  // The compile, the export and the helper's exit all fit in the budget. That the budget fits in
  // `record`'s request envelope is checked where the envelope is declared.
  expect(compileCall?.[2]?.timeoutMs).toBeLessThanOrEqual(OVERLAY_BUDGET_MS);
  expect(helperCall?.[2]?.timeoutMs).toBeLessThanOrEqual(OVERLAY_BUDGET_MS);
  expect(exportMs).toBeLessThan(helperCall?.[2]?.timeoutMs ?? 0);
});

test('overlay hands the helper only what the finalization left of the budget', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');
  const spentMs = 25_000;
  const deadline = startRecordingOverlayBudget();
  vi.setSystemTime(Date.now() + spentMs);

  await overlayRecordingTouches({
    validator: undefined,
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline,
  });

  const helperCall = mockRunCmd.mock.calls.find(([cmd]) => cmd !== 'xcrun');
  expect(helperCall?.[2]?.timeoutMs).toBe(OVERLAY_BUDGET_MS - spentMs);
});

test('overlay leaves the video as recorded when compiling the helper spent its budget', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  mockRunCmd.mockImplementationOnce(async (_cmd, args) => {
    vi.setSystemTime(Date.now() + OVERLAY_BUDGET_MS);
    const outputPath = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(outputPath, 'compiled');
    fs.chmodSync(outputPath, 0o755);
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await expect(
    overlayRecordingTouches({
      validator: undefined,
      host: createTestHost(),
      videoPath,
      telemetryPath,
      deadline: startRecordingOverlayBudget(),
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Failed to add touch overlays to the recording',
  });
  expect(mockRunCmd.mock.calls.filter(([cmd]) => cmd !== 'xcrun')).toHaveLength(0);
  expect(fs.readFileSync(videoPath, 'utf8')).toBe('original');
});

test('overlay names its budget when the export ran out of it', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  await overlayRecordingTouches({
    validator: undefined,
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
  });
  fs.writeFileSync(videoPath, 'original');
  mockRunCmd.mockImplementationOnce(async () => {
    vi.setSystemTime(Date.now() + OVERLAY_BUDGET_MS);
    throw new AppError('COMMAND_FAILED', 'recording-overlay exited with code 1');
  });

  await expect(
    overlayRecordingTouches({
      validator: undefined,
      host: createTestHost(),
      videoPath,
      telemetryPath,
      deadline: startRecordingOverlayBudget(),
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: `Failed to add touch overlays to the recording: the export did not finish within its ${OVERLAY_BUDGET_MS}ms budget; a lower --fps renders faster`,
  });
  expect(fs.readFileSync(videoPath, 'utf8')).toBe('original');
});

test('overlay keeps the plain failure when the export failed with budget to spare', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  await overlayRecordingTouches({
    validator: undefined,
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
  });
  mockRunCmd.mockImplementationOnce(async () => {
    throw new AppError('COMMAND_FAILED', 'recording-overlay exited with code 1');
  });

  await expect(
    overlayRecordingTouches({
      validator: undefined,
      host: createTestHost(),
      videoPath,
      telemetryPath,
      deadline: startRecordingOverlayBudget(),
    }),
  ).rejects.toMatchObject({
    message: 'Failed to add touch overlays to the recording',
  });
});

test('overlay keeps the video as recorded when the export never plays within its budget', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');
  vi.mocked(waitForPlayableVideo).mockResolvedValueOnce(false);

  await expect(
    overlayRecordingTouches({
      validator: undefined,
      host: createTestHost(),
      videoPath,
      telemetryPath,
      deadline: startRecordingOverlayBudget(),
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Failed to add touch overlays to the recording',
  });
  expect(fs.readFileSync(videoPath, 'utf8')).toBe('original');
});

test('overlay keeps the video as recorded when verifying the export spent its budget', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');
  const deadline = startRecordingOverlayBudget();
  vi.mocked(waitForPlayableVideo).mockImplementationOnce(async () => {
    vi.setSystemTime(Date.now() + OVERLAY_BUDGET_MS);
    return false;
  });

  await expect(
    overlayRecordingTouches({
      validator: undefined,
      host: createTestHost(),
      videoPath,
      telemetryPath,
      deadline,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: `Failed to add touch overlays to the recording: the export did not finish within its ${OVERLAY_BUDGET_MS}ms budget; a lower --fps renders faster`,
  });
  expect(vi.mocked(waitForPlayableVideo)).toHaveBeenCalledWith(expect.any(String), {
    validator: undefined,
    deadline,
    signal: expect.any(AbortSignal),
  });
  expect(fs.readFileSync(videoPath, 'utf8')).toBe('original');
  await vi.waitFor(() =>
    expect(fs.readdirSync(tmpDir).filter((name) => name.includes('agent-device-'))).toEqual([]),
  );
});
