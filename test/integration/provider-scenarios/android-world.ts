import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  AndroidAdbProcess,
  AndroidAdbProvider,
} from '../../../src/platforms/android/adb-executor.ts';
import type { DeviceInventoryRequest } from '../../../src/core/dispatch-resolve.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../src/__tests__/test-utils/index.ts';
import { runCmd } from '../../../src/utils/exec.ts';
import { validPng } from './assertions.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import {
  createProviderScenarioHarness,
  restoreEnv,
  type ProviderScenarioHarness,
} from './harness.ts';

type AndroidSettingsWorld = {
  daemon: ProviderScenarioHarness;
  adbCalls: string[][];
  textInjectionCalls: Array<{
    action: 'type' | 'fill';
    text: string;
    delayMs?: number;
    target?: { x: number; y: number };
  }>;
  touchInjectionCalls: NonNullable<AndroidAdbProvider['touch']> extends (
    request: infer TRequest,
  ) => unknown
    ? TRequest[]
    : never;
  gestureViewportCalls: number;
  inventoryRequests: DeviceInventoryRequest[];
  apkInstallCalls: Array<{ apkPath: string; replace?: boolean }>;
  bundleInstallCalls: Array<{ bundlePath: string; mode: string }>;
  spawnedLogcat: AndroidAdbProcess[];
  tempRoot: string;
  apkPath: string;
  aabPath: string;
  manifestApkPath: string;
  selection: { platform: 'android'; serial: string };
  assertNoHostAdbCalls: () => void;
  close: () => Promise<void>;
};

export async function createAndroidSettingsWorld(options?: {
  nativeTextInjection?: boolean;
  snapshotXml?: () => string;
  dumpsysWindow?: () => string;
  onAdbExec?: (args: string[]) => void;
}): Promise<AndroidSettingsWorld> {
  const hostAdbGuard = installFakeHostAdbGuard();
  const adbCalls: string[][] = [];
  const textInjectionCalls: AndroidSettingsWorld['textInjectionCalls'] = [];
  const touchInjectionCalls: AndroidSettingsWorld['touchInjectionCalls'] = [];
  let gestureViewportCalls = 0;
  const inventoryRequests: DeviceInventoryRequest[] = [];
  const apkInstallCalls: Array<{ apkPath: string; replace?: boolean }> = [];
  const bundleInstallCalls: Array<{ bundlePath: string; mode: string }> = [];
  const shellState = createAndroidProviderShellState();
  const appState = createAndroidProviderAppState();
  const spawnedLogcat: AndroidAdbProcess[] = [];
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-provider-scenario-android-deploy-'),
  );
  const apkPath = path.join(tempRoot, 'Demo.apk');
  const aabPath = path.join(tempRoot, 'Demo.aab');
  const previousAppEventTemplate = process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE;
  process.env.AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE =
    'demo://agent-device/event?name={event}&payload={payload}&platform={platform}';
  fs.writeFileSync(apkPath, 'placeholder apk');
  fs.writeFileSync(aabPath, 'placeholder aab');
  const manifestApkPath = await createAndroidManifestApk(tempRoot, {
    fileName: 'ManifestDemo.apk',
    packageName: 'io.example.demo_manifest',
  });
  const adbProvider: AndroidAdbProvider = {
    snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    gestureViewport: async () => {
      gestureViewportCalls += 1;
      return { x: 0, y: 0, width: 390, height: 600 };
    },
    exec: async (args) => {
      adbCalls.push([...args]);
      options?.onAdbExec?.([...args]);
      updateAndroidProviderShellState(args, shellState);
      const stateResult = updateAndroidProviderAppState(args, appState);
      if (stateResult) return stateResult;
      const heapResult = androidHeapDumpAdbResult(args);
      if (heapResult) return heapResult;
      return androidAdbResult(args, shellState.searchText, shellState.clipboardText, {
        snapshotXml: options?.snapshotXml,
        dumpsysWindow:
          options?.dumpsysWindow ?? (() => androidForegroundWindowDump(appState.foreground)),
        pidof: (packageName) => androidPidofResult(appState, packageName),
      });
    },
    touch: async (request) => {
      touchInjectionCalls.push({ ...request });
      return { backend: 'provider-native-touch' };
    },
    install: async (apk, options) => {
      apkInstallCalls.push({ apkPath: apk, replace: options?.replace });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    installBundle: async (bundlePath, bundleOptions) => {
      bundleInstallCalls.push({ bundlePath, mode: bundleOptions.mode });
    },
    spawn: (args) => {
      const child = makeMockAdbProcess();
      spawnedLogcat.push(child);
      queueMicrotask(() => {
        if (args.includes('logcat')) {
          child.stdout?.push(`I/AgentDevice(4242): ${args.join(' ')}\n`);
          child.stdout?.push(
            [
              '04-01 10:00:15.000 D/Network(4242):',
              JSON.stringify({
                method: 'POST',
                url: 'https://api.example.com/v1/login',
                status: 401,
                headers: { 'x-id': 'abc' },
                requestBody: { email: 'test@example.com' },
                responseBody: { error: 'bad_credentials' },
              }),
              '\n',
            ].join(' '),
          );
          return;
        }
        child.stdout?.push(`I/AgentDevice(4242): ${args.join(' ')}\n`);
        child.stdout?.push(null);
        child.stderr?.push(null);
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return child;
    },
  };
  if (options?.nativeTextInjection) {
    adbProvider.text = async (request) => {
      textInjectionCalls.push({ ...request });
      shellState.searchText = request.text;
    };
  }
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => adbProvider,
    deviceInventoryProvider: async (request) => {
      inventoryRequests.push({ ...request });
      return [PROVIDER_SCENARIO_ANDROID];
    },
  });

  let closed = false;
  return {
    daemon,
    adbCalls,
    textInjectionCalls,
    touchInjectionCalls,
    get gestureViewportCalls() {
      return gestureViewportCalls;
    },
    inventoryRequests,
    apkInstallCalls,
    bundleInstallCalls,
    spawnedLogcat,
    tempRoot,
    apkPath,
    aabPath,
    manifestApkPath,
    selection: { platform: 'android', serial: PROVIDER_SCENARIO_ANDROID.id },
    assertNoHostAdbCalls: () => {
      assert.deepEqual(readHostAdbCalls(hostAdbGuard.argsLogPath), []);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      restoreEnv('AGENT_DEVICE_ANDROID_APP_EVENT_URL_TEMPLATE', previousAppEventTemplate);
      hostAdbGuard.restore();
      fs.rmSync(tempRoot, { recursive: true, force: true });
      await daemon.close();
    },
  };
}

