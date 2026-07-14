import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn() };
});
vi.mock('../adb.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adb.ts')>();
  return { ...actual, sleep: vi.fn() };
});

import { screenshotAndroid } from '../screenshot.ts';
import { snapshotAndroid } from '../snapshot.ts';
import { buildUiHierarchySnapshot, parseUiHierarchyTree } from '../ui-hierarchy.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { flushDiagnosticsToSessionFile, withDiagnosticsScope } from '../../../utils/diagnostics.ts';
import { AppError } from '../../../kernel/errors.ts';
import { runCmd } from '../../../utils/exec.ts';
import { sleep } from '../adb.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session.ts';
import { type AndroidAdbExecutor } from '../snapshot-helper.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../__tests__/test-utils/index.ts';
import {
  withAndroidAdbProvider,
  type AndroidAdbProcess,
  type AndroidAdbProvider,
} from '../adb-executor.ts';

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+b9xkAAAAASUVORK5CYII=',
  'base64',
);
const mockRunCmd = vi.mocked(runCmd);
const mockSleep = vi.mocked(sleep);

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

const helperArtifact = ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT;
const installedHelperProbe = {
  exitCode: 0,
  stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
  stderr: '',
};

function snapshotAndroidWithHelper(
  helperAdb: AndroidAdbExecutor,
  options: Omit<
    NonNullable<Parameters<typeof snapshotAndroid>[1]>,
    'helperAdb' | 'helperArtifact'
  > = {},
) {
  return snapshotAndroid(device, {
    ...options,
    helperAdb,
    helperArtifact,
  });
}

function createHelperAdb(
  handlers: Partial<Record<'instrument' | 'activity', AndroidAdbExecutor>>,
): AndroidAdbExecutor {
  return async (args, options) => {
    if (isHelperVersionProbe(args)) return installedHelperProbe;
    if (isHelperRuntimeReset(args)) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    const operation = helperAdbOperation(args);
    const handler = operation ? handlers[operation] : undefined;
    if (handler) return await handler(args, options);
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };
}

function isHelperVersionProbe(args: string[]): boolean {
  return args.includes('--show-versioncode');
}

function isHelperRuntimeReset(args: string[]): boolean {
  return args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop';
}

function helperAdbOperation(args: string[]): 'instrument' | 'activity' | undefined {
  if (args.includes('instrument')) return 'instrument';
  return args.includes('dumpsys') && args.includes('activity') ? 'activity' : undefined;
}

