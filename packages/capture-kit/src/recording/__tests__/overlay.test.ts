import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createTestHost } from '../../host-environment.fixtures.ts';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempUnsharedForTestSync } from '../../unshared-tmp-dir.fixtures.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
    ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
    runCmd: vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === '/usr/bin/xcrun') {
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
  const helperCall = mockRunCmd.mock.calls.find(([cmd]) => cmd !== '/usr/bin/xcrun');
  return (helperCall?.[1] as string[] | undefined) ?? [];
}

const mockRunCmd = vi.mocked(runCmd);

let tmpDir = '';

beforeEach((context) => {
  tmpDir = mkdtempUnsharedForTestSync('agent-device-overlay-test-', context);
  vi.stubEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', path.join(tmpDir, 'swift-cache'));
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
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
    return cmd === '/usr/bin/xcrun' && args.includes('swiftc');
  });
  const helperCalls = mockRunCmd.mock.calls.filter(([cmd]) => cmd !== '/usr/bin/xcrun');

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
  // Launched through runSwiftHelper: the constructed helper environment, with its fixed PATH.
  expect(helperOptions?.env?.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  expect(helperOptions?.env?.HOME).toBe(path.join(tmpDir, 'swift-cache', 'v3', 'home'));
  expect(helperOptions?.env?.CLANG_MODULE_CACHE_PATH).toBe(
    path.join(tmpDir, 'swift-cache', 'v3', 'module-cache'),
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

  const compileCall = mockRunCmd.mock.calls.find(([cmd]) => cmd === '/usr/bin/xcrun');
  const helperCall = mockRunCmd.mock.calls.find(([cmd]) => cmd !== '/usr/bin/xcrun');
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

  const helperCall = mockRunCmd.mock.calls.find(([cmd]) => cmd !== '/usr/bin/xcrun');
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
  expect(mockRunCmd.mock.calls.filter(([cmd]) => cmd !== '/usr/bin/xcrun')).toHaveLength(0);
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

test('overlay keeps the video as recorded when the export never plays within its budget', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');
  vi.mocked(waitForPlayableVideo).mockResolvedValueOnce(false);

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

test('the overlay compiles its shipped source, never one planted at the checkout path of an installed package', async () => {
  // An installed agent-device package whose top-level checkout path another user could write, used as the
  // host's working directory: neither location is a source the overlay may compile.
  const installed = path.join(tmpDir, 'node_modules', 'agent-device');
  const planted = path.join(installed, 'packages/host-swift/swift/recording-overlay.swift');
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'agent-device' }));
  fs.writeFileSync(planted, 'print("planted")\n');
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');
  const compiled: Record<string, string> = {};
  const outsideStaging: string[] = [];
  const defaultRunCmd = mockRunCmd.getMockImplementation()!;
  mockRunCmd.mockImplementationOnce(async (cmd, args, options) => {
    // Every Swift input the compiler is handed must be a file in this compile's private staging directory,
    // the directory its output is written to; any path elsewhere is a source read from disk.
    const stagingDirectory = path.dirname(args[args.indexOf('-o') + 1]!);
    for (const sourcePath of args.filter((arg) => arg.endsWith('.swift'))) {
      if (path.dirname(sourcePath) !== stagingDirectory) outsideStaging.push(sourcePath);
      // The bytes the compiler would read, while the staging directory still exists.
      compiled[path.basename(sourcePath)] = fs.readFileSync(sourcePath, 'utf8');
    }
    return await defaultRunCmd(cmd, args, options);
  });

  await overlayRecordingTouches({
    host: { ...createTestHost(), cwd: installed },
    videoPath,
    telemetryPath,
    deadline: startRecordingOverlayBudget(),
  });

  const { RECORDING_OVERLAY_SOURCES } =
    await import('@agent-device/host-swift/recording-swift-sources');
  expect(outsideStaging).toEqual([]);
  expect(compiled).toEqual(
    Object.fromEntries(RECORDING_OVERLAY_SOURCES.map(({ fileName, text }) => [fileName, text])),
  );
});