function androidHeapDumpAdbResult(args: string[]): AndroidAdbResult | undefined {
  if (args.slice(0, 4).join(' ') === 'shell am dumpheap com.example.demo') {
    return { stdout: 'Dumping Java heap\n', stderr: '', exitCode: 0 };
  }
  if (args[0] === 'pull' && args[1]?.endsWith('.hprof') && args[2]) {
    fs.mkdirSync(path.dirname(args[2]), { recursive: true });
    fs.writeFileSync(args[2], 'provider-hprof-bytes');
    return { stdout: `${args[1]}: 1 file pulled\n`, stderr: '', exitCode: 0 };
  }
  return undefined;
}

async function createAndroidManifestApk(
  tempRoot: string,
  options: { fileName: string; packageName: string },
): Promise<string> {
  const manifestDir = path.join(tempRoot, `${options.fileName}-payload`);
  await fs.promises.mkdir(manifestDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(manifestDir, 'AndroidManifest.xml'),
    `<manifest package="${options.packageName}" xmlns:android="http://schemas.android.com/apk/res/android" />`,
    'utf8',
  );
  const apkPath = path.join(tempRoot, options.fileName);
  const result = await runCmd('zip', ['-q', apkPath, 'AndroidManifest.xml'], {
    cwd: manifestDir,
    allowFailure: true,
  });
  assert.equal(result.exitCode, 0, `zip failed creating ${options.fileName}: ${result.stderr}`);
  return apkPath;
}

function androidAdbResult(
  args: string[],
  searchText: string,
  clipboardText: string,
  options: {
    snapshotXml?: () => string;
    dumpsysWindow?: () => string;
    pidof?: (packageName: string) => AndroidAdbResult | undefined;
  },
): { stdout: string; stderr: string; exitCode: number; stdoutBuffer?: Buffer } {
  const key = args.join(' ');
  return (
    androidDeviceStateAdbResult(key, args, clipboardText, options.pidof) ??
    androidMetricsAdbResult(key) ??
    androidPackageAdbResult(key, args, options.dumpsysWindow) ??
    androidCaptureAdbResult(key, searchText, options.snapshotXml) ?? {
      stdout: '',
      stderr: '',
      exitCode: 0,
    }
  );
}

type AndroidAdbResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutBuffer?: Buffer;
};

type AndroidProviderShellState = {
  searchText: string;
  clipboardText: string;
};

function createAndroidProviderShellState(): AndroidProviderShellState {
  return { searchText: '', clipboardText: 'hello' };
}

