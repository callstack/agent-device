import { acquireDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import * as inventoryContext from '@agent-device/device-selection/device-inventory-context';
import { resolveCommandTimeoutPolicy } from '@agent-device/command-registry/registry';
import { resolveCommandRequestTimeoutMs } from '@agent-device/command-registry/timeout-policy';
import * as hostCommands from '@agent-device/host-kit/command';
import {
  withCommandExecutorOverride,
  type CommandExecutorOverride,
} from '@agent-device/host-kit/command';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import * as timers from 'node:timers/promises';
import { pack } from 'tar-stream';
import {
  createLocalAppleToolProvider,
  type AppleToolProvider,
} from '@agent-device/platform-apple/tool-provider';
import * as networkTransport from '@agent-device/provision-kit/install-source-network-transport';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs';
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

vi.mock('node:timers/promises', async (original) => ({ ...(await original<typeof timers>()) }));

type InstallCommand = 'install' | 'reinstall' | 'install_source';

type InstallLedgerCall = Readonly<{
  tool: string;
  args: readonly string[];
  timeoutMs: number;
}>;

type InstallRoute =
  | 'iOS physical device'
  | 'iOS simulator'
  | 'Android APK'
  | 'Android AAB fallback';

class InstallLedger {
  readonly calls: InstallLedgerCall[] = [];
  now = 1_700_000_000_000;

  record(
    tool: string,
    args: readonly string[],
    timeoutMs: number | undefined,
    elapsedMs?: number,
  ): void {
    assert.ok(
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0,
      `Unbounded install phase: ${tool} ${args.join(' ')}`,
    );
    this.calls.push({ tool, args: [...args], timeoutMs });
    this.now += Math.max(0, elapsedMs ?? timeoutMs - 1);
  }
}

type InstallLedgerScenario = ClosableProviderScenarioResource &
  Readonly<{
    appPath: string;
    claimsDir?: string;
    daemon: ProviderScenarioHarness;
    ledger: InstallLedger;
    selection: Readonly<
      { platform: 'android'; device: string } | { platform: 'ios'; udid: string }
    >;
  }>;

const REQUIRED_DAEMON_RESULT_MARGIN_MS = 30_000;
let nextAppleScenarioId = 0;

for (const route of [
  'iOS physical device',
  'iOS simulator',
  'Android APK',
  'Android AAB fallback',
] as const) {
  for (const command of ['install', 'reinstall', 'install_source', 'install_source URL'] as const) {
    test(`${route} ${command} leaves 30s for the daemon result`, async () => {
      await withInstallLedgerScenario(route, async (scenario) => {
        if (command === 'install_source URL') await runInstallSourceFromUrlCommand(scenario);
        else await runInstallCommand(scenario, command);
        const daemonCommand = command === 'install_source URL' ? 'install_source' : command;
        assertInstallLedgerPhaseCoverage(route, daemonCommand, scenario.ledger.calls);
        if (command === 'install_source URL') {
          assert.ok(scenario.ledger.calls.some((call) => call.tool === 'download'));
        }
        assertLedgerFitsEnvelope(route, daemonCommand, scenario.ledger.calls);
      });
    });
  }
}

for (const command of ['install', 'reinstall', 'install_source'] as const) {
  test(`${command} admits the discovered emulator before deployment`, async () => {
    await withInstallLedgerScenario('Android APK', async (scenario) => {
      assert.ok(scenario.claimsDir);
      await acquireDeviceClaim({
        env: { AGENT_DEVICE_CLAIMS_DIR: scenario.claimsDir },
        device: PROVIDER_SCENARIO_ANDROID,
        session: 'foreign-session',
        workspace: '/foreign-worktree',
        stateDir: path.join(path.dirname(scenario.daemon.stateDir), 'foreign-state'),
        reconcileOrphanedDeviceClaim: async () => ({
          status: 'retained',
          reason: 'live-test-owner',
        }),
      });
      await assert.rejects(runInstallCommand(scenario, command), { code: 'DEVICE_IN_USE' });
      assert.ok(scenario.ledger.calls.some((call) => call.args.includes('sys.boot_completed')));
      assert.ok(
        !scenario.ledger.calls.some(
          (call) => call.args.includes('install') || call.args.includes('uninstall'),
        ),
      );
    });
  });
}

async function withInstallLedgerScenario<T>(
  route: InstallRoute,
  run: (scenario: InstallLedgerScenario) => Promise<T>,
): Promise<T> {
  const ledger = new InstallLedger();
  vi.spyOn(Date, 'now').mockImplementation(() => ledger.now);
  vi.spyOn(timers, 'setTimeout').mockImplementation(async (ms = 1, value) => {
    ledger.record('sleep', [], ms, ms);
    return value;
  });
  let scenario: InstallLedgerScenario | undefined;
  try {
    scenario = isAndroidRoute(route)
      ? await createAndroidScenario(route, ledger)
      : await createIosScenario(route, ledger);
    return await run(scenario);
  } finally {
    try {
      await scenario?.close();
    } finally {
      vi.restoreAllMocks();
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
  const timeouts = new WeakMap<AbortSignal, number>();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const any = AbortSignal.any.bind(AbortSignal);
  const timeoutMock = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const signal = timeout(ms);
    timeouts.set(signal, ms);
    return signal;
  });
  const anyMock = vi.spyOn(AbortSignal, 'any').mockImplementation((signals) => {
    const signal = any(signals);
    const ms = signals.map((part) => timeouts.get(part)).find((value) => value !== undefined);
    if (ms !== undefined) timeouts.set(signal, ms);
    return signal;
  });
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
      scenario.ledger.record('download', [request.url.toString()], timeouts.get(request.signal));
      return {
        statusCode: 200,
        headers: {},
        body: downloadBody(scenario.appPath),
        close: async () => {},
      };
    });
  try {
    await scenario.daemon.client().apps.installFromSource({
      source: {
        kind: 'url',
        url: `https://artifacts.example.com/${path.basename(scenario.appPath)}${scenario.appPath.endsWith('.app') ? '.tar' : ''}`,
      },
      ...scenario.selection,
    });
  } finally {
    requestMock.mockRestore();
    lookupMock.mockRestore();
    anyMock.mockRestore();
    timeoutMock.mockRestore();
  }
}

