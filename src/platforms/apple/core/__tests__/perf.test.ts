import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/exec.ts')>();
  return {
    ...actual,
    runCmd: vi.fn(actual.runCmd),
    runCmdBackground: vi.fn(actual.runCmdBackground),
  };
});

import {
  buildAppleMemorySnapshotSupport,
  captureAppleMemorySnapshot,
  parseApplePsOutput,
  sampleAppleFramePerf,
  sampleApplePerfMetrics,
} from '../perf.ts';
import {
  startAppleXctracePerfCapture,
  stopAppleXctracePerfCapture,
  writeAppleXctracePerfReport,
  type AppleXctracePerfCapture,
} from '../perf-xctrace.ts';
import { parseAppleFramePerfSample } from '../perf-frame.ts';
import { runCmd, runCmdBackground } from '../../../../utils/exec.ts';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import { AppError } from '../../../../kernel/errors.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockRunCmdBackground = vi.mocked(runCmdBackground);
type MockRunCmdResult = Awaited<ReturnType<typeof runCmd>>;
type XcrunMockHandler = (args: string[]) => Promise<MockRunCmdResult | null>;

const IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  booted: true,
};

const MACOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-mac',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

const IOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  id: 'ios-device-1',
  name: 'iPhone Device',
  kind: 'device',
  booted: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  mockRunCmdBackground.mockImplementation(() => mockBackgroundXctrace());
  vi.useRealTimers();
});

function collectPlatformValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => collectPlatformValues(entry));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) =>
      key === 'platform' && typeof entry === 'string'
        ? [entry, ...collectPlatformValues(entry)]
        : collectPlatformValues(entry),
    );
  }
  return [];
}

test('buildAppleMemorySnapshotSupport projects support.platform to the macOS leaf', () => {
  // approach (b): response.support.platform must be the PUBLIC leaf, never the internal `apple`.
  const support = buildAppleMemorySnapshotSupport(MACOS_DEVICE);
  assert.equal(support.platform, 'macos');
  assert.equal(support.memgraph, true);
});

test('buildAppleMemorySnapshotSupport projects support.platform to the iOS leaf', () => {
  assert.equal(buildAppleMemorySnapshotSupport(IOS_SIMULATOR).platform, 'ios');
  assert.equal(buildAppleMemorySnapshotSupport(IOS_DEVICE).platform, 'ios');
});

test('buildAppleMemorySnapshotSupport never emits the internal apple platform', () => {
  // Guard: no emitted `platform` field on a representative Apple perf response may equal `apple`.
  for (const device of [MACOS_DEVICE, IOS_SIMULATOR, IOS_DEVICE]) {
    const platforms = collectPlatformValues(buildAppleMemorySnapshotSupport(device));
    assert.ok(platforms.length > 0, 'expected at least one platform field');
    assert.ok(
      !platforms.includes('apple'),
      `apple leaked in support for ${device.name}: ${platforms.join(', ')}`,
    );
  }
});

test('parseApplePsOutput reads pid cpu rss and command columns', () => {
  const rows = parseApplePsOutput(
    ['123 12.5 45678 /Applications/Test.app/Contents/MacOS/Test --flag', '456 0.0 2048 Test'].join(
      '\n',
    ),
  );

  assert.deepEqual(rows, [
    {
      pid: 123,
      cpuPercent: 12.5,
      rssKb: 45678,
      command: '/Applications/Test.app/Contents/MacOS/Test --flag',
    },
    {
      pid: 456,
      cpuPercent: 0,
      rssKb: 2048,
      command: 'Test',
    },
  ]);
});

test('parseAppleFramePerfSample summarizes app hitches and worst windows', () => {
  const sample = parseAppleFramePerfSample({
    hitchesXml: makeAppleHitchesXml(),
    frameLifetimesXml: makeAppleFrameLifetimesXml(4),
    displayInfoXml: makeAppleDisplayInfoXml(120),
    processIds: [4001],
    processNames: ['ExampleDeviceApp'],
    windowStartedAt: '2026-04-01T10:00:00.000Z',
    windowEndedAt: '2026-04-01T10:00:02.000Z',
    measuredAt: '2026-04-01T10:00:02.000Z',
  });

  assert.equal(sample.droppedFrameCount, 2);
  assert.equal(sample.totalFrameCount, 4);
  assert.equal(sample.droppedFramePercent, 50);
  assert.equal(sample.sampleWindowMs, 2000);
  assert.equal(sample.refreshRateHz, 120);
  assert.equal(sample.frameDeadlineMs, 8.3);
  assert.deepEqual(sample.matchedProcesses, ['ExampleDeviceApp']);
  assert.deepEqual(sample.worstWindows, [
    {
      startOffsetMs: 100,
      endOffsetMs: 238,
      startAt: '2026-04-01T10:00:00.100Z',
      endAt: '2026-04-01T10:00:00.238Z',
      missedDeadlineFrameCount: 2,
      worstFrameMs: 37.5,
    },
  ]);
});