function createPersistentSnapshotHelperProvider(options: {
  calls: string[][];
  spawnArgs: string[][];
  killedProcesses: FakeAndroidProcess[];
}): AndroidAdbProvider {
  return {
    exec: async (args) => {
      options.calls.push(args);
      if (args.includes('--show-versioncode')) return installedHelperProbe;
      if (args[0] === 'forward') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected persistent helper adb args: ${args.join(' ')}`);
    },
    spawn: (args) => {
      options.spawnArgs.push(args);
      const process = new FakeAndroidProcess();
      const port = readSessionPort(args);
      let snapshotCount = 0;
      const server = net.createServer((socket) => {
        socket.once('data', (chunk) => {
          const command = chunk.toString('utf8').trim();
          const [, requestId = ''] = command.split(/\s+/, 2);
          if (command.startsWith('quit')) {
            socket.end(sessionResponse({ requestId, body: '' }));
            return;
          }
          snapshotCount += 1;
          const body = `<hierarchy><node text="persistent helper snapshot ${snapshotCount}" bounds="[0,0][10,10]" /></hierarchy>`;
          socket.end(
            sessionResponse({
              requestId,
              body,
              metadata: {
                waitForIdleTimeoutMs: '500',
                waitForIdleQuietMs: '100',
                timeoutMs: '5000',
                maxDepth: '128',
                maxNodes: '5000',
                rootPresent: 'true',
                captureMode: 'interactive-windows',
                windowCount: '1',
                nodeCount: '1',
                truncated: 'false',
                elapsedMs: '8',
              },
            }),
          );
        });
      });
      server.listen(port, '127.0.0.1', () => {
        process.stdout.write(
          [
            'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
            'INSTRUMENTATION_STATUS: sessionReady=true',
            'INSTRUMENTATION_STATUS_CODE: 2',
            '',
          ].join('\n'),
        );
      });
      process.onKill = () => {
        options.killedProcesses.push(process);
        server.close(() => process.emitExit(0, null));
      };
      return process;
    },
  };
}

function sessionResponse(params: {
  requestId: string;
  body: string;
  metadata?: Record<string, string>;
}): string {
  const headers = {
    agentDeviceProtocol: 'android-snapshot-helper-v1',
    helperApiVersion: '1',
    outputFormat: 'uiautomator-xml',
    requestId: params.requestId,
    ok: 'true',
    byteLength: String(Buffer.byteLength(params.body, 'utf8')),
    ...params.metadata,
  };
  return `${Object.entries(headers)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n\n${params.body}`;
}

function readSessionPort(args: string[]): number {
  const index = args.indexOf('sessionPort');
  assert.notEqual(index, -1);
  return Number(args[index + 1]);
}

class FakeAndroidProcess extends EventEmitter implements AndroidAdbProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  onKill: (() => void) | undefined;

  kill(): boolean {
    if (this.killed) return true;
    this.killed = true;
    this.onKill?.();
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

beforeEach(async () => {
  await resetAndroidSnapshotHelperSessions();
  resetAndroidSnapshotHelperInstallCache();
  mockRunCmd.mockReset();
  mockSleep.mockReset();
  mockSleep.mockResolvedValue(undefined);
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('exec-out')) {
      return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: VALID_PNG };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
});

afterEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

test('screenshotAndroid waits for transient UI to settle before capture', async () => {
  const events: string[] = [];
  const outPath = path.join(os.tmpdir(), `agent-device-android-screenshot-${Date.now()}.png`);

  mockScreenshotEvents(events);

  await screenshotAndroid(device, outPath);

  const relevantEvents = events.filter((event, index) => {
    if (event !== 'enable') {
      return true;
    }
    return index === 0;
  });
  assert.deepEqual(relevantEvents, ['enable', 'settle:1000', 'capture', 'disable']);
});

test('screenshotAndroid skips stabilization when requested', async () => {
  const events: string[] = [];
  const outPath = path.join(os.tmpdir(), `agent-device-android-screenshot-${Date.now()}.png`);

  mockScreenshotEvents(events);

  await screenshotAndroid(device, outPath, { stabilize: false });

  assert.deepEqual(events, ['capture']);
  assert.equal(mockSleep.mock.calls.length, 0);
});

test('screenshotAndroid writes a valid PNG when output is clean', async () => {
  await withTempScreenshot('screenshot-clean-', async (outPath) => {
    await screenshotAndroid(device, outPath);
    const written = await fs.readFile(outPath);
    assert.deepEqual(written, VALID_PNG);
  });
});

test('screenshotAndroid strips warning text before PNG signature', async () => {
  const warning =
    '[Warning] Multiple displays were found, but no display id was specified! Defaulting to the first display found.';
  mockScreenshotPayload(Buffer.concat([Buffer.from(warning), VALID_PNG]));

  await withTempScreenshot('screenshot-warning-', async (outPath) => {
    await screenshotAndroid(device, outPath);
    const written = await fs.readFile(outPath);
    assert.deepEqual(written, VALID_PNG);
  });
});

test('screenshotAndroid strips trailing garbage after PNG payload', async () => {
  mockScreenshotPayload(Buffer.concat([VALID_PNG, Buffer.from('\ntrailing-warning\n')]));

  await withTempScreenshot('screenshot-trailing-', async (outPath) => {
    await screenshotAndroid(device, outPath);
    const written = await fs.readFile(outPath);
    assert.deepEqual(written, VALID_PNG);
  });
});

test('screenshotAndroid throws when output contains no PNG signature', async () => {
  mockScreenshotPayload(Buffer.from('not a png'));

  await withTempScreenshot('screenshot-nopng-', async (outPath) => {
    await assert.rejects(() => screenshotAndroid(device, outPath), {
      message: 'Screenshot data does not contain a valid PNG header',
    });
  });
});

test('screenshotAndroid throws when PNG payload is truncated', async () => {
  mockScreenshotPayload(VALID_PNG.subarray(0, VALID_PNG.length - 3));

  await withTempScreenshot('screenshot-truncated-', async (outPath) => {
    await assert.rejects(() => screenshotAndroid(device, outPath), {
      message: 'Screenshot data does not contain a complete PNG payload',
    });
  });
});

function helperOutput(
  xml: string,
  options: { truncated?: boolean; nodeCount?: number; windowCount?: number } = {},
): string {
  const truncated = options.truncated ?? false;
  const nodeCount = options.nodeCount ?? 1;
  const windowCount = options.windowCount ?? 1;
  return [
    'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_STATUS: helperApiVersion=1',
    'INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml',
    'INSTRUMENTATION_STATUS: chunkIndex=0',
    'INSTRUMENTATION_STATUS: chunkCount=1',
    `INSTRUMENTATION_STATUS: payloadBase64=${Buffer.from(xml, 'utf8').toString('base64')}`,
    'INSTRUMENTATION_STATUS_CODE: 1',
    'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_RESULT: helperApiVersion=1',
    'INSTRUMENTATION_RESULT: ok=true',
    'INSTRUMENTATION_RESULT: outputFormat=uiautomator-xml',
    'INSTRUMENTATION_RESULT: waitForIdleTimeoutMs=0',
    'INSTRUMENTATION_RESULT: timeoutMs=8000',
    'INSTRUMENTATION_RESULT: maxDepth=128',
    'INSTRUMENTATION_RESULT: maxNodes=5000',
    'INSTRUMENTATION_RESULT: rootPresent=true',
    'INSTRUMENTATION_RESULT: captureMode=interactive-windows',
    `INSTRUMENTATION_RESULT: windowCount=${windowCount}`,
    `INSTRUMENTATION_RESULT: nodeCount=${nodeCount}`,
    `INSTRUMENTATION_RESULT: truncated=${truncated}`,
    'INSTRUMENTATION_RESULT: elapsedMs=12',
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');
}

function androidSystemWindowOnlyXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<hierarchy rotation="0">',
    '  <node window-index="0" window-type="3" window-layer="30" window-active="true" window-focused="true" class="android.widget.FrameLayout" package="com.android.systemui" bounds="[0,0][390,844]" enabled="true" visible-to-user="true">',
    '    <node content-desc="Back" class="android.widget.ImageButton" package="com.android.systemui" bounds="[0,792][96,844]" clickable="true" enabled="true" focusable="true" visible-to-user="true" />',
    '    <node content-desc="Home" class="android.widget.ImageButton" package="com.android.systemui" bounds="[147,792][243,844]" clickable="true" enabled="true" focusable="true" visible-to-user="true" />',
    '  </node>',
    '</hierarchy>',
  ].join('\n');
}

function androidContentPoorFabricAppWindowXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<hierarchy rotation="0">',
    '  <node window-index="0" window-type="1" window-layer="10" window-active="true" window-focused="true" class="android.widget.FrameLayout" package="io.example.fabric" bounds="[0,0][390,844]" enabled="true" visible-to-user="true">',
    '    <node index="0" class="androidx.compose.ui.platform.ComposeView" package="io.example.fabric" bounds="[0,0][390,844]" enabled="true" visible-to-user="true" />',
    '  </node>',
    '  <node window-index="1" window-type="3" window-layer="30" window-active="false" window-focused="false" class="android.widget.FrameLayout" package="com.android.systemui" bounds="[0,0][390,24]" enabled="true" visible-to-user="true">',
    '    <node content-desc="Battery" class="android.widget.ImageView" package="com.android.systemui" bounds="[340,4][370,20]" enabled="true" visible-to-user="true" />',
    '  </node>',
    '</hierarchy>',
  ].join('\n');
}

function androidContentPoorExpoToolsOverlayXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<hierarchy rotation="0">',
    '  <node index="0" class="android.widget.FrameLayout" package="com.android.systemui" bounds="[0,0][390,24]" enabled="true" visible-to-user="true">',
    '    <node text="7:52" resource-id="com.android.systemui:id/clock" class="android.widget.TextView" package="com.android.systemui" bounds="[12,4][54,20]" enabled="true" visible-to-user="true" />',
    '    <node content-desc="Battery 100 percent." resource-id="com.android.systemui:id/battery" class="android.widget.LinearLayout" package="com.android.systemui" bounds="[340,4][380,20]" enabled="true" visible-to-user="true" />',
    '  </node>',
    '  <node index="1" class="android.widget.FrameLayout" package="host.exp.exponent" bounds="[0,0][390,844]" enabled="true" visible-to-user="true">',
    '    <node index="0" class="androidx.compose.ui.platform.ComposeView" package="host.exp.exponent" bounds="[0,0][390,844]" enabled="true" visible-to-user="true" />',
    '    <node index="1" text="Agent Device Tester" class="android.widget.TextView" package="host.exp.exponent" bounds="[0,0][0,0]" enabled="true" visible-to-user="false" />',
    '    <node index="1" text="Tools" class="android.widget.ImageView" package="host.exp.exponent" bounds="[20,760][64,804]" enabled="true" visible-to-user="true" />',
    '  </node>',
    '</hierarchy>',
  ].join('\n');
}

function mockScreenshotEvents(events: string[]): void {
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('exec-out')) {
      events.push('capture');
      return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: VALID_PNG };
    }
    events.push(args.some((arg) => arg.includes('exit')) ? 'disable' : 'enable');
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  mockSleep.mockImplementation(async (ms) => {
    events.push(`settle:${ms}`);
  });
}

function mockScreenshotPayload(payload: Buffer): void {
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('exec-out')) {
      return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: payload };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

async function withTempScreenshot(
  name: string,
  callback: (outPath: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), name));
  try {
    await callback(path.join(tmpDir, 'out.png'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function androidSnapshotHelperAdb(xml: string, activityDump?: string): AndroidAdbExecutor {
  return createHelperAdb({
    instrument: async () => ({ exitCode: 0, stdout: helperOutput(xml), stderr: '' }),
    ...(activityDump === undefined
      ? {}
      : { activity: async () => ({ exitCode: 0, stdout: activityDump, stderr: '' }) }),
  });
}

function isAndroidSdkVersionCommand(args: string[]): boolean {
  return (
    args.includes('shell') && args.includes('getprop') && args.includes('ro.build.version.sdk')
  );
}

async function captureDiagnostics(
  scope: Parameters<typeof withDiagnosticsScope>[0],
  callback: () => Promise<string | null>,
): Promise<string> {
  const previousHome = process.env.HOME;
  process.env.HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-android-diag-'));
  try {
    const diagnosticsPath = await withDiagnosticsScope(scope, callback);
    assert.ok(diagnosticsPath);
    return await fs.readFile(diagnosticsPath, 'utf8');
  } finally {
    process.env.HOME = previousHome;
  }
}

test('snapshotAndroid uses the injected helper artifact', async () => {
  const timeouts: Array<number | undefined> = [];
  const helperAdb: AndroidAdbExecutor = async (args, options) => {
    timeouts.push(options?.timeoutMs);
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
        stderr: '',
      };
    }
    if (args.includes('instrument')) {
      return {
        exitCode: 0,
        stdout: helperOutput('<hierarchy><node text="helper" bounds="[0,0][10,10]" /></hierarchy>'),
        stderr: '',
      };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };

  const result = await snapshotAndroid(device, {
    helperAdb,
    helperArtifact,
  });

  assert.equal(result.nodes[0]?.label, 'helper');
  assert.equal(result.androidSnapshot.backend, 'android-helper');
  assert.equal(result.androidSnapshot.helperVersion, '0.13.3');
  assert.equal(result.androidSnapshot.installReason, 'current');
  assert.equal(result.androidSnapshot.captureMode, 'interactive-windows');
  assert.equal(result.androidSnapshot.windowCount, 1);
  assert.deepEqual(timeouts, [5000, 30000]);
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

test('snapshotAndroid reports helper-side truncation on the public snapshot result', async () => {
  const helperAdb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) return installedHelperProbe;
    if (args.includes('instrument')) {
      return {
        exitCode: 0,
        stdout: helperOutput(
          '<hierarchy><node text="helper" bounds="[0,0][10,10]" /></hierarchy>',
          {
            truncated: true,
            nodeCount: 5000,
          },
        ),
        stderr: '',
      };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };

  const result = await snapshotAndroid(device, {
    helperAdb,
    helperArtifact,
  });

  assert.equal(result.truncated, true);
  assert.equal(result.androidSnapshot.helperTruncated, true);
});

test('snapshotAndroid forwards alert-style helper idle timeout override', async () => {
  let instrumentArgs: string[] | undefined;
  const helperAdb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return installedHelperProbe;
    }
    if (args.includes('instrument')) {
      instrumentArgs = args;
      return {
        exitCode: 0,
        stdout: helperOutput('<hierarchy><node text="helper" bounds="[0,0][10,10]" /></hierarchy>'),
        stderr: '',
      };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };

  await snapshotAndroid(device, {
    helperAdb,
    helperArtifact,
    helperWaitForIdleTimeoutMs: 0,
  });

  assert.ok(instrumentArgs);
  assert.equal(instrumentArgs[instrumentArgs.indexOf('waitForIdleTimeoutMs') + 1], '0');
  assert.equal(instrumentArgs.includes('outputPath'), false);
  assert.equal(instrumentArgs.includes('emitChunks'), false);
});

test('snapshotAndroid emits helper phase diagnostics', async () => {
  const helperAdb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
        stderr: '',
      };
    }
    if (args.includes('instrument')) {
      return {
        exitCode: 0,
        stdout: helperOutput(
          '<hierarchy><node text="diagnostic-helper" bounds="[0,0][10,10]" /></hierarchy>',
        ),
        stderr: '',
      };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };

  const diagnostics = await captureDiagnostics(
    { session: 'snapshot-helper', requestId: 'req-1', command: 'snapshot', debug: true },
    async () => {
      await snapshotAndroid(device, {
        helperAdb,
        helperArtifact,
      });
      return flushDiagnosticsToSessionFile({ force: true });
    },
  );

  assert.match(diagnostics, /android_snapshot_helper_artifact_resolution/);
  assert.match(diagnostics, /android_snapshot_helper_install/);
  assert.match(diagnostics, /android_snapshot_helper_install_decision/);
  assert.match(diagnostics, /android_snapshot_helper_capture/);
});

test('snapshotAndroid resolves helper adb through scoped provider', async () => {
  const adbCalls: string[][] = [];
  const provider: AndroidAdbProvider = {
    snapshotHelperArtifact: helperArtifact,
    exec: async (args) => {
      adbCalls.push(args);
      if (args.includes('--show-versioncode')) {
        return {
          exitCode: 0,
          stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
          stderr: '',
        };
      }
      if (isAndroidSdkVersionCommand(args)) {
        return { exitCode: 0, stdout: '35', stderr: '' };
      }
      if (args.includes('instrument')) {
        return {
          exitCode: 0,
          stdout: helperOutput(
            '<hierarchy><node text="provider-helper" bounds="[0,0][10,10]" /></hierarchy>',
          ),
          stderr: '',
        };
      }
      if (args[0] === 'shell' && args[1] === 'rm') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected scoped helper adb args: ${args.join(' ')}`);
    },
  };

  const result = await withAndroidAdbProvider(provider, { serial: device.id }, async () =>
    snapshotAndroid(device),
  );

  assert.equal(result.nodes[0]?.label, 'provider-helper');
  assert.equal(result.androidSnapshot.backend, 'android-helper');
  assert.equal(result.androidSnapshot.helperVersion, helperArtifact.manifest.version);
  assert.deepEqual(
    adbCalls.map((args) => args[0]),
    ['shell', 'shell'],
  );
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

test('snapshotAndroid stops command-scoped persistent helper session after capture', async () => {
  const adbCalls: string[][] = [];
  const spawnArgs: string[][] = [];
  const killedProcesses: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs,
    killedProcesses,
  });

  const result = await snapshotAndroid(device, {
    helperAdb: provider,
    helperArtifact,
  });

  assert.equal(result.nodes[0]?.label, 'persistent helper snapshot 1');
  assert.equal(result.androidSnapshot.helperTransport, 'persistent-session');
  assert.equal(result.androidSnapshot.helperSessionReused, false);
  assert.equal(spawnArgs.length, 1);
  assert.equal(killedProcesses.length, 1);
  assert.equal(
    adbCalls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

test('snapshotAndroid keeps daemon-session helper alive for reuse until session cleanup', async () => {
  const adbCalls: string[][] = [];
  const spawnArgs: string[][] = [];
  const killedProcesses: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs,
    killedProcesses,
  });

  const first = await snapshotAndroid(device, {
    helperAdb: provider,
    helperArtifact,
    helperSessionScope: 'daemon-session',
  });
  const second = await snapshotAndroid(device, {
    helperAdb: provider,
    helperArtifact,
    helperSessionScope: 'daemon-session',
  });

  assert.equal(first.androidSnapshot.helperSessionReused, false);
  assert.equal(second.androidSnapshot.helperSessionReused, true);
  assert.equal(second.nodes[0]?.label, 'persistent helper snapshot 2');
  assert.equal(spawnArgs.length, 1);
  assert.equal(killedProcesses.length, 0);
  assert.equal(
    adbCalls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    false,
  );

  await resetAndroidSnapshotHelperSessions();

  assert.equal(killedProcesses.length, 1);
  assert.equal(
    adbCalls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

test('snapshotAndroid fails closed when the helper fails', async () => {
  const adbCalls: string[][] = [];
  const helperAdb: AndroidAdbExecutor = async (args) => {
    adbCalls.push(args);
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
        stderr: '',
      };
    }
    if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 1, stdout: '', stderr: 'instrumentation failed' };
  };

  await assert.rejects(
    () => snapshotAndroid(device, { helperAdb, helperArtifact }),
    /Android snapshot helper failed.*failed before returning parseable output/,
  );
  assert.equal(
    adbCalls.some((args) => args.includes('exec-out')),
    false,
  );
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

test('snapshotAndroid fails closed when helper returns only system windows', async () => {
  const adbCalls: string[][] = [];
  const helperXml = androidSystemWindowOnlyXml();
  const helperAdb: AndroidAdbExecutor = async (args) => {
    adbCalls.push(args);
    if (args.includes('--show-versioncode')) return installedHelperProbe;
    if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args.includes('instrument')) {
      return { exitCode: 0, stdout: helperOutput(helperXml, { nodeCount: 3 }), stderr: '' };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    /Android snapshot helper returned only non-application windows/,
  );
  assert.equal(
    adbCalls.some(
      (args) => args.join(' ') === 'shell am force-stop com.callstack.agentdevice.snapshothelper',
    ),
    true,
  );
  assert.equal(
    adbCalls.some((args) => args.includes('exec-out')),
    false,
  );
});

test('snapshotAndroid fails closed when helper returns no nodes', async () => {
  const helperXml = '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"></hierarchy>';
  const helperAdb = createHelperAdb({
    instrument: async () => ({
      exitCode: 0,
      stdout: helperOutput(helperXml, { nodeCount: 0 }),
      stderr: '',
    }),
  });

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    /Android snapshot helper returned no accessibility nodes/,
  );
});

test('snapshotAndroid fails closed when foreground app window lacks content', async () => {
  const helperXml = androidContentPoorFabricAppWindowXml();
  const helperAdb = createHelperAdb({
    instrument: async () => ({
      exitCode: 0,
      stdout: helperOutput(helperXml, { nodeCount: 4, windowCount: 2 }),
      stderr: '',
    }),
  });

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb, { appBundleId: 'io.example.fabric' }),
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.match(error.message, /insufficient foreground app content/);
      assert.equal(error.details?.retriable, true);
      return true;
    },
  );
});

