import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});
vi.mock('../adb.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adb.ts')>();
  return { ...actual, sleep: vi.fn() };
});

import { mkdtempForTest } from './test-utils/android-host-test-setup.ts';
import { screenshotAndroid } from '../screenshot.ts';
import { snapshotAndroid } from '../snapshot.ts';
import { readAndroidGestureViewport } from '../touch-executor.ts';

import * as diagnosticsModule from '@agent-device/host-kit/diagnostics';
import { AppError } from '@agent-device/kernel/errors';

import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { type AndroidAdbExecutor } from '../snapshot-helper.ts';

import {
  androidHelperInstrumentationOutput as helperOutput,
  createPersistentSnapshotHelperProvider,
  isAndroidHelperRuntimeForceStop as isHelperRuntimeReset,
  ANDROID_HELPER_INSTALLED_VERSION_PROBE as installedHelperProbe,
  androidSystemWindowOnlyXml,
  type FakeAndroidProcess,
} from './snapshot-helper-session.fixtures.ts';
import { withAndroidAdbProvider, type AndroidAdbProvider } from '../adb-executor.ts';

import {
  VALID_PNG,
  mockRunCmd,
  mockSleep,
  device,
  helperArtifact,
  snapshotAndroidWithHelper,
  createHelperAdb,
  isAndroidSdkVersionCommand,
  captureDiagnostics,
  resetSnapshotTestState,
} from './test-utils/android-snapshot-test-world.ts';

beforeEach(resetSnapshotTestState);

afterEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

test('screenshotAndroid waits for transient UI when stabilization is requested', async () => {
  const events: string[] = [];
  await withTempScreenshot('screenshot-settle-', async (outPath) => {
    mockScreenshotEvents(events);
    await screenshotAndroid(device, outPath, { stabilize: true });

    // Demo mode is one setting and two broadcasts, all before the settle.
    assert.deepEqual(events, [
      'read',
      'enable',
      'enable',
      'enable',
      'settle:1000',
      'capture',
      'disable',
      'restore',
    ]);
  });
});

