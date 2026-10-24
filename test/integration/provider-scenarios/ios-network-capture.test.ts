import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecResult } from '@agent-device/host-kit/command';
import { afterEach, beforeEach, test } from 'vitest';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { createProviderScenarioHarness } from './harness.ts';
import { createRecordingAppleToolProvider, simctlListDevicesResult } from './providers.ts';

// The probe's build cache lives under the host home directory, so this test scopes HOME to a
// throwaway directory (the same posture ios-fold.test.ts takes for the fold helper): otherwise it
// would read and write the real machine's `~/.agent-device/network-capture` cache and the `builds`
// assertion would depend on whatever that machine's cache already held.
let previousHome: string | undefined;
let isolatedHome: string;

beforeEach(() => {
  previousHome = process.env.HOME;
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-network-capture-home-'));
  process.env.HOME = isolatedHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

/** Answers the host-toolchain probe (`xcodebuild -version`, `sw_vers`) the probe build cache reads. */
function toolchainProbeAnswer(cmd: string, args: readonly string[]): ExecResult | undefined {
  if (cmd === 'xcodebuild')
    return { stdout: 'Xcode 16.4\nBuild version 16F6', stderr: '', exitCode: 0 };
  if (cmd === 'sw_vers') {
    return {
      stdout: args.includes('-buildVersion') ? '24G90' : '15.6',
      stderr: '',
      exitCode: 0,
    };
  }
  return undefined;
}

const CAPTURED_TRAFFIC = [
  '{"method":"GET","url":"https://api.example.test/v1/items","status":200,"duration_ms":42,"timestamp_ms":1792000000000}',
  '{"method":"POST","url":"https://api.example.test/v1/orders","status":201,"duration_ms":88,"timestamp_ms":1792000001000}',
];

test('open --capture-network injects the probe and network dump replays its file', async () => {
  const launches: Array<{
    args: readonly string[];
    env: Readonly<Record<string, string | undefined>> | undefined;
  }> = [];
  let builds = 0;
  const appleTool = createRecordingAppleToolProvider({
    simctl: async (args, options) => {
      const devices = simctlListDevicesResult(args, 'com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
        { name: 'iPhone 15', udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id },
      ]);
      if (devices) return devices;
      if (args.join(' ') === 'listapps sim-1') {
        return {
          stdout: '{"com.example.demo":{"CFBundleDisplayName":"Demo"}}',
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'launch') {
        launches.push({ args, env: options?.env });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args.slice(0, 4).join(' ') === `spawn ${PROVIDER_SCENARIO_IOS_SIMULATOR.id} log show`) {
        // The app-log mode's Unified Logging recovery pass: the scripted app emits no HTTP lines.
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`Unscripted simctl call: ${args.join(' ')}`);
    },
  });
  const daemon = await createProviderScenarioHarness({
    appleToolProvider: () => ({
      ...appleTool.provider,
      runCommand: async (command, args) => {
        const probeAnswer = toolchainProbeAnswer(command, args);
        if (probeAnswer) return probeAnswer;
        assert.equal(command, 'xcrun');
        assert.ok(args.includes('clang'), `unexpected xcrun call: ${args.join(' ')}`);
        builds++;
        fs.writeFileSync(args.at(-1)!, 'network-capture-probe-binary');
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }),
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
  });
  try {
    await daemon.client().apps.open({
      app: 'com.example.demo',
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      captureNetwork: true,
    });

    // The capture launch is a new process (dyld injects only at exec) and carries exactly the two
    // SIMCTL_CHILD_ variables: the dylib path and the file the probe writes.
    assert.equal(launches.length, 1);
    const launch = launches[0]!;
    assert.deepEqual(launch.args.slice(0, 4), [
      'launch',
      '--terminate-running-process',
      PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      'com.example.demo',
    ]);
    const insertPath = launch.env?.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES;
    assert.ok(insertPath, 'capture launch carries SIMCTL_CHILD_DYLD_INSERT_LIBRARIES');
    assert.ok(
      insertPath!.startsWith(path.join(isolatedHome, '.agent-device', 'network-capture')) &&
        insertPath!.endsWith('ADNetworkCapture.dylib'),
      `probe injected from the build cache, got ${insertPath}`,
    );
    const capturePath = launch.env?.SIMCTL_CHILD_AGENT_DEVICE_NETWORK_CAPTURE_PATH;
    assert.ok(capturePath, 'capture launch carries the probe output path');
    assert.ok(capturePath!.endsWith(path.join('sessions', 'default', 'network.jsonl')));
    assert.equal(builds, 1, 'the first capture launch builds the probe once');

    // A second capture launch serves the cached binary instead of rebuilding (the same cache
    // posture the fold helper proves).
    await daemon.client().apps.open({
      app: 'com.example.demo',
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      captureNetwork: true,
    });
    assert.equal(builds, 1, 'the cached probe binary is reused, not rebuilt');

    // Console capture and network capture on one open: the same launch reads the console PTY
    // AND injects the probe, through the single spawn path both options share.
    const consolePath = path.join(isolatedHome, 'launch-console.log');
    await daemon.client().apps.open({
      app: 'com.example.demo',
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      captureNetwork: true,
      launchConsole: consolePath,
    });
    const consoleLaunch = launches.at(-1)!;
    assert.equal(consoleLaunch.args.includes('--console-pty'), true);
    assert.equal(consoleLaunch.args.includes('--terminate-running-process'), true);
    assert.ok(
      consoleLaunch.env?.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES,
      'the console launch still injects the probe',
    );
    assert.ok(
      consoleLaunch.env?.SIMCTL_CHILD_AGENT_DEVICE_NETWORK_CAPTURE_PATH,
      'the console launch still names the capture file',
    );

    // The probe wrote its file inside the app process; the scripted world writes what that app
    // would have appended, then the dump must report it as the probe's own record.
    fs.mkdirSync(path.dirname(capturePath!), { recursive: true });
    fs.writeFileSync(capturePath!, `${CAPTURED_TRAFFIC.join('\n')}\n`);
    const dump = await daemon.client().observability.network({
      action: 'dump',
      limit: 5,
      include: 'summary',
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
    });
    assert.equal(dump.source, 'probe');
    assert.equal(dump.backend, 'ios-simulator');
    const entries = Array.isArray(dump.entries) ? dump.entries : [];
    assert.deepEqual(
      entries.map((entry) => (entry as Record<string, unknown>).url),
      ['https://api.example.test/v1/orders', 'https://api.example.test/v1/items'],
      'probe entries are newest first',
    );
    const newest = entries[0] as Record<string, unknown>;
    assert.equal(newest.method, 'POST');
    assert.equal(newest.status, 201);
    assert.equal(newest.durationMs, 88);

    // No app-log line is consulted in probe mode: the scripted provider saw no `log show`.
    assert.equal(
      appleTool.calls.filter((call) => call.includes('log')).length,
      0,
      'probe mode never reads the Unified Log',
    );

    // Reopening the same session WITHOUT the flag clears the capture window: the next dump is the
    // other mode again (app-log), not the stale probe file the last capture launch left behind.
    const plainLaunchesBefore = launches.length;
    await daemon.client().apps.open({
      app: 'com.example.demo',
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
    });
    assert.equal(launches.length, plainLaunchesBefore + 1);
    const plainLaunch = launches.at(-1)!;
    assert.ok(
      !(plainLaunch.env?.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES ?? ''),
      'a plain launch never injects the probe',
    );
    assert.equal(plainLaunch.args.includes('--terminate-running-process'), false);
    const afterPlainOpen = await daemon.client().observability.network({
      action: 'dump',
      limit: 5,
      include: 'summary',
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
    });
    assert.equal(afterPlainOpen.source, 'app-log');
  } finally {
    await daemon.close();
  }
});