test('snapshotAndroid fails closed when standalone helper sees only an app overlay', async () => {
  const helperXml = androidContentPoorExpoToolsOverlayXml();
  const helperAdb = createHelperAdb({
    instrument: async () => ({
      exitCode: 0,
      stdout: helperOutput(helperXml, { nodeCount: 4, windowCount: 2 }),
      stderr: '',
    }),
  });

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    /Android snapshot helper returned insufficient application window content/,
  );
});

test('snapshotAndroid keeps helper output when application and system windows are both present', async () => {
  const helperXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<hierarchy rotation="0">',
    '  <node window-index="0" window-type="1" window-layer="10" window-active="true" window-focused="true" class="android.widget.FrameLayout" package="io.example.fabric" bounds="[0,0][390,844]" enabled="true" visible-to-user="true">',
    '    <node text="Fabric dashboard" class="android.widget.TextView" package="io.example.fabric" bounds="[24,96][260,140]" enabled="true" visible-to-user="true" />',
    '    <node text="Open details" class="android.widget.Button" package="io.example.fabric" bounds="[24,180][220,236]" clickable="true" enabled="true" focusable="true" visible-to-user="true" />',
    '  </node>',
    '  <node window-index="1" window-type="3" window-layer="20" window-active="false" window-focused="false" class="android.widget.FrameLayout" package="com.android.systemui" bounds="[0,0][390,24]" enabled="true" visible-to-user="true">',
    '    <node content-desc="Battery" class="android.widget.ImageView" package="com.android.systemui" bounds="[340,4][370,20]" enabled="true" visible-to-user="true" />',
    '  </node>',
    '</hierarchy>',
  ].join('\n');
  const helperAdb = createHelperAdb({
    instrument: async () => ({
      exitCode: 0,
      stdout: helperOutput(helperXml, { nodeCount: 4 }),
      stderr: '',
    }),
  });

  const result = await snapshotAndroidWithHelper(helperAdb, {
    appBundleId: 'io.example.fabric',
  });

  assert.equal(result.androidSnapshot.backend, 'android-helper');
  assert.equal(
    result.nodes.some((node) => node.label === 'Fabric dashboard'),
    true,
  );
});

