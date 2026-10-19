import { resolveCommandTimeoutPolicy } from '@agent-device/command-registry/registry';
import { resolveCommandRequestTimeoutMs } from '@agent-device/command-registry/timeout-policy';
import {
  withCommandExecutorOverride,
  type CommandExecutorOverride,
} from '@agent-device/host-kit/command';
import type { AndroidAdbProvider } from '@agent-device/platform-android/mechanics';
import type { AppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import { INSTALL_SOURCE_DOWNLOAD_TIMEOUT_MS } from '@agent-device/provision-kit/install-source';
import * as networkTransport from '@agent-device/provision-kit/install-source-network-transport';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test, vi } from 'vitest';
import {
  PROVIDER_SCENARIO_ANDROID,
  PROVIDER_SCENARIO_IOS_DEVICE,
  PROVIDER_SCENARIO_IOS_SIMULATOR,
  createDemoIosApp,
} from './fixtures.ts';
import {
  createProviderScenarioHarness,
  type ClosableProviderScenarioResource,
  type ProviderScenarioHarness,
} from './harness.ts';

type InstallCommand = 'install' | 'reinstall' | 'install_source';

type InstallLedgerCall = Readonly<{
  tool: 'adb' | 'adb-install' | 'bundletool' | 'download' | 'open' | 'simctl' | 'devicectl';
  args: readonly string[];
  timeoutMs: number;
}>;

type InstallRoute =
  | 'iOS physical device'
  | 'iOS simulator'
  | 'Android APK'
  | 'Android AAB fallback';

type InstallLedgerClock = Readonly<{
  advanceByLedgerTimeout(timeoutMs: number): void;
}>;

type InstallLedgerScenario = ClosableProviderScenarioResource &
  Readonly<{
    appPath: string;
    clock: InstallLedgerClock;
    daemon: ProviderScenarioHarness;
    ledger: InstallLedgerCall[];
    selection: Readonly<
      { platform: 'android'; serial: string } | { platform: 'ios'; udid: string }
    >;
  }>;

const REQUIRED_DAEMON_RESULT_MARGIN_MS = 30_000;
// The native deployment unit asserts this is the timeout passed to bundletool; the fake
// executable can only report argv back across the daemon HTTP boundary.
const ANDROID_BUNDLETOOL_TIMEOUT_MS = 120_000;
let nextAppleScenarioId = 0;

for (const route of [
  'iOS physical device',
  'iOS simulator',
  'Android APK',
  'Android AAB fallback',
] as const) {
  test(`install-family request envelope covers the ${route} worst-case ledger`, async () => {
    for (const command of ['install', 'reinstall', 'install_source'] as const) {
      await withInstallLedgerScenario(route, async (scenario) => {
        await runInstallCommand(scenario, command);
        assertInstallLedgerPhaseCoverage(route, command, scenario.ledger);
        assertLedgerFitsEnvelope(route, command, scenario.ledger);
      });
    }
  }, 20_000);
}

test('install_source request envelope covers URL download before the Android AAB fallback ledger', async () => {
  await withInstallLedgerScenario('Android AAB fallback', async (scenario) => {
    await runInstallSourceFromUrlCommand(scenario);
    assertInstallLedgerPhaseCoverage('Android AAB fallback', 'install_source', scenario.ledger);
    assert.ok(
      scenario.ledger.some((call) => call.tool === 'download'),
      `install_source URL ledger is missing the download phase.\nLedger:\n${JSON.stringify(
        scenario.ledger,
        null,
        2,
      )}`,
    );
    assertLedgerFitsEnvelope('Android AAB fallback URL source', 'install_source', scenario.ledger);
  });
}, 20_000);

async function withInstallLedgerScenario<T>(
  route: InstallRoute,
  run: (scenario: InstallLedgerScenario) => Promise<T>,
): Promise<T> {
  let virtualNowMs = 1_700_000_000_000;
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => virtualNowMs);
  const clock: InstallLedgerClock = {
    advanceByLedgerTimeout: (timeoutMs) => {
      virtualNowMs += Math.max(0, timeoutMs - 1);
    },
  };
  const scenario = isAndroidRoute(route)
    ? await createAndroidScenario(route, clock)
    : await createIosScenario(route, clock);
  try {
    return await run(scenario);
  } finally {
    try {
      await scenario.close();
    } finally {
      dateNow.mockRestore();
    }
  }
}

