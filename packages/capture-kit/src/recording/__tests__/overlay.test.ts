import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createTestHost } from '../../host-environment.fixtures.ts';
import fs from 'node:fs';
import path from 'node:path';
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
  waitForPlayableVideo: vi.fn(async () => {}),
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
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('overlay burns touches through a cached helper and same-directory temp output', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  await overlayRecordingTouches({
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
  });
  fs.writeFileSync(videoPath, 'second original');
  await overlayRecordingTouches({
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
  });

  const compileCalls = mockRunCmd.mock.calls.filter(([cmd, args]) => {
    return cmd === 'xcrun' && args[0] === 'swiftc';
  });
  const helperCalls = mockRunCmd.mock.calls.filter(([cmd]) => cmd !== 'xcrun');

  expect(compileCalls).toHaveLength(1);
  expect(helperCalls).toHaveLength(2);

  const [helperCmd, helperArgs, helperOptions] = helperCalls[0]!;
  const inputPath = helperArgs[helperArgs.indexOf('--input') + 1]!;
  const outputPath = helperArgs[helperArgs.indexOf('--output') + 1]!;
  expect(inputPath).toBe(videoPath);
  expect(outputPath).not.toBe(videoPath);
  expect(path.dirname(outputPath)).toBe(tmpDir);
  expect(path.basename(outputPath)).toMatch(/^\.recording\.agent-device-/);
  expect(fs.existsSync(outputPath)).toBe(false);
  expect(fs.readFileSync(videoPath, 'utf8')).toBe(`processed ${path.basename(helperCmd)}`);
  expect(helperOptions?.env?.HOME).toBe(path.join(tmpDir, 'swift-cache', 'home'));
  expect(helperOptions?.env?.CLANG_MODULE_CACHE_PATH).toBe(
    path.join(tmpDir, 'swift-cache', 'module-cache'),
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

test('overlay defaults to the fast medium export preset', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  await overlayRecordingTouches({
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
  });

  expect(helperScriptArgs()).toEqual(
    expect.arrayContaining(['--events', telemetryPath, '--quality', 'medium']),
  );
});

test('overlay forwards the requested high export preset', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  await overlayRecordingTouches({
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
    exportQuality: 'high',
  });

  expect(helperScriptArgs()).toEqual(
    expect.arrayContaining(['--events', telemetryPath, '--quality', 'high']),
  );
});

test('overlay caps the helper frame rate at the caller fps only when one was asked for', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  await overlayRecordingTouches({
    host: createTestHost(),
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
  });
  expect(helperScriptArgs()).not.toContain('--max-fps');

  mockRunCmd.mockClear();
  await overlayRecordingTouches({
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

  await overlayRecordingTouches({ host: createTestHost(), videoPath, telemetryPath, deadline });

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
      host: createTestHost(),
      videoPath,
      telemetryPath,
      deadline: startRecordingOverlayBudget(),
    }),
  ).rejects.toMatchObject({
    message: 'Failed to add touch overlays to the recording',
  });
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
  });

  await expect(
    overlayRecordingTouches({ host: createTestHost(), videoPath, telemetryPath, deadline }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: `Failed to add touch overlays to the recording: the export did not finish within its ${OVERLAY_BUDGET_MS}ms budget; a lower --fps renders faster`,
  });
  expect(vi.mocked(waitForPlayableVideo)).toHaveBeenCalledWith(expect.any(String), {
    host: expect.objectContaining({ cwd: process.cwd() }),
    deadline,
  });
  expect(fs.readFileSync(videoPath, 'utf8')).toBe('original');
  expect(fs.readdirSync(tmpDir).filter((name) => name.includes('agent-device-'))).toEqual([]);
});