test('snapshotAndroid emits helper failure diagnostics', async () => {
  const helperAdb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
        stderr: '',
      };
    }
    if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop')
      return { exitCode: 0, stdout: '', stderr: '' };
    return { exitCode: 1, stdout: '', stderr: 'helper unavailable' };
  };

  const diagnostics = await captureDiagnostics(
    { session: 'snapshot-failure', requestId: 'req-2', command: 'snapshot', debug: true },
    async () => {
      await assert.rejects(() => snapshotAndroid(device, { helperAdb, helperArtifact }));
      return flushDiagnosticsToSessionFile({ force: true });
    },
  );

  assert.match(diagnostics, /android_snapshot_helper_failed/);
  assert.match(diagnostics, /helper unavailable/);
});

test('snapshotAndroid emits unavailable diagnostics when helper artifact is missing', async () => {
  const accessSpy = vi.spyOn(fs, 'access').mockRejectedValueOnce(new Error('helper missing'));

  try {
    const diagnostics = await captureDiagnostics(
      {
        session: 'snapshot-helper-missing',
        requestId: 'req-missing',
        command: 'snapshot',
        debug: true,
      },
      async () => {
        await assert.rejects(
          () => snapshotAndroid(device),
          /Android snapshot helper is unavailable/,
        );
        return flushDiagnosticsToSessionFile({ force: true });
      },
    );

    assert.match(diagnostics, /android_snapshot_helper_artifact_resolution/);
    assert.match(diagnostics, /android_snapshot_helper_unavailable/);
    assert.match(diagnostics, /artifact_not_found/);
  } finally {
    accessSpy.mockRestore();
  }
});