test('screenshotAndroid skips stabilization when requested', async () => {
  const events: string[] = [];
  await withTempScreenshot('screenshot-stabilize-', async (outPath) => {
    mockScreenshotEvents(events);
    await screenshotAndroid(device, outPath, { stabilize: false });

    assert.deepEqual(events, ['capture']);
    assert.equal(mockSleep.mock.calls.length, 0);
  });
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
    if (args.includes('list') && args.includes('settings')) events.push('read');
    else if (args.includes('delete') && args.includes('settings')) events.push('restore');
    else if (!args.includes('dumpsys')) events.push(args.includes('exit') ? 'disable' : 'enable');
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
  const tmpDir = await mkdtempForTest(name);
  try {
    await callback(path.join(tmpDir, 'out.png'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
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

test('snapshotAndroid discloses unavailable sibling order for API 23 helper trees', async () => {
  const captured: string[] = [];
  const helperAdb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) return installedHelperProbe;
    if (args.includes('instrument')) {
      const xml = captured.shift();
      if (!xml) throw new Error('unexpected extra capture');
      return { exitCode: 0, stdout: helperOutput(xml), stderr: '' };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };
  const button = (drawingOrder: string) =>
    `<node class="android.widget.Button" text="Go" bounds="[0,0][100,40]" clickable="true" visible-to-user="true"${drawingOrder} />`;

  captured.push(`<hierarchy>${button('')}</hierarchy>`);
  const api23 = await snapshotAndroid(device, { helperAdb, helperArtifact });
  assert.equal(api23.androidSnapshot.occlusionScanUnavailable, true);

  captured.push(`<hierarchy>${button(' drawing-order="1"')}</hierarchy>`);
  const api24 = await snapshotAndroid(device, { helperAdb, helperArtifact });
  assert.equal(api24.androidSnapshot.occlusionScanUnavailable, undefined);
  assert.equal('occlusionScanUnavailable' in api24.androidSnapshot, false);
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
      return diagnosticsModule.flushDiagnosticsToSessionFile({ force: true })?.path ?? null;
    },
  );

  assert.match(diagnostics, /android_snapshot_helper_artifact_resolution/);
  assert.match(diagnostics, /android_snapshot_helper_install/);
  assert.match(diagnostics, /android_snapshot_helper_install_decision/);
  assert.match(diagnostics, /android_snapshot_helper_capture/);
});

test('snapshotAndroid resolves helper adb through scoped provider', async () => {
  const adbCalls: (readonly string[])[] = [];
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
  const adbCalls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs,
    processes,
  });

  const result = await snapshotAndroid(device, {
    helperAdb: provider,
    helperArtifact,
  });

  assert.equal(result.nodes[0]?.label, 'persistent helper snapshot 1');
  assert.equal(result.androidSnapshot.helperTransport, 'persistent-session');
  assert.equal(result.androidSnapshot.helperSessionReused, false);
  assert.equal(spawnArgs.length, 1);
  assert.equal(processes[0]?.exitCode, 0);
  assert.equal(processes[0]?.killed, false);
  assert.equal(
    adbCalls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

test('snapshotAndroid keeps daemon-session helper alive for reuse until session cleanup', async () => {
  const adbCalls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs,
    processes,
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
  assert.equal(processes[0]?.exitCode, null);
  assert.equal(processes[0]?.killed, false);
  assert.equal(
    adbCalls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    false,
  );

  await resetAndroidSnapshotHelperSessions();

  assert.equal(processes[0]?.exitCode, 0);
  assert.equal(processes[0]?.killed, false);
  assert.equal(
    adbCalls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

test('a daemon-session viewport read warms the session the next snapshot reuses', async () => {
  // The gesture viewport and snapshot capture are different helper commands on the same device.
  // They may only share the live session if both derive the same session identity, which is why
  // their capture options have one construction path.
  const adbCalls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs,
    processes,
  });

  const snapshot = await withAndroidAdbProvider(
    { ...provider, snapshotHelperArtifact: helperArtifact },
    { serial: device.id },
    async () => {
      await readAndroidGestureViewport(device, { helperSessionScope: 'daemon-session' });
      return await snapshotAndroid(device, { helperSessionScope: 'daemon-session' });
    },
  );

  assert.equal(snapshot.androidSnapshot.helperTransport, 'persistent-session');
  // `helperSessionReused` reports repeat CAPTURES, and this is the session's first one: the
  // instrumentation count below is what proves the viewport read left the session warm.
  assert.equal(snapshot.androidSnapshot.helperSessionReused, false);
  assert.equal(spawnArgs.length, 1, 'the viewport read started the only instrumentation');
  assert.equal(
    adbCalls.some((args) => args.includes('instrument')),
    false,
    'neither command fell back to one-shot instrumentation',
  );
});

test('snapshotAndroid retires content-invalid daemon helper before the next request', async () => {
  const adbCalls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs,
    processes,
    sessionXml: (sessionIndex) =>
      sessionIndex === 1
        ? androidSystemWindowOnlyXml()
        : '<hierarchy><node text="fresh helper" bounds="[0,0][10,10]" /></hierarchy>',
  });
  const options = {
    helperAdb: provider,
    helperArtifact,
    helperSessionScope: 'daemon-session' as const,
  };

  await assert.rejects(
    snapshotAndroid(device, options),
    /Android snapshot helper returned only non-application windows/,
  );
  assert.equal(processes[0]?.exitCode, 0, 'content-invalid helper must be retired before reject');

  const next = await snapshotAndroid(device, options);

  assert.equal(next.nodes[0]?.label, 'fresh helper');
  assert.equal(next.androidSnapshot.helperSessionReused, false);
  assert.equal(spawnArgs.length, 2);
  assert.equal(
    adbCalls.filter((args) => args[0] === 'forward' && args[1] === '--remove').length,
    1,
  );
});

test('content-invalid daemon helper retirement force-stops the helper runtime', async () => {
  // Retirement after a content failure is a recovery path, not a release: the helper answered with
  // output we could not trust, so the next capture must meet a runtime that was reset. A clean quit
  // is evidence the helper let go of UiAutomation, never evidence that it was healthy.
  const adbCalls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs,
    processes,
    sessionXml: () => androidSystemWindowOnlyXml(),
  });

  await assert.rejects(
    snapshotAndroid(device, {
      helperAdb: provider,
      helperArtifact,
      helperSessionScope: 'daemon-session',
    }),
    /Android snapshot helper returned only non-application windows/,
  );

  assert.equal(processes[0]?.exitCode, 0, 'the session quit cleanly');
  assert.equal(adbCalls.some(isHelperRuntimeReset), true);
});