async function createIosScenario(
  route: 'iOS physical device' | 'iOS simulator',
  ledger: InstallLedger,
): Promise<InstallLedgerScenario> {
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
  const commandOverride = createInstallLedgerHostCommandOverride(ledger);
  const daemon = await withCommandExecutorOverride(
    commandOverride,
    async () =>
      await createProviderScenarioHarness({
        deviceInventoryProvider: async () => [device],
        appleToolProvider: () => createInstallLedgerAppleToolProvider(route, device.id, ledger),
      }),
  );
  return {
    appPath,
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
  ledger: InstallLedger,
): AppleToolProvider {
  const ok = { stdout: '', stderr: '', exitCode: 0 };
  let simulatorBooted = false;
  return createLocalAppleToolProvider({
    whichCommand: async () => true,
    runCommand: async (cmd, args, options) => {
      assert.equal(cmd, 'plutil');
      ledger.record(cmd, args, options?.timeoutMs);
      // Conversion and extraction can both fail before the XML reader resolves the identity.
      return { stdout: '', stderr: '', exitCode: 1 };
    },
    simctl: {
      run: async (args, options) => {
        ledger.record('simctl', args, options?.timeoutMs);
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
        ledger.record('devicectl', args, options?.timeoutMs);
        if (args.includes('details')) {
          writeCoreDeviceDetailsJson(args);
          return ok;
        }
        assert.equal(route, 'iOS physical device');
        assert.ok(args.includes('install') || args.includes('uninstall'), args.join(' '));
        return ok;
      },
    },
  });
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
  ledger: InstallLedger,
): Promise<InstallLedgerScenario> {
  const tempRoot = mkdtempForTestSync('agent-device-install-ledger-android-');
  const appPath = path.join(tempRoot, route === 'Android APK' ? 'Demo.apk' : 'Demo.aab');
  fs.writeFileSync(appPath, 'placeholder artifact');
  for (const tool of ['adb', 'emulator', 'bundletool']) {
    fs.writeFileSync(path.join(tempRoot, tool), '', { mode: 0o755 });
  }
  const aaptPath = path.join(tempRoot, 'build-tools', '99.0.0', 'aapt');
  fs.mkdirSync(path.dirname(aaptPath), { recursive: true });
  fs.writeFileSync(aaptPath, '', { mode: 0o755 });
  let installed = false;
  let launched = false;
  let bootProbeCapMs: number | undefined;
  const device = { ...PROVIDER_SCENARIO_ANDROID, id: 'Pixel_8', booted: false };
  vi.spyOn(hostCommands, 'runCmdDetached').mockImplementation((command) => {
    assert.equal(command, 'emulator');
    launched = true;
    return 4242;
  });
  vi.spyOn(hostCommands, 'runCmd').mockImplementation(async (command, args, options = {}) => {
    if (command === 'adb') {
      assert.equal(args[args.indexOf('-s') + 1], 'emulator-5554');
    }
    if (command === 'adb' && args.some((arg) => arg.includes('sys.boot_completed'))) {
      assert.ok(options.timeoutMs);
      bootProbeCapMs ??= options.timeoutMs;
      const ready = options.timeoutMs < bootProbeCapMs;
      // Leave room for the poll sleep; complete only when the real boot deadline narrows a probe.
      ledger.record(
        command,
        args,
        options.timeoutMs,
        ready ? undefined : options.timeoutMs - 1_001,
      );
      return { stdout: ready ? '1' : '0', stderr: '', exitCode: 0 };
    }
    ledger.record(command, args, options.timeoutMs);
    if (command === '/usr/bin/lsappinfo') return { stdout: '', stderr: '', exitCode: 0 };
    if (command === '/usr/sbin/sysctl') return { stdout: '1', stderr: '', exitCode: 0 };
    if (command === 'adb') {
      if (args.includes('install')) installed = true;
      if (args.includes('uninstall')) installed = false;
      return {
        stdout:
          args.includes('shell') && args.join(' ').includes('packages')
            ? installed
              ? 'package:com.example.demo\n'
              : ''
            : 'Success',
        stderr: '',
        exitCode: 0,
      };
    }
    if (command === 'bundletool') {
      if (args.includes('install-apks')) {
        assert.equal(args[args.indexOf('--device-id') + 1], 'emulator-5554');
        installed = true;
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    assert.ok(command === 'unzip' || path.basename(command) === 'aapt', command);
    return { stdout: '', stderr: '', exitCode: 1 };
  });
  const inventory = async () => [launched ? { ...device, id: 'emulator-5554' } : device];
  vi.spyOn(inventoryContext, 'listLocalDeviceInventory').mockImplementation(inventory);
  const daemon = await createProviderScenarioHarness({
    deviceInventoryProvider: inventory,
    env: {
      PATH: tempRoot,
      ANDROID_HOME: tempRoot,
      ANDROID_SDK_ROOT: tempRoot,
      AGENT_DEVICE_CLAIMS_DIR: path.join(tempRoot, 'claims'),
    },
  });
  return {
    appPath,
    daemon,
    ledger,
    selection: { platform: 'android', device: device.name },
    claimsDir: path.join(tempRoot, 'claims'),
    close: async () => {
      await daemon.close();
    },
  };
}

function downloadBody(appPath: string): Readable {
  if (!appPath.endsWith('.app')) return Readable.from([fs.readFileSync(appPath)]);
  const archive = pack();
  archive.entry({ name: 'Demo.app/Info.plist' }, fs.readFileSync(path.join(appPath, 'Info.plist')));
  archive.finalize();
  return archive;
}

function isAndroidRoute(route: InstallRoute): route is 'Android APK' | 'Android AAB fallback' {
  return route.startsWith('Android');
}

function createInstallLedgerHostCommandOverride(ledger: InstallLedger): CommandExecutorOverride {
  return (command, args, options) => {
    assert.equal(command, 'open');
    ledger.record(command, args, options.timeoutMs);
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  };
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
  const expected = isAndroidRoute(route)
    ? [
        'sys.boot_completed',
        ...(route === 'Android APK' ? ['install'] : ['build-apks', 'install-apks']),
      ]
    : route === 'iOS simulator'
      ? ['list', 'boot', 'bootstatus', 'open', 'install']
      : ['details', 'install'];
  if (!isAndroidRoute(route)) expected.push('plutil', '-convert', '-extract');
  if (command === 'reinstall') expected.push('uninstall');
  if (isAndroidRoute(route)) {
    assert.ok(
      ledger.filter((call) => call.tool === 'adb' && call.args.join(' ').includes('packages'))
        .length >= 2,
      'missing before/after package inventories',
    );
    if (command !== 'reinstall') expected.push('unzip');
  }
  for (const phase of expected) {
    assert.ok(
      ledger.some((call) => call.tool === phase || call.args.some((arg) => arg.includes(phase))),
      `${route} ${command}: missing ${phase} phase. Ledger: ${JSON.stringify(ledger)}`,
    );
  }
}