test('snapshotAndroid emits timeout diagnostics when helper capture times out', async () => {
  const helperAdb = createHelperAdb({
    instrument: async () => {
      throw new AppError('COMMAND_FAILED', 'helper capture timed out');
    },
  });

  const diagnostics = await captureDiagnostics(
    {
      session: 'snapshot-helper-timeout',
      requestId: 'req-timeout',
      command: 'snapshot',
      debug: true,
    },
    async () => {
      await assert.rejects(
        () => snapshotAndroidWithHelper(helperAdb),
        /Android snapshot helper failed: helper capture timed out/,
      );
      return flushDiagnosticsToSessionFile({ force: true });
    },
  );

  assert.match(diagnostics, /android_snapshot_helper_failed/);
  assert.match(diagnostics, /helper capture timed out/);
});

test('snapshotAndroid preserves structured helper timeout guidance', async () => {
  const helperAdb = createHelperAdb({
    instrument: async () => ({
      exitCode: 1,
      stdout: [
        'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
        'INSTRUMENTATION_RESULT: helperApiVersion=1',
        'INSTRUMENTATION_RESULT: ok=false',
        'INSTRUMENTATION_RESULT: outputFormat=uiautomator-xml',
        'INSTRUMENTATION_RESULT: errorType=java.util.concurrent.TimeoutException',
        'INSTRUMENTATION_RESULT: message=Timed out waiting for accessibility root',
        'INSTRUMENTATION_CODE: 1',
      ].join('\n'),
      stderr: '',
    }),
  });

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    (error) => {
      assert.match((error as Error).message, /Timed out waiting for accessibility root/);
      assert.match((error as Error).message, /Android snapshot helper failed/);
      assert.equal(
        (error as { details?: Record<string, unknown> }).details?.hint,
        'Android accessibility snapshots can be blocked by busy or continuously changing app UI. Use screenshot as visual truth after this timeout and report the busy UI if it persists.',
      );
      return true;
    },
  );
});

