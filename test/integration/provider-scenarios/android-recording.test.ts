import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { withMockedAdb } from '../../../src/__tests__/test-utils/mocked-binaries.ts';
import type { AndroidAdbProvider } from '../../../src/platforms/android/adb-executor.ts';
import {
  assertCommandCall,
  assertRecordingStarted,
  assertRecordingStopped,
  assertRpcOk,
} from './assertions.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import {
  restoreEnv,
  createProviderScenarioHarness,
  likelyPlayableMp4Container,
  withProviderScenarioTempDir,
} from './harness.ts';

type ProviderScenarioDaemon = Awaited<ReturnType<typeof createProviderScenarioHarness>>;
type PullCall = { remotePath: string; localPath: string };

test('Provider-backed integration Android recording flow uses scripted ADB provider pull capability', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-',
    runAndroidRecordingFlowScenario,
  );
});

test('Provider-backed integration Android record stop recovers missing daemon recording state', async () => {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-record-recovery-',
    runAndroidRecordingRecoveryScenario,
  );
});

test('Provider-backed integration Android record start without a session scopes default-device providers', async () => {
  await withMockedAdb(
    'agent-device-provider-scenario-android-sessionless-record-',
    runAndroidSessionlessRecordingWithMockedAdb,
  );
});

async function runAndroidRecordingFlowScenario(tmpDir: string): Promise<void> {
  const context = await createAndroidRecordingFlowContext(tmpDir);
  await withAndroidProviderScenarioEnv(tmpDir, async () => {
    try {
      await exerciseAndroidRecordingFlow(context);
      assertAndroidRecordingFlow(context);
    } finally {
      await context.daemon.close();
    }
  });
}

async function createAndroidRecordingFlowContext(tmpDir: string): Promise<{
  recordingPath: string;
  adbCalls: string[][];
  pullCalls: PullCall[];
  daemon: ProviderScenarioDaemon;
}> {
  const recordingPath = path.join(tmpDir, 'recording.mp4');
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => createPullingAndroidProvider({ adbCalls, pullCalls }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });
  return { recordingPath, adbCalls, pullCalls, daemon };
}

async function exerciseAndroidRecordingFlow(context: {
  recordingPath: string;
  daemon: ProviderScenarioDaemon;
}): Promise<void> {
  const open = await context.daemon.callCommand('open', ['settings'], {
    platform: 'android',
    serial: PROVIDER_SCENARIO_ANDROID.id,
  });
  assertRpcOk(open);

  const recordStart = await context.daemon.callCommand('record', ['start', context.recordingPath], {
    hideTouches: true,
    screenshotMaxSize: 1344,
    quality: 'high',
  });
  assertRecordingStarted(recordStart, { showTouches: false });

  const recordStop = await context.daemon.callCommand('record', ['stop']);
  assertRecordingStopped(recordStop, context.recordingPath, { showTouches: false });
}

function assertAndroidRecordingFlow(context: {
  recordingPath: string;
  adbCalls: string[][];
  pullCalls: PullCall[];
}): void {
  const { recordingPath, adbCalls, pullCalls } = context;
  assert.equal(fs.existsSync(recordingPath), true);
  assertCommandCall(adbCalls, ['shell', 'wm', 'size']);
  assert.ok(adbCalls.some((args) => isAndroidHighQualityScreenrecordStartCommand(args.join(' '))));
  assertCommandCall(adbCalls, ['shell', 'kill', '-2', '4321']);
  assert.equal(pullCalls.length, 1);
  assert.match(pullCalls[0]?.remotePath ?? '', /^\/sdcard\/agent-device-recording-\d+\.mp4$/);
  assert.equal(pullCalls[0]?.localPath, recordingPath);
  assert.ok(adbCalls.some((args) => args[0] === 'shell' && args[1] === 'rm'));
  assert.equal(
    adbCalls.some((args) => args[0] === 'pull'),
    false,
  );
}

async function runAndroidRecordingRecoveryScenario(tmpDir: string): Promise<void> {
  const context = await createAndroidRecordingRecoveryContext();
  await withAndroidProviderScenarioEnv(tmpDir, async () => {
    try {
      const outPath = await exerciseAndroidRecordingRecoveryStop(context, tmpDir);
      assertAndroidRecordingRecovery(context, outPath);
    } finally {
      await context.daemon.close();
    }
  });
}

async function createAndroidRecordingRecoveryContext(): Promise<{
  remotePath: string;
  adbCalls: string[][];
  pullCalls: PullCall[];
  daemon: ProviderScenarioDaemon;
}> {
  const remotePath = '/sdcard/agent-device-recording-123456789.mp4';
  const adbCalls: string[][] = [];
  const pullCalls: PullCall[] = [];
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () =>
      createPullingAndroidProvider({
        adbCalls,
        pullCalls,
        exec: (args) => androidRecoveryAdbResult(args, remotePath),
      }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });
  return { remotePath, adbCalls, pullCalls, daemon };
}

async function exerciseAndroidRecordingRecoveryStop(
  context: { daemon: ProviderScenarioDaemon },
  tmpDir: string,
): Promise<string> {
  const recordStop = await context.daemon.callCommand(
    'record',
    ['stop'],
    {
      platform: 'android',
      serial: PROVIDER_SCENARIO_ANDROID.id,
    },
    { meta: { cwd: tmpDir } },
  );
  const data = assertRpcOk<{ recording?: unknown; outPath?: unknown; warning?: unknown }>(
    recordStop,
  );
  assert.equal(data.recording, 'stopped');
  assert.match(String(data.warning), /Recovered Android recording/);
  return requireStringOutPath(data.outPath);
}