test('snapshotAndroid falls back to one-shot capture after retiring a failed session', async () => {
  const adbCalls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs,
    processes,
    sessionResponseMode: 'malformed',
    oneShotXml: '<hierarchy><node text="one-shot fallback" bounds="[0,0][10,10]" /></hierarchy>',
  });

  const result = await snapshotAndroid(device, {
    helperAdb: provider,
    helperArtifact,
    helperSessionScope: 'daemon-session',
  });

  assert.equal(result.nodes[0]?.label, 'one-shot fallback');
  assert.equal(result.androidSnapshot.helperTransport, 'instrumentation');
  assert.equal(processes[0]?.killed, true);
  assert.equal(
    adbCalls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

test('snapshotAndroid answers from one-shot capture when the session stop could not run', async () => {
  const adbCalls: (readonly string[])[] = [];
  const oneShotAttempts: (readonly string[])[] = [];
  // The stop call failing says the transport is unhealthy, not that UiAutomation is still held.
  // ADR 0002 keeps the one-shot transport as the fallback for a session failure either way.
  const provider = createPersistentSnapshotHelperProvider({
    calls: adbCalls,
    spawnArgs: [],
    processes: [],
    sessionResponseMode: 'malformed',
    runtimeStopFailure: true,
    oneShotAttempts,
    oneShotXml: '<hierarchy><node text="one-shot fallback" bounds="[0,0][10,10]" /></hierarchy>',
  });

  const result = await snapshotAndroid(device, {
    helperAdb: provider,
    helperArtifact,
    helperSessionScope: 'daemon-session',
  });

  assert.equal(result.nodes[0]?.label, 'one-shot fallback');
  assert.equal(oneShotAttempts.length, 1);
});

test('snapshotAndroid fails closed when the helper fails', async () => {
  const adbCalls: (readonly string[])[] = [];
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
  const adbCalls: (readonly string[])[] = [];
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

test('snapshotAndroid re-captures past a transient system-window-only sample', async () => {
  const instrumentCalls: (readonly string[])[] = [];
  const helperAdb = createHelperAdb({
    instrument: async (args) => {
      instrumentCalls.push(args);
      // First sample lands mid-transition with no application window; the screen
      // settles by the next one.
      if (instrumentCalls.length === 1) {
        return {
          exitCode: 0,
          stdout: helperOutput(androidSystemWindowOnlyXml(), { nodeCount: 3 }),
          stderr: '',
        };
      }
      return {
        exitCode: 0,
        stdout: helperOutput('<hierarchy><node text="helper" bounds="[0,0][10,10]" /></hierarchy>'),
        stderr: '',
      };
    },
  });

  const snapshot = await snapshotAndroidWithHelper(helperAdb);

  assert.equal(instrumentCalls.length, 2);
  assert.equal(snapshot.nodes.length > 0, true);
});

test('snapshotAndroid still fails closed when every re-capture stays unreadable', async () => {
  const instrumentCalls: (readonly string[])[] = [];
  const helperAdb = createHelperAdb({
    instrument: async (args) => {
      instrumentCalls.push(args);
      return {
        exitCode: 0,
        stdout: helperOutput(androidSystemWindowOnlyXml(), { nodeCount: 3 }),
        stderr: '',
      };
    },
  });

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    /Android snapshot helper returned only non-application windows/,
  );
  assert.equal(instrumentCalls.length, 3);
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

test('snapshotAndroid returns an occluding system surface and stamps systemSurfaceOnly', async () => {
  // Notification shade / quick settings own the whole screen: no application window, but the
  // active system surface carries real content. The capture is returned faithfully and the
  // public metadata carries the occlusion flag that downstream disclosure warnings key off.
  const helperXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<hierarchy rotation="0">',
    '  <node window-index="0" window-type="3" window-layer="30" window-active="true" window-focused="true" class="android.widget.FrameLayout" package="com.android.systemui" bounds="[0,0][390,844]" enabled="true" visible-to-user="true">',
    '    <node text="Wed, Jul 16" class="android.widget.TextView" package="com.android.systemui" bounds="[24,40][200,80]" enabled="true" visible-to-user="true" />',
    '    <node text="Internet" resource-id="com.android.systemui:id/qs_tile_internet" class="android.widget.Switch" package="com.android.systemui" bounds="[24,120][180,200]" clickable="true" enabled="true" visible-to-user="true" />',
    '    <node text="Manage" resource-id="com.android.systemui:id/manage_settings" class="android.widget.Button" package="com.android.systemui" bounds="[24,700][180,760]" clickable="true" enabled="true" visible-to-user="true" />',
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
    appBundleId: 'com.android.settings',
  });

  assert.equal(result.androidSnapshot.backend, 'android-helper');
  assert.equal(result.androidSnapshot.systemSurfaceOnly, true);
  assert.equal(
    result.nodes.some((node) => node.label === 'Internet'),
    true,
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

  const { backend, foregroundWindowPackage } = result.androidSnapshot;
  assert.deepEqual([backend, foregroundWindowPackage], ['android-helper', 'io.example.fabric']);
  assert.ok(result.nodes.some((node) => node.label === 'Fabric dashboard'));
});