test('snapshotAndroid preserves killed helper instrumentation details', async () => {
  const helperAdb = createHelperAdb({
    instrument: async () => ({ exitCode: 137, stdout: '', stderr: '' }),
  });

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    (error) => {
      assert.match(
        (error as Error).message,
        /Android snapshot helper failed before returning parseable output/,
      );
      assert.match((error as Error).message, /Android snapshot helper failed/);
      assert.equal((error as { details?: Record<string, unknown> }).details?.exitCode, 137);
      return true;
    },
  );
});

test('snapshotAndroid fails closed after unparseable helper output', async () => {
  const calls: string[][] = [];
  const helperAdb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args.includes('--show-versioncode')) return installedHelperProbe;
    if (args.includes('instrument')) return { exitCode: 0, stdout: '', stderr: '' };
    if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    /Android snapshot helper failed.*output could not be parsed/,
  );
  assert.equal(
    calls.some((args) => args.includes('instrument')),
    true,
  );
  assert.equal(
    calls.some(
      (args) => args.join(' ') === 'shell am force-stop com.callstack.agentdevice.snapshothelper',
    ),
    true,
  );
  assert.equal(
    calls.some((args) => args.includes('exec-out')),
    false,
  );
  assert.equal(mockSleep.mock.calls.at(-1)?.[0], 150);
});