async function runInstallCommand(
  scenario: InstallLedgerScenario,
  command: InstallCommand,
): Promise<void> {
  const client = scenario.daemon.client();
  if (command === 'install') {
    await client.apps.install({
      app: 'com.example.demo',
      appPath: scenario.appPath,
      ...scenario.selection,
    });
    return;
  }
  if (command === 'reinstall') {
    await client.apps.reinstall({
      app: 'com.example.demo',
      appPath: scenario.appPath,
      ...scenario.selection,
    });
    return;
  }
  await client.apps.installFromSource({
    source: { kind: 'path', path: scenario.appPath },
    ...scenario.selection,
  });
}

async function runInstallSourceFromUrlCommand(scenario: InstallLedgerScenario): Promise<void> {
  const lookupMock = vi
    .spyOn(dns, 'lookup')
    .mockImplementation(
      async () =>
        [{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<
          ReturnType<typeof dns.lookup>
        >,
    );
  const requestMock = vi
    .spyOn(networkTransport, 'requestApprovedUrl')
    .mockImplementation(async (request): Promise<networkTransport.InstallSourceNetworkResponse> => {
      recordLedgerCall(
        scenario.ledger,
        'download',
        [request.url.toString()],
        INSTALL_SOURCE_DOWNLOAD_TIMEOUT_MS,
        scenario.clock,
      );
      return {
        statusCode: 200,
        headers: {},
        body: Readable.from([fs.readFileSync(scenario.appPath)]),
        close: async () => {},
      };
    });
  try {
    await scenario.daemon.client().apps.installFromSource({
      source: { kind: 'url', url: 'https://artifacts.example.com/Demo.aab' },
      ...scenario.selection,
    });
  } finally {
    requestMock.mockRestore();
    lookupMock.mockRestore();
  }
}

async function createIosScenario(
  route: 'iOS physical device' | 'iOS simulator',
  clock: InstallLedgerClock,
): Promise<InstallLedgerScenario> {
  const ledger: InstallLedgerCall[] = [];
  const scenarioId = ++nextAppleScenarioId;
  const device =
    route === 'iOS physical device'
      ? {
          ...PROVIDER_SCENARIO_IOS_DEVICE,
          id: `${PROVIDER_SCENARIO_IOS_DEVICE.id}-${scenarioId}`,
          iosPhysicalDeviceBackend: 'coredevice' as const,
        }
      : {
          ...PROVIDER_SCENARIO_IOS_SIMULATOR,
          id: `sim-install-ledger-${scenarioId}`,
          booted: false,
        };
  const { tempRoot, appPath } = createDemoIosApp('agent-device-install-ledger-ios-');
  const commandOverride = createInstallLedgerHostCommandOverride(ledger, clock);
  const daemon = await withCommandExecutorOverride(
    commandOverride,
    async () =>
      await createProviderScenarioHarness({
        deviceInventoryProvider: async () => [device],
        appleToolProvider: () =>
          createInstallLedgerAppleToolProvider(route, device.id, ledger, clock),
      }),
  );
  return {
    appPath,
    clock,
    daemon,
    ledger,
    selection: { platform: 'ios', udid: device.id },
    close: async () => {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      await daemon.close();
    },
  };
}

function createInstallLedgerAppleToolProvider(
  route: 'iOS physical device' | 'iOS simulator',
  deviceId: string,
  ledger: InstallLedgerCall[],
  clock: InstallLedgerClock,
): AppleToolProvider {
  const ok = { stdout: '', stderr: '', exitCode: 0 };
  let simulatorBooted = false;
  return {
    whichCommand: async () => true,
    runCommand: async (cmd, args) => {
      throw new Error(`Unscripted Apple install ledger host call: ${cmd} ${args.join(' ')}`);
    },
    plist: {
      readJson: async () => ({
        CFBundleIdentifier: 'com.example.demo',
        CFBundleName: 'Demo',
      }),
    },
    simctl: {
      run: async (args, options) => {
        recordLedgerCall(ledger, 'simctl', args, options?.timeoutMs, clock);
        if (args.includes('list')) {
          return {
            stdout: JSON.stringify({
              devices: {
                'iOS 18.5': [{ udid: deviceId, state: simulatorBooted ? 'Booted' : 'Shutdown' }],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('boot')) {
          simulatorBooted = true;
          return ok;
        }
        assert.ok(
          args.includes('bootstatus') || args.includes('install') || args.includes('uninstall'),
          args.join(' '),
        );
        return ok;
      },
    },
    devicectl: {
      run: async (args, options) => {
        recordLedgerCall(ledger, 'devicectl', args, options?.timeoutMs, clock);
        if (args.includes('details')) {
          writeCoreDeviceDetailsJson(args);
          return ok;
        }
        assert.equal(route, 'iOS physical device');
        assert.ok(args.includes('install') || args.includes('uninstall'), args.join(' '));
        return ok;
      },
    },
  };
}

function writeCoreDeviceDetailsJson(args: readonly string[]): void {
  const jsonOutputIndex = args.indexOf('--json-output');
  const jsonPath = jsonOutputIndex >= 0 ? args[jsonOutputIndex + 1] : undefined;
  assert.ok(jsonPath, `devicectl details call did not include --json-output: ${args.join(' ')}`);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      result: {
        connectionProperties: { tunnelState: 'connected', tunnelIPAddress: '127.0.0.1' },
        deviceProperties: {
          bootState: 'booted',
          developerModeStatus: 'enabled',
          ddiServicesAvailable: true,
        },
      },
    }),
  );
}

async function createAndroidScenario(
  route: 'Android APK' | 'Android AAB fallback',
  clock: InstallLedgerClock,
): Promise<InstallLedgerScenario> {
  const ledger: InstallLedgerCall[] = [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-install-ledger-android-'));
  const appPath = path.join(tempRoot, route === 'Android APK' ? 'Demo.apk' : 'Demo.aab');
  const bundletoolPath = path.join(tempRoot, 'bundletool');
  const bundletoolLedgerPath = path.join(tempRoot, 'bundletool-ledger.jsonl');
  fs.writeFileSync(appPath, 'placeholder apk');
  writeBundletoolLedgerScript(bundletoolPath);
  fs.chmodSync(bundletoolPath, 0o755);
  let installed = false;
  let syncedBundletoolCallCount = 0;
  const syncBundletoolLedger = () => {
    if (!fs.existsSync(bundletoolLedgerPath)) return;
    const lines = fs.readFileSync(bundletoolLedgerPath, 'utf8').split('\n').filter(Boolean);
    for (; syncedBundletoolCallCount < lines.length; syncedBundletoolCallCount += 1) {
      const line = lines[syncedBundletoolCallCount];
      assert.ok(line !== undefined);
      const parsedArgs = JSON.parse(line) as unknown;
      assert.ok(Array.isArray(parsedArgs) && parsedArgs.every((arg) => typeof arg === 'string'));
      const bundletoolArgs = parsedArgs as string[];
      recordLedgerCall(ledger, 'bundletool', bundletoolArgs, ANDROID_BUNDLETOOL_TIMEOUT_MS, clock);
      if (bundletoolArgs.includes('install-apks')) installed = true;
    }
  };
  const provider: AndroidAdbProvider = {
    exec: async (args, options) => {
      syncBundletoolLedger();
      recordLedgerCall(ledger, 'adb', args, options?.timeoutMs, clock);
      const key = args.join(' ');
      if (key === 'shell pm list packages') {
        return {
          stdout: installed ? 'package:com.example.demo\n' : '',
          stderr: '',
          exitCode: 0,
        };
      }
      if (key === 'uninstall com.example.demo') {
        installed = false;
        return { stdout: 'Success\n', stderr: '', exitCode: 0 };
      }
      throw new Error(`Unscripted Android install ledger adb call: ${key}`);
    },
    install: async (apkPath, options) => {
      recordLedgerCall(ledger, 'adb-install', [apkPath], options?.timeoutMs, clock);
      installed = true;
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const commandOverride = createInstallLedgerHostCommandOverride(ledger, clock, {
    onBundletoolInstallApks: () => {
      installed = true;
    },
  });
  const daemon = await withCommandExecutorOverride(
    commandOverride,
    async () =>
      await createProviderScenarioHarness({
        androidAdbProvider: () => provider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
        env: {
          AGENT_DEVICE_BUNDLETOOL_LEDGER: bundletoolLedgerPath,
          PATH: `${tempRoot}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      }),
  );
  return {
    appPath,
    clock,
    daemon,
    ledger,
    selection: { platform: 'android', serial: PROVIDER_SCENARIO_ANDROID.id },
    close: async () => {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      await daemon.close();
    },
  };
}

function writeBundletoolLedgerScript(bundletoolPath: string): void {
  fs.writeFileSync(
    bundletoolPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const ledger = process.env.AGENT_DEVICE_BUNDLETOOL_LEDGER;',
      String.raw`if (ledger) fs.appendFileSync(ledger, JSON.stringify(process.argv.slice(2)) + '\n');`,
    ].join('\n'),
  );
}

function isAndroidRoute(route: InstallRoute): route is 'Android APK' | 'Android AAB fallback' {
  return route.startsWith('Android');
}

function createInstallLedgerHostCommandOverride(
  ledger: InstallLedgerCall[],
  clock: InstallLedgerClock,
  hooks: Readonly<{ onBundletoolInstallApks?: () => void }> = {},
): CommandExecutorOverride {
  return (command, args, options) => {
    if (command === 'open') {
      recordLedgerCall(ledger, 'open', args, options.timeoutMs, clock);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    }
    if (command === 'bundletool' || command === 'java') {
      recordLedgerCall(ledger, 'bundletool', args, options.timeoutMs, clock);
      if (args.includes('install-apks')) hooks.onBundletoolInstallApks?.();
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    }
    return undefined;
  };
}

function recordLedgerCall(
  ledger: InstallLedgerCall[],
  tool: InstallLedgerCall['tool'],
  args: readonly string[],
  timeoutMs: number | undefined,
  clock: InstallLedgerClock,
): void {
  assert.ok(
    Number.isFinite(timeoutMs) && timeoutMs! > 0,
    `install ledger call has no bounded timeoutMs: ${tool} ${args.join(' ')}`,
  );
  ledger.push({ tool, args: [...args], timeoutMs: timeoutMs! });
  clock.advanceByLedgerTimeout(timeoutMs!);
}

function assertLedgerFitsEnvelope(
  route: string,
  command: InstallCommand,
  ledger: readonly InstallLedgerCall[],
): void {
  const virtualElapsedMs = ledger.reduce(
    (total, call) => total + Math.max(0, call.timeoutMs - 1),
    0,
  );
  const envelopeMs = resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy(command), {
    positionals: [],
    flags: {},
  });
  assert.ok(envelopeMs !== undefined, `${command} must declare a bounded envelope`);
  assert.ok(
    virtualElapsedMs + REQUIRED_DAEMON_RESULT_MARGIN_MS <= envelopeMs,
    `${route} ${command} ledger worst case (${virtualElapsedMs}ms) + ` +
      `${REQUIRED_DAEMON_RESULT_MARGIN_MS}ms margin exceeds the ${envelopeMs}ms envelope.\n` +
      `Ledger:\n${JSON.stringify(ledger, null, 2)}`,
  );
}

function assertInstallLedgerPhaseCoverage(
  route: InstallRoute,
  command: InstallCommand,
  ledger: readonly InstallLedgerCall[],
): void {
  assert.ok(ledger.length > 0, `${route} ${command} ledger recorded no calls`);
  assert.ok(
    ledger.some(
      (call) => call.args.some((arg) => arg.includes('install')) || call.tool === 'adb-install',
    ),
    `${route} ${command} ledger is missing the install phase.\nLedger:\n${JSON.stringify(
      ledger,
      null,
      2,
    )}`,
  );
  if (command === 'reinstall') {
    assert.ok(
      ledger.some((call) => call.args.includes('uninstall')),
      `${route} reinstall ledger is missing the uninstall phase`,
    );
  }
  if (route === 'iOS physical device') {
    assert.ok(
      ledger.some((call) => call.args.includes('details')),
      `${route} ${command} ledger is missing the readiness phase`,
    );
  }
  if (route === 'iOS simulator') {
    assert.ok(
      ledger.some((call) => call.args.includes('list')),
      `${route} ${command} ledger is missing the boot-state probe phase`,
    );
    assert.ok(
      ledger.some((call) => call.args.includes('boot')),
      `${route} ${command} ledger is missing the simulator boot phase`,
    );
    assert.ok(
      ledger.some((call) => call.args.includes('bootstatus')),
      `${route} ${command} ledger is missing the simulator bootstatus phase`,
    );
    assert.ok(
      ledger.some((call) => call.tool === 'open' && call.args.includes('Simulator')),
      `${route} ${command} ledger is missing the Simulator.app reveal phase`,
    );
  }
  if (isAndroidRoute(route) && (command === 'install' || command === 'install_source')) {
    assert.ok(
      ledger.some((call) => call.args.join(' ') === 'shell pm list packages'),
      `${route} ${command} ledger is missing the package-inventory phase`,
    );
  }
  if (route === 'Android AAB fallback') {
    assert.ok(
      ledger.some((call) => call.args.includes('build-apks')),
      `${route} ${command} ledger is missing the bundle build phase`,
    );
    assert.ok(
      ledger.some((call) => call.args.includes('install-apks')),
      `${route} ${command} ledger is missing the bundle install phase`,
    );
  }
}