function updateAndroidProviderShellState(args: string[], state: AndroidProviderShellState): void {
  if (args[0] === 'shell' && args[1] === 'input' && args[2] === 'text') {
    state.searchText = String(args[3] ?? '').replaceAll('%s', ' ');
    return;
  }
  if (args.join(' ') === 'shell cmd clipboard set text android otp') {
    state.clipboardText = 'android otp';
  }
}

function androidDeviceStateAdbResult(
  key: string,
  args: string[],
  clipboardText: string,
  pidof?: (packageName: string) => AndroidAdbResult | undefined,
): AndroidAdbResult | undefined {
  if (key === 'shell getprop sys.boot_completed') {
    return { stdout: '1\n', stderr: '', exitCode: 0 };
  }
  if (key === 'shell cmd clipboard get text') {
    return { stdout: `clipboard text: ${clipboardText}\n`, stderr: '', exitCode: 0 };
  }
  if (key === 'shell dumpsys input_method') {
    return { stdout: 'mInputShown=false inputType=0x1\n', stderr: '', exitCode: 0 };
  }
  if (args[0] === 'shell' && args[1] === 'pidof' && args[2]) {
    return pidof?.(args[2]) ?? { stdout: '4242\n', stderr: '', exitCode: 0 };
  }
  return undefined;
}

type AndroidProviderAppState = {
  foreground: string | null;
  runningPackages: Set<string>;
};

function createAndroidProviderAppState(): AndroidProviderAppState {
  return {
    foreground: 'com.android.settings/.Settings',
    runningPackages: new Set(['com.android.settings', 'com.example.demo']),
  };
}

function updateAndroidProviderAppState(
  args: string[],
  state: AndroidProviderAppState,
): AndroidAdbResult | undefined {
  if (args[0] !== 'shell' || args[1] !== 'am') return undefined;
  return stopAndroidProviderApp(args, state) ?? startAndroidProviderApp(args, state);
}