test('snapshotAndroid fails closed after helper adb timeout', async () => {
  const helperAdb = createHelperAdb({
    instrument: async (args) => {
      throw new AppError('COMMAND_FAILED', 'adb timed out after 8000ms', {
        args,
        timeoutMs: 8000,
      });
    },
  });

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /Android snapshot helper failed: adb timed out after 8000ms/);
      assert.equal(error.details?.androidSnapshotHelperFailureReason, 'adb timed out after 8000ms');
      return true;
    },
  );
});

test('snapshotAndroid re-probes helper install after helper capture failure', async () => {
  let versionProbeCount = 0;
  let instrumentAttempts = 0;
  const helperAdb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      versionProbeCount += 1;
      return {
        exitCode: 0,
        stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
        stderr: '',
      };
    }
    if (args.includes('instrument')) {
      instrumentAttempts += 1;
      if (instrumentAttempts === 1) {
        return { exitCode: 1, stdout: '', stderr: 'instrumentation failed' };
      }
      return {
        exitCode: 0,
        stdout: helperOutput('<hierarchy><node text="helper" bounds="[0,0][10,10]" /></hierarchy>'),
        stderr: '',
      };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };
  const helperOptions = {
    helperAdb,
    helperArtifact,
  };

  await assert.rejects(() => snapshotAndroid(device, helperOptions));
  const helper = await snapshotAndroid(device, helperOptions);

  assert.equal(helper.androidSnapshot.backend, 'android-helper');
  assert.equal(helper.nodes[0]?.label, 'helper');
  assert.equal(versionProbeCount, 2);
});

test('snapshotAndroid preserves hidden scroll content hints in interactive snapshots', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" content-desc="Messages" bounds="[0,100][390,600]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,600]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="Earlier message" bounds="[0,100][390,268]" clickable="true" focusable="true" />
        <node class="android.widget.Button" text="Visible message" bounds="[0,268][390,436]" clickable="true" focusable="true" />
        <node class="android.widget.Button" text="Later message" bounds="[0,436][390,604]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;
  const dump = [
    '    com.facebook.react.views.scroll.ReactScrollView{d32a800 VFED.V... ........ 0,0-390,500 #4b2}',
    '      com.facebook.react.views.view.ReactViewGroup{77d31ae V.E...... ........ 0,0-390,1000 #4b0}',
    '        com.facebook.react.views.view.ReactViewGroup{a V.E...... ........ 0,300-390,468 #1}',
    '        com.facebook.react.views.view.ReactViewGroup{b V.E...... ........ 0,468-390,636 #2}',
    '        com.facebook.react.views.view.ReactViewGroup{c V.E...... ........ 0,636-390,804 #3}',
  ].join('\n');

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml, dump), {
    interactiveOnly: true,
  });
  const scrollArea = result.nodes.find((node) => node.type === 'android.widget.ScrollView');

  assert.ok(scrollArea);
  assert.equal(scrollArea?.hiddenContentAbove, true);
  assert.equal(scrollArea?.hiddenContentBelow, true);
});

test('snapshotAndroid keeps generic-id scroll containers in interactive snapshots', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" resource-id="com.android.settings:id/main_content_scrollable_container" bounds="[0,100][390,600]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,600]" clickable="false" focusable="false">
        <node class="android.widget.TextView" text="Network &amp; internet" bounds="[20,140][240,180]" clickable="false" focusable="false" />
        <node class="android.widget.Button" text="Apps" bounds="[20,240][200,288]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml, ''), {
    interactiveOnly: true,
  });
  const scrollArea = result.nodes.find(
    (node) =>
      node.type === 'android.widget.ScrollView' &&
      node.identifier === 'com.android.settings:id/main_content_scrollable_container',
  );

  assert.ok(scrollArea);
});

test('snapshotAndroid skips activity dump when snapshot has no scrollable nodes', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.Button" text="Continue" bounds="[20,120][200,180]" clickable="true" focusable="true" />
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml), {
    interactiveOnly: true,
  });

  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]?.label, 'Continue');
});

