import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../utils/exec.ts', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
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

vi.mock('../../utils/video.ts', () => ({
  waitForStableFile: vi.fn(async () => {}),
  waitForPlayableVideo: vi.fn(async () => {}),
}));

import {
  buildRecordingScriptPathCandidates,
  overlayRecordingTouches,
  resizeRecording,
} from '../overlay.ts';
import { AppError } from '../../kernel/errors.ts';
import { runCmd } from '../../utils/exec.ts';

function helperScriptArgs(): string[] {
  const helperCall = mockRunCmd.mock.calls.find(([cmd]) => cmd !== 'xcrun');
  return (helperCall?.[1] as string[] | undefined) ?? [];
}

const mockRunCmd = vi.mocked(runCmd);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-overlay-test-'));
  vi.stubEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', path.join(tmpDir, 'swift-cache'));
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('overlay burns touches through a cached helper and same-directory temp output', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  await overlayRecordingTouches({ videoPath, telemetryPath });
  fs.writeFileSync(videoPath, 'second original');
  await overlayRecordingTouches({ videoPath, telemetryPath });

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

  await expect(overlayRecordingTouches({ videoPath, telemetryPath })).rejects.toMatchObject({
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

  await overlayRecordingTouches({ videoPath, telemetryPath });

  expect(helperScriptArgs()).toEqual(
    expect.arrayContaining(['--events', telemetryPath, '--quality', 'medium']),
  );
});

test('overlay forwards the requested high export preset', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  const telemetryPath = path.join(tmpDir, 'recording.gesture-telemetry.json');
  fs.writeFileSync(videoPath, 'original');
  fs.writeFileSync(telemetryPath, '{"events":[]}');

  await overlayRecordingTouches({ videoPath, telemetryPath, exportQuality: 'high' });

  expect(helperScriptArgs()).toEqual(
    expect.arrayContaining(['--events', telemetryPath, '--quality', 'high']),
  );
});

test('resize forwards max-size and defaults to the fast medium export preset', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  fs.writeFileSync(videoPath, 'original');

  await resizeRecording({ videoPath, maxSize: 1024 });

  expect(helperScriptArgs()).toEqual(
    expect.arrayContaining(['--max-size', '1024', '--quality', 'medium']),
  );
});

test('resize forwards the requested high export preset', async () => {
  const videoPath = path.join(tmpDir, 'recording.mp4');
  fs.writeFileSync(videoPath, 'original');

  await resizeRecording({ videoPath, maxSize: 720, exportQuality: 'high' });

  expect(helperScriptArgs()).toEqual(
    expect.arrayContaining(['--max-size', '720', '--quality', 'high']),
  );
});

test('recording script candidates include packaged dist apple-runner source', () => {
  const packageRoot = path.join(tmpDir, 'package');
  const scriptPath = path.join(
    packageRoot,
    'dist/apple/runner/AgentDeviceRunner/RecordingScripts/recording-overlay.swift',
  );
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, 'print("overlay")\n');

  const candidates = buildRecordingScriptPathCandidates(
    'recording-overlay.swift',
    path.join(packageRoot, 'dist/src'),
    packageRoot,
    tmpDir,
  );
  const firstExisting = candidates.find((candidate) => fs.existsSync(candidate));

  expect(firstExisting).toBe(scriptPath);
});