function stopAndroidProviderApp(
  args: string[],
  state: AndroidProviderAppState,
): AndroidAdbResult | undefined {
  if (args[2] !== 'force-stop' || !args[3]) return undefined;
  const packageName = args[3];
  state.runningPackages.delete(packageName);
  if (state.foreground?.startsWith(`${packageName}/`)) {
    state.foreground = null;
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

function startAndroidProviderApp(args: string[], state: AndroidProviderAppState): undefined {
  if (args[2] !== 'start' && args[2] !== 'start-activity') return undefined;

  const componentIndex = args.indexOf('-n');
  const component = componentIndex >= 0 ? args[componentIndex + 1] : undefined;
  if (component) {
    foregroundAndroidComponent(state, component);
    return undefined;
  }
  if (args.includes('android.settings.SETTINGS')) {
    foregroundAndroidComponent(state, 'com.android.settings/.Settings');
  }
  return undefined;
}

function foregroundAndroidComponent(state: AndroidProviderAppState, component: string): void {
  const packageName = component.split('/')[0];
  if (!packageName) return;
  state.runningPackages.add(packageName);
  state.foreground = component;
}

function androidPidofResult(
  state: AndroidProviderAppState,
  packageName: string,
): AndroidAdbResult | undefined {
  return state.runningPackages.has(packageName)
    ? { stdout: '4242\n', stderr: '', exitCode: 0 }
    : { stdout: '', stderr: '', exitCode: 1 };
}

function androidForegroundWindowDump(foreground: string | null): string {
  return foreground ? `mCurrentFocus=Window{42 u0 ${foreground}}\n` : 'mCurrentFocus=null\n';
}

function androidMetricsAdbResult(key: string): AndroidAdbResult | undefined {
  if (key === 'shell wm size') {
    return { stdout: 'Physical size: 1080x1920\n', stderr: '', exitCode: 0 };
  }
  if (key === 'shell dumpsys cpuinfo') {
    return {
      stdout: [
        'Load: 1.0 / 0.5 / 0.25',
        '7.5% 1234/com.example.demo: 5.0% user + 2.5% kernel',
        '1.5% 2345/com.example.demo:sync: 1.0% user + 0.5% kernel',
        '0.3% 999/system_server: 0.2% user + 0.1% kernel',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    };
  }
  if (key === 'shell dumpsys meminfo com.example.demo') {
    return {
      stdout: [
        '** MEMINFO in pid 18227 [com.example.demo] **',
        '                   Pss  Private  Private  Swapped     Heap     Heap     Heap',
        '                 Total    Dirty    Clean    Dirty     Size    Alloc     Free',
        '                ------   ------   ------   ------   ------   ------   ------',
        '          TOTAL   216524   208232     4384        0    82916    68345    14570',
        'App Summary',
        '  TOTAL PSS:   216,524            TOTAL RSS:   340,112       TOTAL SWAP PSS:        0',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    };
  }
  if (key === 'shell dumpsys gfxinfo com.example.demo framestats') {
    return {
      stdout: [
        'Uptime: 10000',
        'Stats since: 9000000000',
        'Total frames rendered: 4',
        'Janky frames: 1 (25.00%)',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    };
  }
  return undefined;
}

function androidPackageAdbResult(
  key: string,
  args: string[],
  dumpsysWindow?: () => string,
): AndroidAdbResult | undefined {
  if (
    args.slice(0, 7).join(' ') ===
    'shell cmd package query-activities --brief -a android.intent.action.MAIN'
  ) {
    return {
      stdout: 'com.android.settings/.Settings\ncom.example.demo/.MainActivity\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (key === 'shell pm list packages -3') {
    return {
      stdout: 'package:com.example.demo\npackage:com.example.serviceonly\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (key === 'shell dumpsys window windows' || key === 'shell dumpsys window') {
    return {
      stdout: dumpsysWindow?.() ?? 'mCurrentFocus=Window{42 u0 com.android.settings/.Settings}\n',
      stderr: '',
      exitCode: 0,
    };
  }
  return undefined;
}

function androidCaptureAdbResult(
  key: string,
  searchText: string,
  snapshotXml?: () => string,
): AndroidAdbResult | undefined {
  if (key.startsWith('shell am instrument ')) {
    return {
      stdout: androidSnapshotHelperOutput(snapshotXml?.() ?? androidSettingsXml(searchText)),
      stderr: '',
      exitCode: 0,
    };
  }
  if (key === 'exec-out screencap -p') {
    return { stdout: '', stderr: '', exitCode: 0, stdoutBuffer: validPng() };
  }
  return undefined;
}

export function androidSnapshotHelperOutput(xml: string): string {
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
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');
}

export function androidSettingsXml(
  searchText: string,
  options: { duplicateAppsRow?: boolean } = {},
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<hierarchy rotation="0">',
    '  <node index="0" text="" resource-id="com.android.settings:id/main_content_scrollable_container" class="android.widget.ScrollView" package="com.android.settings" content-desc="" bounds="[0,0][390,600]" clickable="false" enabled="true">',
    '    <node index="0" text="Apps" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" bounds="[24,124][152,178]" clickable="true" enabled="true" focusable="true" focused="false" />',
    `    <node index="1" text="${escapeXml(searchText)}" resource-id="com.android.settings:id/search" class="android.widget.EditText" package="com.android.settings" content-desc="Search" bounds="[16,24][374,80]" clickable="true" enabled="true" focusable="true" focused="true" password="false" />`,
    ...(options.duplicateAppsRow
      ? [
          '    <node index="2" text="Apps" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="Search result Apps" bounds="[24,190][220,244]" clickable="true" enabled="true" focusable="true" focused="false" />',
        ]
      : []),
    '  </node>',
    '</hierarchy>',
  ].join('\n');
}

function installFakeHostAdbGuard(): { argsLogPath: string; restore: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-provider-scenario-adb-'));
  const adbPath = path.join(tmpDir, 'adb');
  const argsLogPath = path.join(tmpDir, 'adb-args.log');
  fs.writeFileSync(
    adbPath,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$AGENT_DEVICE_TEST_ADB_ARGS_FILE"',
      'printf "host adb must not be used in Provider scenario tests\\n" >&2',
      'exit 99',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.chmodSync(adbPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ADB_ARGS_FILE;
  const previousAuthHook = process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ADB_ARGS_FILE = argsLogPath;
  delete process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;

  return {
    argsLogPath,
    restore: () => {
      process.env.PATH = previousPath;
      restoreEnv('AGENT_DEVICE_TEST_ADB_ARGS_FILE', previousArgsFile);
      restoreEnv('AGENT_DEVICE_HTTP_AUTH_HOOK', previousAuthHook);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function readHostAdbCalls(argsLogPath: string): string[] {
  if (!fs.existsSync(argsLogPath)) return [];
  return fs
    .readFileSync(argsLogPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function makeMockAdbProcess(): EventEmitter & AndroidAdbProcess {
  const child = new EventEmitter() as EventEmitter & AndroidAdbProcess;
  child.stdin = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    if (child.killed) return false;
    child.killed = true;
    child.stdout?.push(null);
    child.stderr?.push(null);
    queueMicrotask(() => child.emit('close', 0, null));
    return true;
  };
  return child;
}

export async function waitForFileContent(filePath: string, expected: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes(expected)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${expected} in ${filePath}`);
}