test('snapshotAndroid skips hidden content hints when disabled', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" bounds="[0,100][390,600]" clickable="false" focusable="false">
      <node class="android.widget.Button" text="Continue" bounds="[20,120][200,180]" clickable="true" focusable="true" />
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml), {
    includeHiddenContentHints: false,
  });

  assert.equal(
    result.nodes.some((node) => node.type === 'android.widget.ScrollView'),
    true,
  );
});

test('snapshotAndroid uses helper scroll action hints without activity dump', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" scrollable="true" can-scroll-forward="true" can-scroll-backward="false" bounds="[0,100][390,600]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,600]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="Continue" bounds="[20,120][200,180]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml));
  const scrollArea = result.nodes.find((node) => node.type === 'android.widget.ScrollView');

  assert.ok(scrollArea);
  assert.equal(scrollArea.hiddenContentBelow, true);
  assert.equal(scrollArea.hiddenContentAbove, undefined);
});

test('snapshotAndroid does not convert horizontal helper scroll action to vertical hints', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.HorizontalScrollView" scrollable="true" can-scroll-forward="true" can-scroll-backward="false" bounds="[0,100][390,220]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][800,220]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="First" bounds="[20,120][200,180]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml));
  const scrollArea = result.nodes.find(
    (node) => node.type === 'android.widget.HorizontalScrollView',
  );

  assert.ok(scrollArea);
  assert.equal(scrollArea.hiddenContentBelow, undefined);
  assert.equal(scrollArea.hiddenContentAbove, undefined);
});

test('snapshotAndroid derives hidden content hints for interactive snapshots from shared visibility semantics', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" content-desc="Messages" bounds="[0,100][390,500]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,500]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="Visible message" bounds="[0,120][390,180]" clickable="true" focusable="true" />
        <node class="android.widget.TextView" text="Offscreen message" bounds="[0,560][390,620]" clickable="false" focusable="false" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml), {
    interactiveOnly: true,
  });
  const scrollArea = result.nodes.find((node) => node.type === 'android.widget.ScrollView');

  assert.ok(scrollArea);
  assert.equal(
    result.nodes.some((node) => node.type === 'android.view.ViewGroup'),
    false,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Offscreen message'),
    false,
  );
  assert.equal(scrollArea?.hiddenContentAbove, undefined);
  assert.equal(scrollArea?.hiddenContentBelow, true);
});

test('snapshotAndroid omits zero-area interactive nodes from interactive snapshots', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" scrollable="true" can-scroll-forward="true" can-scroll-backward="false" bounds="[0,100][390,600]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,600]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="Visible action" bounds="[20,120][200,180]" clickable="true" focusable="true" />
        <node class="android.widget.Button" text="Collapsed action" bounds="[20,844][200,844]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml), {
    interactiveOnly: true,
  });

  assert.equal(
    result.nodes.some((node) => node.label === 'Visible action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Collapsed action'),
    false,
  );
  assert.equal(
    result.nodes.some(
      (node) => node.rect !== undefined && (node.rect.width <= 0 || node.rect.height <= 0),
    ),
    false,
  );
});

test('snapshotAndroid preserves bottomed-out hidden-above hints in interactive snapshots from a single aligned block', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" content-desc="Messages" bounds="[0,100][390,600]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,600]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="Last message" bounds="[0,432][390,600]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;
  const dump = [
    '    com.facebook.react.views.scroll.ReactScrollView{d32a800 VFED.V... ........ 0,0-390,500 #4b2}',
    '      com.facebook.react.views.view.ReactViewGroup{77d31ae V.E...... ........ 0,0-390,804 #4b0}',
    '        com.facebook.react.views.view.ReactViewGroup{c V.E...... ........ 0,636-390,804 #3}',
  ].join('\n');

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml, dump), {
    interactiveOnly: true,
  });
  const scrollArea = result.nodes.find(
    (node) => node.hiddenContentAbove === true || node.hiddenContentBelow === true,
  );

  assert.ok(scrollArea);
  assert.equal(scrollArea?.hiddenContentAbove, true);
  assert.equal(scrollArea?.hiddenContentBelow, undefined);
});

test('buildUiHierarchySnapshot preserves hidden content hints from Android tree nodes', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" content-desc="Messages" bounds="[0,100][390,500]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,500]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="Visible message" bounds="[0,120][390,180]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const tree = parseUiHierarchyTree(xml);
  const scrollNode = tree.children[0]?.children[0];
  assert.ok(scrollNode);
  scrollNode.hiddenContentAbove = true;
  scrollNode.hiddenContentBelow = true;

  const result = buildUiHierarchySnapshot(tree, 800, { interactiveOnly: true });
  const scrollArea = result.nodes.find((node) => node.label === 'Messages');

  assert.ok(scrollArea);
  assert.equal(result.sourceNodes[result.nodes.indexOf(scrollArea)], scrollNode);
  assert.equal(scrollArea.hiddenContentAbove, true);
  assert.equal(scrollArea.hiddenContentBelow, true);
});