function assertAndroidRecordingRecovery(
  context: { remotePath: string; adbCalls: string[][]; pullCalls: PullCall[] },
  outPath: string,
): void {
  const { remotePath, adbCalls, pullCalls } = context;
  assert.match(outPath, /\/recording-\d+\.mp4$/);
  assert.equal(fs.existsSync(outPath), true);
  assertCommandCall(adbCalls, ['shell', 'ps', '-A', '-o', 'pid=,args=']);
  assertCommandCall(adbCalls, ['shell', 'kill', '-2', '4321']);
  assert.equal(pullCalls.length, 1);
  assert.deepEqual(pullCalls[0], { remotePath, localPath: outPath });
  assertCommandCall(adbCalls, ['shell', 'rm', '-f', remotePath]);
}

async function runAndroidSessionlessRecordingWithMockedAdb(logPath: string): Promise<void> {
  await withProviderScenarioTempDir(
    'agent-device-provider-scenario-android-sessionless-record-',
    async (tmpDir) => await runAndroidSessionlessRecordingScenario(tmpDir, logPath),
  );
}

async function runAndroidSessionlessRecordingScenario(
  tmpDir: string,
  logPath: string,
): Promise<void> {
  const recordingPath = path.join(tmpDir, 'sessionless-recording.mp4');
  const adbCalls: string[][] = [];
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => createRecordingOnlyAndroidProvider(adbCalls),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const recordStart = await daemon.callCommand('record', ['start', recordingPath]);
    assertRecordingStarted(recordStart, { showTouches: true });
    assertAndroidSessionlessRecording(adbCalls, logPath);
  } finally {
    await daemon.close();
  }
}

function assertAndroidSessionlessRecording(adbCalls: string[][], logPath: string): void {
  assert.ok(
    adbCalls.some((args) => isAndroidDefaultScreenrecordStartCommand(args.join(' '))),
    JSON.stringify(adbCalls),
  );
  assert.equal(
    adbCalls.some((args) => args.join(' ') === 'shell wm size'),
    false,
  );
  assert.deepEqual(readLoggedArgs(logPath), []);
}

async function withAndroidProviderScenarioEnv(
  tmpDir: string,
  runScenario: () => Promise<void>,
): Promise<void> {
  const previousPath = process.env.PATH;
  const previousSwiftCacheDir = process.env.AGENT_DEVICE_SWIFT_CACHE_DIR;
  process.env.PATH = tmpDir;
  process.env.AGENT_DEVICE_SWIFT_CACHE_DIR = path.join(tmpDir, 'swift-cache');
  try {
    await runScenario();
  } finally {
    restoreEnv('PATH', previousPath);
    restoreEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', previousSwiftCacheDir);
  }
}

function createPullingAndroidProvider(params: {
  adbCalls: string[][];
  pullCalls: PullCall[];
  exec?: (args: string[]) => ReturnType<typeof androidAdbResult>;
}): AndroidAdbProvider {
  const { adbCalls, pullCalls, exec = androidAdbResult } = params;
  return {
    exec: async (args) => {
      adbCalls.push([...args]);
      return exec(args);
    },
    pull: async (remotePath, localPath) => {
      pullCalls.push({ remotePath, localPath });
      fs.writeFileSync(localPath, likelyPlayableMp4Container());
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

function createRecordingOnlyAndroidProvider(adbCalls: string[][]): AndroidAdbProvider {
  return {
    exec: async (args) => {
      adbCalls.push([...args]);
      return androidAdbResult(args);
    },
  };
}

function androidRecoveryAdbResult(
  args: string[],
  remotePath: string,
): ReturnType<typeof androidAdbResult> {
  if (args.join(' ') === 'shell ps -A -o pid=,args=') {
    return {
      stdout: `4321 screenrecord --bit-rate 8000000 ${remotePath}\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  return androidAdbResult(args);
}

function requireStringOutPath(value: unknown): string {
  assert.equal(typeof value, 'string');
  if (typeof value !== 'string') {
    throw new Error(`expected string outPath, got ${String(value)}`);
  }
  return value;
}

function androidAdbResult(args: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutBuffer?: Buffer;
} {
  const command = args.join(' ');
  if (command === 'shell getprop sys.boot_completed') {
    return { stdout: '1\n', stderr: '', exitCode: 0 };
  }
  if (command === 'shell wm size') {
    return {
      stdout: 'Physical size: 1440x2560\nOverride size: 1080x1920\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (
    /^shell screenrecord --size 756x1344 --bit-rate 20000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
      command,
    )
  ) {
    return { stdout: '4321\n', stderr: '', exitCode: 0 };
  }
  if (isAndroidScreenrecordStartCommand(command)) {
    return { stdout: '4321\n', stderr: '', exitCode: 0 };
  }
  if (/^shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)) {
    return { stdout: '2048\n', stderr: '', exitCode: 0 };
  }
  if (command === 'shell ps -o pid= -p 4321') {
    return { stdout: '', stderr: '', exitCode: 1 };
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

function isAndroidScreenrecordStartCommand(command: string): boolean {
  return /^shell screenrecord (?:--size 756x1344 )?--bit-rate (?:8000000|20000000) \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
    command,
  );
}

function isAndroidHighQualityScreenrecordStartCommand(command: string): boolean {
  return /^shell screenrecord --size 756x1344 --bit-rate 20000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
    command,
  );
}

function isAndroidDefaultScreenrecordStartCommand(command: string): boolean {
  return /^shell screenrecord --bit-rate 8000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
    command,
  );
}

function readLoggedArgs(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