test('sampleApplePerfMetrics aggregates host ps metrics for macOS app bundle', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-macos-perf-'));
  const bundlePath = path.join(tmpDir, 'Example.app');
  await fs.mkdir(path.join(bundlePath, 'Contents'), { recursive: true });
  await fs.writeFile(
    path.join(bundlePath, 'Contents', 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>ExampleExec</string>',
      '</dict></plist>',
    ].join(''),
    'utf8',
  );

  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd === 'mdfind') {
      return { stdout: `${bundlePath}\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') {
      return { stdout: '', stderr: 'mock fallback', exitCode: 1 };
    }
    if (cmd === 'ps') {
      return {
        stdout: [
          `111 8.5 12000 ${path.join(bundlePath, 'Contents', 'MacOS', 'ExampleExec')}`,
          `222 1.5 5000 ${path.join(bundlePath, 'Contents', 'MacOS', 'ExampleExec')} --helper`,
          '333 9.0 9999 /Applications/Other.app/Contents/MacOS/Other',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });

  try {
    const metrics = await sampleApplePerfMetrics(MACOS_DEVICE, 'com.example.app');
    assert.equal(metrics.cpu.usagePercent, 10);
    assert.equal(metrics.memory.residentMemoryKb, 17000);
    assert.deepEqual(metrics.cpu.matchedProcesses, ['ExampleExec']);
    assert.deepEqual(metrics.memory.matchedProcesses, ['ExampleExec']);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('sampleApplePerfMetrics uses simctl spawn ps for iOS simulators', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-sim-perf-'));
  const appPath = path.join(tmpDir, 'Example.app');
  await fs.mkdir(appPath, { recursive: true });
  await fs.writeFile(
    path.join(appPath, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>Example Sim Exec</string>',
      '</dict></plist>',
    ].join(''),
    'utf8',
  );

  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd === 'xcrun' && args.includes('get_app_container')) {
      return { stdout: `${appPath}\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') {
      return { stdout: '', stderr: 'mock fallback', exitCode: 1 };
    }
    if (cmd === 'xcrun' && args.includes('spawn') && args.includes('ps')) {
      return {
        stdout: [
          `111 12.0 8192 ${path.join(appPath, 'Example Sim Exec')}`,
          '222 4.0 1024 SpringBoard',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });

  try {
    const metrics = await sampleApplePerfMetrics(IOS_SIMULATOR, 'com.example.sim');
    assert.equal(metrics.cpu.usagePercent, 12);
    assert.equal(metrics.memory.residentMemoryKb, 8192);
    assert.deepEqual(metrics.cpu.matchedProcesses, ['Example Sim Exec']);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureAppleMemorySnapshot records memgraph for iOS simulator processes', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-sim-memgraph-'));
  const appPath = path.join(tmpDir, 'Example.app');
  const outPath = path.join(tmpDir, 'app.memgraph');
  await fs.mkdir(appPath, { recursive: true });
  await fs.writeFile(
    path.join(appPath, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>ExampleSimExec</string>',
      '</dict></plist>',
    ].join(''),
    'utf8',
  );

  mockRunCmd.mockImplementation(async (cmd, args, options) => {
    if (cmd === 'xcrun' && args.includes('get_app_container')) {
      return { stdout: `${appPath}\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') {
      return { stdout: '', stderr: 'mock fallback', exitCode: 1 };
    }
    if (cmd === 'xcrun' && args.includes('ps')) {
      return {
        stdout: [
          `111 1.0 8192 ${path.join(appPath, 'ExampleSimExec')}`,
          `222 1.0 16384 ${path.join(appPath, 'ExampleSimExec')} --helper`,
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    if (cmd === 'xcrun' && args.includes('leaks')) {
      assert.equal(options?.timeoutMs, 120_000);
      assert.deepEqual(args, [
        'simctl',
        'spawn',
        'sim-1',
        'leaks',
        `--outputGraph=${outPath}`,
        '222',
      ]);
      await fs.writeFile(outPath, 'memgraph-bytes', 'utf8');
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });

  try {
    const snapshot = await captureAppleMemorySnapshot(IOS_SIMULATOR, 'com.example.sim', outPath);
    assert.equal(snapshot.available, true);
    if (snapshot.available !== true) assert.fail(JSON.stringify(snapshot));
    assert.equal(snapshot.kind, 'memgraph');
    assert.equal(snapshot.path, outPath);
    assert.equal(snapshot.pid, 222);
    assert.equal(snapshot.sizeBytes, 'memgraph-bytes'.length);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureAppleMemorySnapshot records memgraph for macOS app processes', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-macos-memgraph-'));
  const bundlePath = path.join(tmpDir, 'Example.app');
  const outPath = path.join(tmpDir, 'app.memgraph');
  await fs.mkdir(path.join(bundlePath, 'Contents'), { recursive: true });
  await fs.writeFile(
    path.join(bundlePath, 'Contents', 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>ExampleExec</string>',
      '</dict></plist>',
    ].join(''),
    'utf8',
  );

  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd === 'mdfind') {
      return { stdout: `${bundlePath}\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') {
      return { stdout: '', stderr: 'mock fallback', exitCode: 1 };
    }
    if (cmd === 'ps') {
      return {
        stdout: `111 1.0 12000 ${path.join(bundlePath, 'Contents', 'MacOS', 'ExampleExec')}`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (cmd === 'leaks') {
      assert.deepEqual(args, [`--outputGraph=${outPath}`, '111']);
      await fs.writeFile(outPath, 'mac-memgraph-bytes', 'utf8');
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });

  try {
    const snapshot = await captureAppleMemorySnapshot(MACOS_DEVICE, 'com.example.app', outPath);
    assert.equal(snapshot.available, true);
    if (snapshot.available !== true) assert.fail(JSON.stringify(snapshot));
    assert.equal(snapshot.path, outPath);
    assert.equal(snapshot.pid, 111);
    assert.equal(snapshot.sizeBytes, 'mac-memgraph-bytes'.length);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureAppleMemorySnapshot removes partial memgraph when leaks exits nonzero', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-memgraph-fail-'));
  const appPath = path.join(tmpDir, 'Example.app');
  const outPath = path.join(tmpDir, 'app.memgraph');
  await fs.mkdir(appPath, { recursive: true });
  await fs.writeFile(
    path.join(appPath, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>ExampleSimExec</string>',
      '</dict></plist>',
    ].join(''),
    'utf8',
  );

  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd === 'xcrun' && args.includes('get_app_container')) {
      return { stdout: `${appPath}\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') {
      return { stdout: '', stderr: 'mock fallback', exitCode: 1 };
    }
    if (cmd === 'xcrun' && args.includes('ps')) {
      return {
        stdout: `111 1.0 8192 ${path.join(appPath, 'ExampleSimExec')}`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (cmd === 'xcrun' && args.includes('leaks')) {
      await fs.writeFile(outPath, 'partial-memgraph', 'utf8');
      return { stdout: '', stderr: 'permission denied', exitCode: 1 };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });

  try {
    await assert.rejects(
      () => captureAppleMemorySnapshot(IOS_SIMULATOR, 'com.example.sim', outPath),
      /Failed to capture Apple memgraph/,
    );
    assert.equal(await fileExists(outPath), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureAppleMemorySnapshot removes partial memgraph and hints when leaks times out', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-memgraph-timeout-'));
  const appPath = path.join(tmpDir, 'Example.app');
  const outPath = path.join(tmpDir, 'app.memgraph');
  await fs.mkdir(appPath, { recursive: true });
  await fs.writeFile(
    path.join(appPath, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>ExampleSimExec</string>',
      '</dict></plist>',
    ].join(''),
    'utf8',
  );

  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd === 'xcrun' && args.includes('get_app_container')) {
      return { stdout: `${appPath}\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') {
      return { stdout: '', stderr: 'mock fallback', exitCode: 1 };
    }
    if (cmd === 'xcrun' && args.includes('ps')) {
      return {
        stdout: `111 1.0 8192 ${path.join(appPath, 'ExampleSimExec')}`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (cmd === 'xcrun' && args.includes('leaks')) {
      await fs.writeFile(outPath, 'partial-memgraph', 'utf8');
      throw new AppError('COMMAND_FAILED', 'xcrun timed out after 120000ms', {
        cmd,
        args,
        stdout: '',
        stderr: '',
        exitCode: -1,
        timeoutMs: 120_000,
      });
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });

  try {
    await assert.rejects(
      async () => {
        await captureAppleMemorySnapshot(IOS_SIMULATOR, 'com.example.sim', outPath);
      },
      (error) => {
        assert.ok(error instanceof AppError);
        assert.match(String(error.details?.hint), /timed out|longer than metric sampling/i);
        return true;
      },
    );
    assert.equal(await fileExists(outPath), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureAppleMemorySnapshot reports physical iOS as unavailable', async () => {
  const snapshot = await captureAppleMemorySnapshot(
    IOS_DEVICE,
    'com.example.device',
    '/tmp/app.memgraph',
  );

  assert.equal(snapshot.available, false);
  if (snapshot.available !== false) assert.fail(JSON.stringify(snapshot));
  assert.equal(snapshot.kind, 'memgraph');
  assert.match(snapshot.reason, /Physical iOS device memgraph capture/i);
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

test('captureAppleMemorySnapshot reports iOS simulator without process tools as unavailable', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-sim-no-ps-'));
  const appPath = path.join(tmpDir, 'Example.app');
  await fs.mkdir(appPath, { recursive: true });
  await fs.writeFile(
    path.join(appPath, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>ExampleSimExec</string>',
      '</dict></plist>',
    ].join(''),
    'utf8',
  );

  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd === 'xcrun' && args.includes('get_app_container')) {
      return { stdout: `${appPath}\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') {
      return { stdout: '', stderr: 'mock fallback', exitCode: 1 };
    }
    if (cmd === 'xcrun' && args.includes('ps')) {
      throw new AppError(
        'COMMAND_FAILED',
        'The operation couldn’t be completed. No such file or directory',
        {
          cmd,
          args,
          stdout: '',
          stderr: 'An error was encountered processing the command: No such file or directory',
          exitCode: 2,
          processExitError: true,
        },
      );
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });

  try {
    const snapshot = await captureAppleMemorySnapshot(
      IOS_SIMULATOR,
      'com.example.sim',
      path.join(tmpDir, 'app.memgraph'),
    );
    assert.equal(snapshot.available, false);
    if (snapshot.available !== false) assert.fail(JSON.stringify(snapshot));
    assert.match(snapshot.reason, /did not provide ps/i);
    assert.equal(snapshot.support.memgraph, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('sampleApplePerfMetrics falls back to host ps when simulator ps is unavailable', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-sim-perf-'));
  const appPath = path.join(tmpDir, 'Example.app');
  await fs.mkdir(appPath, { recursive: true });
  await fs.writeFile(
    path.join(appPath, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>Example Sim Exec</string>',
      '</dict></plist>',
    ].join(''),
    'utf8',
  );

  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd === 'xcrun' && args.includes('get_app_container')) {
      return { stdout: `${appPath}\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') {
      return { stdout: '', stderr: 'mock fallback', exitCode: 1 };
    }
    if (cmd === 'xcrun' && args.includes('spawn') && args.includes('ps')) {
      return { stdout: '', stderr: 'No such file or directory', exitCode: 2 };
    }
    if (cmd === 'ps') {
      return {
        stdout: [
          `111 12.0 8192 ${path.join(appPath, 'Example Sim Exec')}`,
          '222 4.0 1024 SpringBoard',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });

  try {
    const metrics = await sampleApplePerfMetrics(IOS_SIMULATOR, 'com.example.sim');
    assert.equal(metrics.cpu.usagePercent, 12);
    assert.equal(metrics.memory.residentMemoryKb, 8192);
    assert.deepEqual(metrics.cpu.matchedProcesses, ['Example Sim Exec']);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('sampleApplePerfMetrics uses xctrace Activity Monitor for iOS devices', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-01T10:00:00.000Z'));

  const captures = makeActivityMonitorCaptureXmls();
  mockXcrunCommands([
    mockIosDeviceApps,
    mockIosDeviceProcesses,
    mockXctraceRecord(() => vi.setSystemTime(new Date(Date.now() + 1000))),
    mockSequentialExports(captures),
  ]);

  const metrics = await sampleApplePerfMetrics(IOS_DEVICE, 'com.example.device');
  assert.equal(metrics.cpu.usagePercent, 25);
  assert.equal(metrics.memory.residentMemoryKb, 8192);
  assert.equal(metrics.cpu.method, 'xctrace-activity-monitor');
  assert.deepEqual(metrics.cpu.matchedProcesses, ['ExampleDeviceApp']);
  assert.equal(metrics.cpu.measuredAt, '2026-04-01T10:00:02.000Z');
  assert.equal(metrics.memory.measuredAt, '2026-04-01T10:00:02.000Z');
});

test('sampleAppleFramePerf records Animation Hitches for connected iOS devices', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-01T10:00:00.000Z'));

  mockXcrunCommands([
    mockIosDeviceApps,
    mockIosDeviceProcesses,
    mockAnimationHitchesRecord,
    mockFrameTableExports,
  ]);

  const sample = await sampleAppleFramePerf(IOS_DEVICE, 'com.example.device');
  assert.equal(sample.droppedFramePercent, 50);
  assert.equal(sample.windowStartedAt, '2026-04-01T10:00:00.000Z');
  assert.equal(sample.windowEndedAt, '2026-04-01T10:00:02.000Z');
  assert.equal(sample.method, 'xctrace-animation-hitches');
});

test('sampleAppleFramePerf keeps core metrics when display info export fails', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-01T10:00:00.000Z'));

  mockXcrunCommands([
    mockIosDeviceApps,
    mockIosDeviceProcesses,
    mockAnimationHitchesRecord,
    mockFrameTableExportsWithoutDisplayInfo,
  ]);

  const sample = await sampleAppleFramePerf(IOS_DEVICE, 'com.example.device');
  assert.equal(sample.droppedFramePercent, 50);
  assert.equal(sample.refreshRateHz, undefined);
  assert.equal(sample.frameDeadlineMs, undefined);
});

test('sampleAppleFramePerf retries transient kperf lock failures', async () => {
  mockXcrunCommands([
    mockIosDeviceApps,
    mockIosDeviceProcesses,
    mockKperfLockThenAnimationHitchesRecord(),
    mockFrameTableExports,
  ]);

  const sample = await sampleAppleFramePerf(IOS_DEVICE, 'com.example.device');
  assert.equal(sample.droppedFramePercent, 50);
  assert.ok(sample.sampleWindowMs < 1000);
}, 10_000);

test('startAppleXctracePerfCapture attaches to an active iOS simulator app process', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-xctrace-sim-'));
  const appPath = path.join(tmpDir, 'Example.app');
  const tracePath = path.join(tmpDir, 'app.trace');
  await fs.mkdir(appPath, { recursive: true });
  await fs.writeFile(
    path.join(appPath, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>Example Sim Exec</string>',
      '</dict></plist>',
    ].join(''),
    'utf8',
  );

  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd === 'xcrun' && args.includes('get_app_container')) {
      return { stdout: `${appPath}\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') {
      return { stdout: '', stderr: 'mock fallback', exitCode: 1 };
    }
    if (cmd === 'xcrun' && args.includes('spawn') && args.includes('ps')) {
      return {
        stdout: [
          `111 12.0 8192 ${path.join(appPath, 'Example Sim Exec')}`,
          '222 4.0 1024 SpringBoard',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });

  try {
    const capture = await startAppleXctracePerfCapture({
      device: IOS_SIMULATOR,
      appBundleId: 'com.example.sim',
      mode: 'cpu-profile',
      template: 'Time Profiler',
      outPath: tracePath,
    });

    assert.equal(capture.outPath, tracePath);
    assert.deepEqual(capture.targetPids, [111]);
    assert.deepEqual(capture.targetProcesses, ['Example Sim Exec']);
    assert.deepEqual(mockRunCmdBackground.mock.calls[0]?.[1], [
      'xctrace',
      'record',
      '--template',
      'Time Profiler',
      '--device',
      'sim-1',
      '--attach',
      '111',
      '--output',
      tracePath,
      '--quiet',
      '--no-prompt',
    ]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('startAppleXctracePerfCapture retries transient kperf lock failures', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-xctrace-retry-'));
  const tracePath = path.join(tmpDir, 'app.trace');
  mockXcrunCommands([mockIosDeviceApps, mockIosDeviceProcesses]);
  mockRunCmdBackground
    .mockImplementationOnce(() =>
      mockBackgroundXctrace({
        stdout: '',
        stderr: '_lockKPerf: could not lock kperf. Likely another session just started.',
        exitCode: 2,
      }),
    )
    .mockImplementationOnce(() => mockBackgroundXctrace());

  try {
    const capture = await startAppleXctracePerfCapture({
      device: IOS_DEVICE,
      appBundleId: 'com.example.device',
      mode: 'trace',
      template: 'Animation Hitches',
      outPath: tracePath,
    });

    assert.equal(capture.mode, 'trace');
    assert.equal(mockRunCmdBackground.mock.calls.length, 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}, 10_000);

test('stopAppleXctracePerfCapture returns compact artifact metadata', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-xctrace-stop-'));
  const tracePath = path.join(tmpDir, 'app.trace');
  const child = { kill: vi.fn((_signal?: NodeJS.Signals) => true), pid: 1234 };
  await fs.writeFile(tracePath, 'trace', 'utf8');
  const capture: AppleXctracePerfCapture = {
    kind: 'xctrace',
    mode: 'cpu-profile',
    template: 'Time Profiler',
    outPath: tracePath,
    appBundleId: 'com.example.app',
    deviceId: 'sim-1',
    platform: 'ios',
    targetPids: [111],
    targetProcesses: ['Example'],
    startedAt: '2026-04-01T10:00:00.000Z',
    child: child as unknown as AppleXctracePerfCapture['child'],
    wait: Promise.resolve(emptyRunResult()),
  };

  try {
    const result = await stopAppleXctracePerfCapture(capture);
    assert.equal(child.kill.mock.calls[0]?.[0], 'SIGINT');
    assert.equal(result.outPath, tracePath);
    assert.deepEqual(result.targetPids, [111]);
    assert.equal(result.template, 'Time Profiler');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('stopAppleXctracePerfCapture force-kills xctrace when graceful stop times out', async () => {
  vi.useFakeTimers();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-xctrace-stop-timeout-'));
  const tracePath = path.join(tmpDir, 'app.trace');
  const child = { kill: vi.fn((_signal?: NodeJS.Signals) => true), pid: 1234 };
  const capture: AppleXctracePerfCapture = {
    kind: 'xctrace',
    mode: 'cpu-profile',
    template: 'Time Profiler',
    outPath: tracePath,
    appBundleId: 'com.example.app',
    deviceId: 'sim-1',
    platform: 'ios',
    targetPids: [111],
    targetProcesses: ['Example'],
    startedAt: '2026-04-01T10:00:00.000Z',
    child: child as unknown as AppleXctracePerfCapture['child'],
    wait: new Promise(() => {}),
  };

  try {
    const stopPromise = stopAppleXctracePerfCapture(capture).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(45_000);
    assert.deepEqual(
      child.kill.mock.calls.map((call) => call[0]),
      ['SIGINT', 'SIGKILL'],
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await stopPromise;
    assert.match((error as Error).message, /after SIGKILL/);
  } finally {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('stopAppleXctracePerfCapture reports confirmed cleanup after forced kill exits', async () => {
  vi.useFakeTimers();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-xctrace-force-exit-'));
  const tracePath = path.join(tmpDir, 'app.trace');
  let resolveWait!: (result: MockRunCmdResult) => void;
  const wait = new Promise<MockRunCmdResult>((resolve) => {
    resolveWait = resolve;
  });
  const child = {
    kill: vi.fn((signal?: NodeJS.Signals) => {
      if (signal === 'SIGKILL') {
        resolveWait({ stdout: '', stderr: 'killed', exitCode: 1 });
      }
      return true;
    }),
    pid: 1234,
  };
  const capture: AppleXctracePerfCapture = {
    kind: 'xctrace',
    mode: 'trace',
    template: 'Animation Hitches',
    outPath: tracePath,
    appBundleId: 'com.example.app',
    deviceId: 'sim-1',
    platform: 'ios',
    targetPids: [111],
    targetProcesses: ['Example'],
    startedAt: '2026-04-01T10:00:00.000Z',
    child: child as unknown as AppleXctracePerfCapture['child'],
    wait,
  };

  try {
    const stopPromise = stopAppleXctracePerfCapture(capture).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(45_000);
    const error = (await stopPromise) as { details?: Record<string, unknown> };
    assert.equal(error.details?.captureCleanedUp, true);
    assert.equal(error.details?.forcedKill, true);
  } finally {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('writeAppleXctracePerfReport writes compact trace metadata JSON', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-xctrace-report-'));
  const tracePath = path.join(tmpDir, 'app.trace');
  const reportPath = path.join(tmpDir, 'app-profile.json');
  await fs.writeFile(tracePath, 'trace', 'utf8');
  mockXcrunCommands([
    async (args) => {
      if (args[0] !== 'xctrace' || args[1] !== 'export') return null;
      assert.equal(args[args.indexOf('--input') + 1], tracePath);
      assert.equal(args[args.indexOf('--xpath') + 1], '/trace-toc');
      await fs.writeFile(readOutputPath(args), makeTraceTocXml(), 'utf8');
      return emptyRunResult();
    },
  ]);

  try {
    const report = await writeAppleXctracePerfReport({
      tracePath,
      outPath: reportPath,
      mode: 'cpu-profile',
      template: 'Time Profiler',
      appBundleId: 'com.example.app',
    });
    assert.equal(report.reportPath, reportPath);
    assert.deepEqual(report.summary.tableSchemas, ['cpu-profile', 'time-profile']);
    const written = JSON.parse(await fs.readFile(reportPath, 'utf8')) as typeof report;
    assert.equal(written.tracePath, tracePath);
    assert.deepEqual(written.summary.tableSchemas, ['cpu-profile', 'time-profile']);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

function mockXcrunCommands(handlers: XcrunMockHandler[]): void {
  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd !== 'xcrun') throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    for (const handler of handlers) {
      const result = await handler(args);
      if (result) return result;
    }
    throw new Error(`unexpected xcrun args: ${args.join(' ')}`);
  });
}

async function mockIosDeviceApps(args: string[]): Promise<MockRunCmdResult | null> {
  if (!matchesDevicectlInfo(args, 'apps')) return null;
  await writeJsonOutput(args, {
    result: {
      apps: [
        {
          bundleIdentifier: 'com.example.device',
          name: 'Example Device App',
          url: 'file:///private/var/containers/Bundle/Application/ABC123/ExampleDevice.app/',
        },
      ],
    },
  });
  return emptyRunResult();
}

async function mockIosDeviceProcesses(args: string[]): Promise<MockRunCmdResult | null> {
  if (!matchesDevicectlInfo(args, 'processes')) return null;
  await writeJsonOutput(args, {
    result: {
      runningProcesses: [
        {
          executable:
            'file:///private/var/containers/Bundle/Application/ABC123/ExampleDevice.app/ExampleDeviceApp',
          processIdentifier: 4001,
        },
        {
          executable:
            'file:///private/var/containers/Bundle/Application/ABC123/ExampleDevice.app/ExampleDeviceHelper',
          processIdentifier: 4002,
        },
      ],
    },
  });
  return emptyRunResult();
}

function mockXctraceRecord(onRecord: () => void): XcrunMockHandler {
  return async (args) => {
    if (args[0] !== 'xctrace' || args[1] !== 'record') return null;
    onRecord();
    await fs.writeFile(readOutputPath(args), 'trace', 'utf8');
    return emptyRunResult();
  };
}

async function mockAnimationHitchesRecord(args: string[]): Promise<MockRunCmdResult | null> {
  if (args[0] !== 'xctrace' || args[1] !== 'record') return null;
  assert.deepEqual(args.slice(2, 10), [
    '--template',
    'Animation Hitches',
    '--device',
    'ios-device-1',
    '--attach',
    '4001',
    '--attach',
    '4002',
  ]);
  assert.deepEqual(args.slice(10, 12), ['--time-limit', '2s']);
  vi.setSystemTime(new Date('2026-04-01T10:00:02.000Z'));
  await fs.writeFile(readOutputPath(args), 'trace', 'utf8');
  return emptyRunResult();
}

function mockKperfLockThenAnimationHitchesRecord(): XcrunMockHandler {
  let didFail = false;
  return async (args) => {
    if (args[0] !== 'xctrace' || args[1] !== 'record') return null;
    if (!didFail) {
      didFail = true;
      return {
        stdout: '',
        stderr:
          'Run issues were detected (trace is still ready to be viewed):\n* [Error] Failed to start the recording: _lockKPerf: could not lock kperf. Likely another session just started.',
        exitCode: 2,
      };
    }
    await fs.writeFile(readOutputPath(args), 'trace', 'utf8');
    return emptyRunResult();
  };
}

function mockSequentialExports(xmlPayloads: string[]): XcrunMockHandler {
  let exportCount = 0;
  return async (args) => {
    if (args[0] !== 'xctrace' || args[1] !== 'export') return null;
    await fs.writeFile(readOutputPath(args), xmlPayloads[exportCount++] ?? '', 'utf8');
    return emptyRunResult();
  };
}

async function mockFrameTableExports(args: string[]): Promise<MockRunCmdResult | null> {
  if (args[0] !== 'xctrace' || args[1] !== 'export') return null;
  const xpath = args[args.indexOf('--xpath') + 1] ?? '';
  await fs.writeFile(readOutputPath(args), readFrameTableXml(xpath), 'utf8');
  return emptyRunResult();
}

async function mockFrameTableExportsWithoutDisplayInfo(
  args: string[],
): Promise<MockRunCmdResult | null> {
  if (args[0] !== 'xctrace' || args[1] !== 'export') return null;
  const xpath = args[args.indexOf('--xpath') + 1] ?? '';
  if (xpath.includes('device-display-info')) {
    return { stdout: '', stderr: 'missing display info', exitCode: 1 };
  }
  await fs.writeFile(readOutputPath(args), readFrameTableXml(xpath), 'utf8');
  return emptyRunResult();
}

function readFrameTableXml(xpath: string): string {
  if (xpath.includes('hitches-frame-lifetimes')) return makeAppleFrameLifetimesXml(4);
  if (xpath.includes('device-display-info')) return makeAppleDisplayInfoXml(120);
  return makeAppleHitchesXml();
}

function matchesDevicectlInfo(args: string[], subject: 'apps' | 'processes'): boolean {
  return (
    args[0] === 'devicectl' && args[1] === 'device' && args[2] === 'info' && args[3] === subject
  );
}

async function writeJsonOutput(args: string[], data: unknown): Promise<void> {
  await fs.writeFile(readOutputPath(args, '--json-output'), JSON.stringify(data), 'utf8');
}

function readOutputPath(args: string[], flag = '--output'): string {
  return args[args.indexOf(flag) + 1]!;
}

function emptyRunResult(): MockRunCmdResult {
  return { stdout: '', stderr: '', exitCode: 0 };
}

async function fileExists(filePath: string): Promise<boolean> {
  return await fs
    .stat(filePath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

function mockBackgroundXctrace(result?: MockRunCmdResult): ReturnType<typeof runCmdBackground> {
  const child = {
    kill: vi.fn((_signal?: NodeJS.Signals) => true),
    pid: 1234,
  };
  return {
    child: child as unknown as ReturnType<typeof runCmdBackground>['child'],
    wait: result ? Promise.resolve(result) : new Promise<MockRunCmdResult>(() => {}),
  };
}

function makeTraceTocXml(): string {
  return [
    '<?xml version="1.0"?>',
    '<trace-toc>',
    '<run>',
    '<data>',
    '<table schema="time-profile"/>',
    '<table schema="cpu-profile"/>',
    '<table/>',
    '</data>',
    '</run>',
    '</trace-toc>',
  ].join('');
}

function makeActivityMonitorCaptureXmls(): string[] {
  const firstCaptureXml = makeActivityMonitorCaptureXml();
  const secondCaptureXml = firstCaptureXml
    .replace(
      '<duration-on-core fmt="100.00 ms">100000000</duration-on-core>',
      '<duration-on-core id="cpu-ref" fmt="350.00 ms">350000000</duration-on-core>',
    )
    .replace(
      '<size-in-bytes fmt="8.00 MiB">8388608</size-in-bytes>',
      '<size-in-bytes id="mem-ref" fmt="8.00 MiB">8388608</size-in-bytes>',
    )
    .replace('<pid fmt="4001">4001</pid>', '<pid id="pid-ref" fmt="4001">4001</pid>')
    .replace(
      '<process fmt="ExampleDeviceApp (4001)"><pid fmt="4001">4001</pid></process>',
      '<process id="proc-ref" fmt="ExampleDeviceApp (4001)"><pid fmt="4001">4001</pid></process>',
    )
    .replace('</row><row><start-time fmt="00:00.124">124</start-time>', makeReferenceRow());
  return [firstCaptureXml, secondCaptureXml];
}

function makeActivityMonitorCaptureXml(): string {
  return [
    '<?xml version="1.0"?>',
    '<trace-query-result>',
    '<node xpath="//trace-toc[1]/run[1]/data[1]/table[7]">',
    '<schema name="activity-monitor-process-live">',
    '<col><mnemonic>start</mnemonic></col>',
    '<col><mnemonic>process</mnemonic></col>',
    '<col><mnemonic>cpu-total</mnemonic></col>',
    '<col><mnemonic>memory-real</mnemonic></col>',
    '<col><mnemonic>pid</mnemonic></col>',
    '</schema>',
    makeActivityMonitorRow('ExampleDeviceApp', 4001, 100_000_000, 8_388_608),
    makeActivityMonitorRow('OtherApp', 5001, 75_000_000, 4_194_304),
    '</node>',
    '</trace-query-result>',
  ].join('');
}

function makeActivityMonitorRow(
  processName: string,
  pid: number,
  cpuTimeNs: number,
  memoryBytes: number,
): string {
  return [
    '<row>',
    `<start-time fmt="00:00.123">${pid === 4001 ? 123 : 124}</start-time>`,
    `<process fmt="${processName} (${pid})"><pid fmt="${pid}">${pid}</pid></process>`,
    `<duration-on-core fmt="100.00 ms">${cpuTimeNs}</duration-on-core>`,
    `<size-in-bytes fmt="8.00 MiB">${memoryBytes}</size-in-bytes>`,
    `<pid fmt="${pid}">${pid}</pid>`,
    pid === 4001 ? '<process ref="background-process"/>' : '',
    '</row>',
  ].join('');
}

function makeReferenceRow(): string {
  return [
    '</row>',
    '<row>',
    '<start-time fmt="00:00.123">123</start-time>',
    '<process ref="proc-ref"/>',
    '<duration-on-core ref="cpu-ref"/>',
    '<size-in-bytes ref="mem-ref"/>',
    '<pid ref="pid-ref"/>',
    '<process ref="background-process"/>',
    '</row>',
    '<row>',
    '<start-time fmt="00:00.124">124</start-time>',
  ].join('');
}

function makeAppleHitchesXml(): string {
  return [
    '<?xml version="1.0"?>',
    '<trace-query-result><node>',
    '<schema name="hitches">',
    '<col><mnemonic>start</mnemonic></col>',
    '<col><mnemonic>duration</mnemonic></col>',
    '<col><mnemonic>process</mnemonic></col>',
    '<col><mnemonic>is-system</mnemonic></col>',
    '<col><mnemonic>swap-id</mnemonic></col>',
    '<col><mnemonic>label</mnemonic></col>',
    '<col><mnemonic>display</mnemonic></col>',
    '<col><mnemonic>narrative-description</mnemonic></col>',
    '</schema>',
    '<row>',
    '<start-time id="start-1" fmt="00:00.100">100000000</start-time>',
    '<duration id="duration-1" fmt="16.67 ms">16666583</duration>',
    '<process id="process-1" fmt="ExampleDeviceApp (4001)"><pid id="pid-1" fmt="4001">4001</pid></process>',
    '<boolean id="false" fmt="No">0</boolean>',
    '<uint32>1</uint32><string>0x1</string><display-name>Display 1</display-name><string></string>',
    '</row>',
    '<row>',
    '<start-time fmt="00:00.200">200000000</start-time>',
    '<duration fmt="37.50 ms">37500000</duration>',
    '<process ref="process-1"/>',
    '<boolean ref="false"/>',
    '<uint32>2</uint32><string>0x2</string><display-name>Display 1</display-name><string></string>',
    '</row>',
    '<row>',
    '<start-time fmt="00:00.200">200000000</start-time>',
    '<duration ref="duration-1"/>',
    '<sentinel/>',
    '<boolean fmt="Yes">1</boolean>',
    '<uint32>2</uint32><string>0x2</string><display-name>Display 1</display-name><string></string>',
    '</row>',
    '<row>',
    '<start-time fmt="00:00.300">300000000</start-time>',
    '<duration fmt="16.67 ms">16666583</duration>',
    '<process fmt="OtherApp (5001)"><pid fmt="5001">5001</pid></process>',
    '<boolean ref="false"/>',
    '<uint32>3</uint32><string>0x3</string><display-name>Display 1</display-name><string></string>',
    '</row>',
    '</node></trace-query-result>',
  ].join('');
}

function makeAppleFrameLifetimesXml(count: number): string {
  return [
    '<?xml version="1.0"?>',
    '<trace-query-result><node>',
    '<schema name="hitches-frame-lifetimes">',
    '<col><mnemonic>start</mnemonic></col>',
    '<col><mnemonic>duration</mnemonic></col>',
    '</schema>',
    ...Array.from(
      { length: count },
      (_, index) =>
        `<row><start-time>${index * 16_000_000}</start-time><duration>16000000</duration></row>`,
    ),
    '</node></trace-query-result>',
  ].join('');
}

function makeAppleDisplayInfoXml(refreshRateHz: number): string {
  return [
    '<?xml version="1.0"?>',
    '<trace-query-result><node>',
    '<schema name="device-display-info">',
    '<col><mnemonic>timestamp</mnemonic></col>',
    '<col><mnemonic>accelerator-id</mnemonic></col>',
    '<col><mnemonic>display-id</mnemonic></col>',
    '<col><mnemonic>device-name</mnemonic></col>',
    '<col><mnemonic>framebuffer-index</mnemonic></col>',
    '<col><mnemonic>resolution</mnemonic></col>',
    '<col><mnemonic>built-in</mnemonic></col>',
    '<col><mnemonic>max-refresh-rate</mnemonic></col>',
    '<col><mnemonic>is-main-display</mnemonic></col>',
    '</schema>',
    `<row><event-time>0</event-time><uint64>1</uint64><uint64>1</uint64><string>Display</string><uint32>0</uint32><string>390 844</string><boolean>1</boolean><uint32>${refreshRateHz}</uint32><boolean>1</boolean></row>`,
    '</node></trace-query-result>',
  ].join('');
}
