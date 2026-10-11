import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { IOS_DEVICECTL_MIN_TIMEOUT_SECONDS } from '../config.ts';
import {
  ensureCoreDeviceReady,
  launchCoreDeviceApp,
  parseIosDeviceDetailsPayload,
  readIosDeviceReadiness,
  resolveIosReadyHint,
  type IosDeviceReadiness,
} from '../physical-device-coredevice.ts';
import { IOS_DEVICE_READY_TIMEOUT_MS } from '../physical-device-constants.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  IOS_DEVICE_DEVELOPER_DISK_IMAGE_HINT,
  IOS_DEVICE_DEVELOPER_MODE_OFF_HINT,
} from '../devicectl.ts';
import { resolveIosPhysicalDeviceControl } from '../physical-device-control.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';
import { withFakeAppleTool } from '../../__tests__/fake-apple-tool.ts';

/**
 * `xcrun devicectl device info details` is the one tool that answers what a device thinks of itself,
 * and #2682 read its output for exactly one of those answers. The capture below is the shape that
 * made the mistake possible: the toggle and the developer disk image sit side by side in
 * `deviceProperties`, so a reader that only looks for one of them reports the other wrongly.
 */
const DEVICE_INFO_DETAILS_CAPTURE = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, 'fixtures', 'ios-device-info-details.json'),
    'utf8',
  ),
) as unknown;

test('launchCoreDeviceApp puts --payload-url before the bundle ID', async () => {
  await withFakeAppleTool(
    () => '',
    async ({ calls }) => {
      await launchCoreDeviceApp(IOS_DEVICE, 'com.example.app', {
        payloadUrl: 'myapp://item/42',
      });
      assert.deepEqual(calls, [
        [
          'devicectl',
          'device',
          'process',
          'launch',
          '--device',
          IOS_DEVICE.id,
          '--payload-url',
          'myapp://item/42',
          'com.example.app',
        ],
      ]);
    },
    { device: IOS_DEVICE },
  );
});

test('launchCoreDeviceApp keeps launch args after the bundle ID, separated by --', async () => {
  await withFakeAppleTool(
    () => '',
    async ({ calls }) => {
      await launchCoreDeviceApp(IOS_DEVICE, 'com.example.app', {
        payloadUrl: 'myapp://item/42',
        launchArgs: ['--debug'],
      });
      assert.deepEqual(calls, [
        [
          'devicectl',
          'device',
          'process',
          'launch',
          '--device',
          IOS_DEVICE.id,
          '--payload-url',
          'myapp://item/42',
          'com.example.app',
          '--',
          '--debug',
        ],
      ]);
    },
    { device: IOS_DEVICE },
  );
});

test('parseIosDeviceDetailsPayload reads direct and nested tunnel state', () => {
  assert.equal(
    parseIosDeviceDetailsPayload({
      result: { connectionProperties: { tunnelState: 'connected' } },
    }).tunnelState,
    'connected',
  );
  assert.equal(
    parseIosDeviceDetailsPayload({
      result: { device: { connectionProperties: { tunnelState: 'connecting' } } },
    }).tunnelState,
    'connecting',
  );
});

test('parseIosDeviceDetailsPayload reads direct and nested tunnel ip plus the info outcome', () => {
  // The runner's usbmux-unattached fallback resolves the tunnel ip through this
  // parser; the moved runner transport tests fake the control seam, so the real
  // devicectl payload shapes are pinned here instead.
  assert.deepEqual(
    parseIosDeviceDetailsPayload({
      info: { outcome: 'success' },
      result: { connectionProperties: { tunnelIPAddress: 'fdda::2', tunnelState: 'connected' } },
    }),
    { outcome: 'success', tunnelState: 'connected', tunnelIp: 'fdda::2' },
  );
  assert.equal(
    parseIosDeviceDetailsPayload({
      result: { device: { connectionProperties: { tunnelIPAddress: 'fdda::3' } } },
    }).tunnelIp,
    'fdda::3',
  );
  // The direct shape wins over the nested fallback when both are present.
  assert.equal(
    parseIosDeviceDetailsPayload({
      result: {
        connectionProperties: { tunnelIPAddress: 'fdda::2' },
        device: { connectionProperties: { tunnelIPAddress: 'fdda::9' } },
      },
    }).tunnelIp,
    'fdda::2',
  );
  assert.equal(
    parseIosDeviceDetailsPayload({ info: { outcome: 'failure' }, result: {} }).outcome,
    'failure',
  );
});

test('parseIosDeviceDetailsPayload ignores malformed values', () => {
  assert.deepEqual(parseIosDeviceDetailsPayload(null), {});
  assert.deepEqual(parseIosDeviceDetailsPayload({}), {});
  assert.deepEqual(
    parseIosDeviceDetailsPayload({
      result: { connectionProperties: { tunnelState: 123 } },
    }),
    {},
  );
});

test('parseIosDeviceDetailsPayload reads the developer mode toggle and the disk image apart', () => {
  // The capture is a device that is fine on both counts. Reading them apart is the point: a reader
  // that returns one boolean for both cannot tell "toggle off" from "Xcode has not finished".
  const captured = parseIosDeviceDetailsPayload(DEVICE_INFO_DETAILS_CAPTURE);
  assert.equal(captured.developerModeStatus, 'enabled');
  assert.equal(captured.developerDiskImageServicesAvailable, true);
  assert.equal(captured.outcome, 'success');

  assert.deepEqual(
    parseIosDeviceDetailsPayload({
      result: { deviceProperties: { developerModeStatus: 'disabled', ddiServicesAvailable: true } },
    }),
    { developerModeStatus: 'disabled', developerDiskImageServicesAvailable: true },
  );
  // The nested shape a `devicectl device list`-style envelope wraps the device in.
  assert.deepEqual(
    parseIosDeviceDetailsPayload({
      result: {
        device: {
          deviceProperties: { developerModeStatus: 'enabled', ddiServicesAvailable: false },
        },
      },
    }),
    { developerModeStatus: 'enabled', developerDiskImageServicesAvailable: false },
  );
  // `false` is a read answer and has to survive; an absent key must not become `false`.
  assert.equal(
    parseIosDeviceDetailsPayload({ result: { deviceProperties: { ddiServicesAvailable: false } } })
      .developerDiskImageServicesAvailable,
    false,
  );
  assert.equal(
    'developerDiskImageServicesAvailable' in
      parseIosDeviceDetailsPayload({ result: { deviceProperties: {} } }),
    false,
  );
});

test('parseIosDeviceDetailsPayload reads one field per fact and not the display mirror', () => {
  // `result.properties.state` mirrors the toggle in a structured form the tool renders for humans.
  // Reading it too would give two sources for one fact, so the mirror stays unread and a payload
  // that carries only the mirror reports nothing (#2683).
  assert.deepEqual(
    parseIosDeviceDetailsPayload({
      result: { properties: { state: { developerModeStatus: { enabled: { mode: 1 } } } } },
    }),
    {},
  );
});

test('parseIosDeviceDetailsPayload ignores malformed device states', () => {
  assert.deepEqual(
    parseIosDeviceDetailsPayload({
      result: { deviceProperties: { developerModeStatus: {}, ddiServicesAvailable: 'true' } },
    }),
    {},
  );
});

test('resolveIosReadyHint maps known connection errors', () => {
  assert.match(
    resolveIosReadyHint('', 'Device is busy (Connecting to iPhone)'),
    /still connecting/i,
  );
  assert.match(resolveIosReadyHint('CoreDeviceService timed out', ''), /coredevice service/i);
});

test('resolveIosReadyHint falls back to generic guidance', () => {
  const hint = resolveIosReadyHint('unexpected failure', '');
  assert.match(hint, /unlocked/i);
  assert.match(hint, /xcode/i);
});

/**
 * `readIosDeviceReadiness` asks the device the same question through the same payload. The reader
 * runs for real here, over the recorded capture, because the mistake #2683 fixes was made by a
 * reader that looked at one of these two states and answered for both.
 */

/**
 * Whether an iPhone will host development tooling is a fact the phone holds (#2683), and the
 * `devicectl` text path used to answer both of its states with one hint. These cases run the real
 * reader over recorded payloads: the state pair that must name the developer disk image is the pair
 * that used to send people to a Settings pane that was already correct.
 *
 * The payload identity fields are masked in the capture; the states the reader consumes are verbatim.
 */
const DEVICE_INFO_DETAILS_TEXT = fs.readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'ios-device-info-details.json'),
  'utf8',
);

const IOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  id: '00000000-0000-0000-0000-000000000001',
  name: 'iPhone',
  kind: 'device',
  appleOs: 'ios',
};

const XCTEST_IOS_DEVICE: DeviceInfo = { ...IOS_DEVICE, iosPhysicalDeviceBackend: 'xctest' };

/** The remedies a readable report publishes, spelled once so the assertions below stay readable. */
const DEVICE_REMEDIES = {
  developerModeOff: IOS_DEVICE_DEVELOPER_MODE_OFF_HINT,
  developerDiskImageUnavailable: IOS_DEVICE_DEVELOPER_DISK_IMAGE_HINT,
};

test('a device reporting its toggle on and its disk image up is ready', async () => {
  const calls: string[][] = [];
  const readiness = await readDeviceDetails(DEVICE_INFO_DETAILS_TEXT, calls);

  assert.deepEqual(readiness, {
    available: true,
    developerMode: 'enabled',
    developerDiskImage: 'available',
    remedies: DEVICE_REMEDIES,
  });
  assert.equal(calls.length, 1);
  const [cmd, ...args] = calls[0] ?? [];
  assert.equal(cmd, 'xcrun');
  assert.deepEqual(args.slice(0, 4), ['devicectl', 'device', 'info', 'details']);
  assert.ok(args.includes('--device') && args.includes(IOS_DEVICE.id));
  assert.ok(args.includes('--json-output') && args.includes('--timeout'));
});

test('a device reporting its toggle off says so, whatever its disk image says', async () => {
  const readiness = await readDeviceDetails(
    devicePropertiesPayload({ developerModeStatus: 'disabled', ddiServicesAvailable: false }),
  );

  assert.deepEqual(readiness, {
    available: true,
    developerMode: 'disabled',
    developerDiskImage: 'unavailable',
    remedies: DEVICE_REMEDIES,
  });
});

test('a device with its toggle on and its disk image down reports the image, not the toggle', async () => {
  const readiness = await readDeviceDetails(
    devicePropertiesPayload({ developerModeStatus: 'enabled', ddiServicesAvailable: false }),
  );

  assert.deepEqual(readiness, {
    available: true,
    developerMode: 'enabled',
    developerDiskImage: 'unavailable',
    remedies: DEVICE_REMEDIES,
  });
});

test('a device that answers with a spelling we do not know reports nothing', async () => {
  // Both fields present, neither recognised, and the same answer when the payload carries no device
  // properties at all: a toolchain that renames or stops sending a state must not be read as its
  // owner having switched something off.
  const readiness = await readDeviceDetails(
    devicePropertiesPayload({ developerModeStatus: 'notDetermined', ddiServicesAvailable: 'yes' }),
  );

  assert.deepEqual(readiness, {
    available: true,
    developerMode: 'unknown',
    developerDiskImage: 'unknown',
    remedies: DEVICE_REMEDIES,
  });
  assert.deepEqual(
    await readDeviceDetails(JSON.stringify({ info: { outcome: 'success' }, result: {} })),
    {
      available: true,
      developerMode: 'unknown',
      developerDiskImage: 'unknown',
      remedies: DEVICE_REMEDIES,
    },
  );
});

test('a device whose details cannot be read is reported unreadable rather than diagnosed', async () => {
  for (const payload of [
    'not json at all',
    '',
    JSON.stringify({ info: { outcome: 'failure' }, result: {} }),
  ]) {
    const readiness = await readDeviceDetails(payload);

    assert.equal(readiness.available, false);
    if (readiness.available) continue;
    assert.equal(readiness.reason, 'device_readiness_unreadable');
    // The hint offers a way to read the device, never a cause to fix.
    assert.match(readiness.hint, /devicectl device info details/);
    assert.doesNotMatch(readiness.hint, /Developer Mode/i);
  }
});

test('the device report carries the remedies the devicectl path already owns', async () => {
  // One wording per fix (#2683): the runner preflight publishes whatever arrives here, so this is the
  // only place the wording can be asserted once instead of at every site that shows it.
  const readiness = await readDeviceDetails(
    devicePropertiesPayload({ developerModeStatus: 'enabled', ddiServicesAvailable: false }),
  );

  assert.ok(readiness.available);
  assert.equal(readiness.remedies.developerModeOff, IOS_DEVICE_DEVELOPER_MODE_OFF_HINT);
  assert.equal(
    readiness.remedies.developerDiskImageUnavailable,
    IOS_DEVICE_DEVELOPER_DISK_IMAGE_HINT,
  );
});

test('an image complaint from a device that could not have answered is not a diagnosis', async () => {
  // `ddiServicesAvailable: false` with the tunnel down or the phone asleep means the developer disk
  // image services were not listening, not that device support is missing. Refusing the run on that
  // reading would send a self-healing first launch into a permanent "wait for Xcode" loop (#2683).
  const unobservable = [
    { bootState: 'asleep' },
    { tunnelState: 'unavailable' },
    { tunnelState: 'unavailable', bootState: 'asleep' },
  ];
  for (const context of unobservable) {
    const readiness = await readDeviceDetails(
      devicePropertiesPayload(
        { developerModeStatus: 'enabled', ddiServicesAvailable: false },
        context,
      ),
    );

    assert.equal(readiness.available, false);
    if (readiness.available) continue;
    assert.equal(readiness.reason, 'device_readiness_unreadable');
    // The reader says which observation is missing rather than naming a cause.
    assert.match(readiness.hint, /tunnelState=/);
    assert.match(readiness.hint, /bootState=/);
    assert.doesNotMatch(readiness.hint, /Let Xcode finish preparing/);
  }
});

test('a disabled toggle keeps its answer even from a sleeping device', async () => {
  // The exception that keeps the pairing honest: a toggle that is off already explains why the image
  // is down, and it comes from the paired record rather than from a live service, so it does not need
  // the device to be awake to be believed (#2683).
  const readiness = await readDeviceDetails(
    devicePropertiesPayload(
      { developerModeStatus: 'disabled', ddiServicesAvailable: false },
      { tunnelState: 'unavailable', bootState: 'asleep' },
    ),
  );

  assert.ok(readiness.available);
  assert.equal(readiness.developerMode, 'disabled');
  assert.equal(readiness.developerDiskImage, 'unavailable');
});

test('the committed capture holds no identity a real device would recognise', () => {
  // This payload was read off a real phone and is committed, so the fields that would identify that
  // one unit are masked while the states the reader consumes stay verbatim (#2683).
  const capture = DEVICE_INFO_DETAILS_CAPTURE as {
    result: {
      hardwareProperties: { serialNumber: string; ecid: number };
      deviceProperties: { bootedSnapshotName: string; developerModeStatus: string };
      connectionProperties: { tunnelIPAddress: string };
    };
  };
  const { hardwareProperties, deviceProperties, connectionProperties } = capture.result;

  assert.match(hardwareProperties.serialNumber, /MASKED/);
  assert.equal(hardwareProperties.ecid, 0);
  assert.match(deviceProperties.bootedSnapshotName, /MASKED/);
  assert.match(connectionProperties.tunnelIPAddress, /^fd00:/);
  // The states the reader consumes are the captured ones, masks and all.
  assert.equal(deviceProperties.developerModeStatus, 'enabled');
});

test('a device that fails the details command is unreadable, not unavailable', async () => {
  const readiness = await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (_cmd: string, args: string[]) => ({
        exitCode: args.includes('--json-output') ? 1 : 0,
        stdout: '',
        stderr: 'ERROR: The device could not be contacted.',
      }),
    }),
    async () => await readIosDeviceReadiness(IOS_DEVICE),
  );

  assert.equal(readiness.available, false);
});

test('a spent budget reads nothing and claims nothing', async () => {
  let toolCalls = 0;
  const readiness = await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async () => {
        toolCalls += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }),
    async () => await readIosDeviceReadiness(IOS_DEVICE, 0),
  );

  assert.equal(toolCalls, 0);
  assert.equal(readiness.available, false);
});

test('an XCTest-backed device reports that its readiness cannot be read', async () => {
  let toolCalls = 0;
  const readiness = await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async () => {
        toolCalls += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }),
    async () =>
      await resolveIosPhysicalDeviceControl(XCTEST_IOS_DEVICE).readDeviceReadiness(
        XCTEST_IOS_DEVICE,
      ),
  );

  assert.equal(toolCalls, 0);
  assert.equal(readiness.available, false);
  if (readiness.available) return;
  assert.equal(readiness.reason, 'device_readiness_unreadable');
  assert.match(readiness.hint, /XCTest/);
});

test('the CoreDevice backend publishes the device report', async () => {
  const readiness = await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (_cmd: string, args: string[]) => {
        const outputPath = jsonOutputPath(args);
        if (outputPath) fs.writeFileSync(outputPath, DEVICE_INFO_DETAILS_TEXT);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }),
    async () => await resolveIosPhysicalDeviceControl(IOS_DEVICE).readDeviceReadiness(IOS_DEVICE),
  );

  assert.equal(readiness.available, true);
  if (!readiness.available) return;
  assert.equal(readiness.developerMode, 'enabled');
  assert.equal(readiness.developerDiskImage, 'available');
});

test.each([
  [250, '5'],
  [4999, '5'],
  [5000, '5'],
  [5001, '6'],
  [10000, '10'],
])(
  'CoreDevice tunnel lookup keeps a %i ms host budget with CLI timeout %s',
  async (budget, cliTimeout) => {
    let observedCliTimeout: string | undefined;
    let observedHostTimeout: number | undefined;
    const tunnel = await withAppleToolProvider(
      createLocalAppleToolProvider({
        runCommand: async (_cmd, args, options) => {
          observedCliTimeout = args[args.indexOf('--timeout') + 1];
          observedHostTimeout = options?.timeoutMs;
          if (Number(observedCliTimeout) < IOS_DEVICECTL_MIN_TIMEOUT_SECONDS) {
            return {
              exitCode: 64,
              stdout: '',
              stderr: "Error: Please specify a 'timeout' value between 5 and 9223372036854775807",
            };
          }
          const outputPath = jsonOutputPath(args);
          if (outputPath) fs.writeFileSync(outputPath, DEVICE_INFO_DETAILS_TEXT);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
      async () =>
        await resolveIosPhysicalDeviceControl(IOS_DEVICE).resolveTunnel(IOS_DEVICE, budget),
    );

    assert.deepEqual(tunnel, { tunnelIp: 'fd00:0000:0000::1' });
    assert.equal(observedCliTimeout, cliTimeout);
    assert.equal(observedHostTimeout, budget);
  },
);

/**
 * A `deviceProperties` payload together with the context it was read in. Both default to the state a
 * developer disk image answer requires — tunnel up, phone booted — because #2683 treats that context
 * as part of the answer rather than as background: the same `false` from a sleeping or unreachable
 * device says the services were not listening. A caller that wants the weaker reading names it.
 */
function devicePropertiesPayload(
  deviceProperties: Record<string, unknown>,
  context: { tunnelState?: string; bootState?: string } = {},
): string {
  return JSON.stringify({
    info: { outcome: 'success' },
    result: {
      deviceProperties: {
        ...deviceProperties,
        bootState: deviceProperties.bootState ?? context.bootState ?? 'booted',
      },
      connectionProperties: { tunnelState: context.tunnelState ?? 'connected' },
    },
  });
}

async function readDeviceDetails(
  payload: string,
  calls: string[][] = [],
): Promise<IosDeviceReadiness> {
  return await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        const outputPath = jsonOutputPath(args);
        if (outputPath) fs.writeFileSync(outputPath, payload);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }),
    async () => await readIosDeviceReadiness(IOS_DEVICE),
  );
}

/**
 * `ensureCoreDeviceReady` asks the same details command as a timed probe and turns every way it can
 * fail into a typed COMMAND_FAILED with an actionable hint. The shapes below pin each normalizer
 * branch at the boundary that reaches it: a pass-through verdict, a tool failure, a killed timeout,
 * a successful run with unreadable JSON, and a failure that is not a probe at all.
 */
test('ensureCoreDeviceReady passes a connected device through', async () => {
  await withCoreDeviceProbe(
    () => readyPayload('connected'),
    async () => {
      await ensureCoreDeviceReady(IOS_DEVICE);
    },
  );
});

test('ensureCoreDeviceReady names the connecting tunnel state as the reason it refuses', async () => {
  const error = await expectReadyFailure(() => readyPayload('connecting'));
  assert.equal(error.details?.kind, 'not_ready');
  assert.equal(error.details?.tunnelState, 'connecting');
  assert.match(error.message, /not ready for automation/i);
});

test('ensureCoreDeviceReady reports a failed details command with the device hint', async () => {
  const error = await expectReadyFailure(() => ({
    exitCode: 1,
    stderr: 'ERROR: The device could not be contacted.',
  }));
  // The probe failed with a tool complaint, so the hint is the guidance for that text, not the
  // did-not-respond guidance a killed probe gets.
  assert.match(String(error.details?.hint), /trusted/i);
  assert.doesNotMatch(String(error.details?.hint), /did not respond/);
  assert.match(String(error.details?.stderr), /could not be contacted/);
});

test('ensureCoreDeviceReady names the developer mode hint a failing probe reports', async () => {
  // The hint on a failed probe comes from the tool's own text, and the two device failure states
  // keep separate wordings (#2683).
  const error = await expectReadyFailure(() => ({
    exitCode: 1,
    stderr: 'The operation failed because Developer Mode is disabled.',
  }));
  assert.match(String(error.details?.hint), /Enable Developer Mode/i);
});

test('ensureCoreDeviceReady turns a killed probe into the timeout hint', async () => {
  // exec's timeout error carries its own stdout/stderr/timeoutMs; with no output to read the
  // hint is the did-not-respond guidance naming the budget the probe ran under.
  const error = await expectReadyFailure(() => {
    throw new AppError('COMMAND_FAILED', 'xcrun timed out after 12345ms', {
      timeoutMs: 12345,
      stdout: '',
      stderr: '',
    });
  });
  assert.match(String(error.details?.hint), /did not respond within 12345ms/);
  assert.equal(error.details?.timeoutMs, 12345);
});

test('ensureCoreDeviceReady defaults the timeout hint to the ready budget when the error reports none', async () => {
  const error = await expectReadyFailure(() => {
    throw new AppError('COMMAND_FAILED', 'xcrun was killed', { stdout: '', stderr: '' });
  });
  assert.match(String(error.details?.hint), new RegExp(`within ${IOS_DEVICE_READY_TIMEOUT_MS}ms`));
});

test('ensureCoreDeviceReady reports a successful run without readable JSON as inconclusive', async () => {
  // The inner probe error says the JSON was invalid, but the normalizer rebuilds the hint from the
  // tool's own output, so what survives is the raw stdout and the guidance derived from it — not
  // the did-not-respond guidance reserved for a probe that never answered.
  const error = await expectReadyFailure(() => ({ stdout: 'not json at all' }));
  assert.equal(error.message, 'iOS device readiness probe failed');
  assert.equal(error.details?.stdout, 'not json at all');
  assert.match(String(error.details?.hint), /Xcode/i);
  assert.doesNotMatch(String(error.details?.hint), /did not respond/);
});

test('ensureCoreDeviceReady normalizes a failure that is not a command failure', async () => {
  // A provider that cannot run at all is not a verdict about the device: the error keeps its
  // cause but becomes the probe-failure shape with the reconnect hint.
  const cause = new AppError('INVALID_ARGS', 'simulator-set scope is required');
  const error = await expectReadyFailure(() => {
    throw cause;
  });
  assert.equal(error.message, 'iOS device readiness probe failed');
  assert.match(String(error.details?.hint), /reconnect/i);
  assert.equal(error.cause, cause);
});

test('ensureCoreDeviceReady keeps a plain error as the probe-failure cause', async () => {
  const cause = new Error('boom');
  const error = await expectReadyFailure(() => {
    throw cause;
  });
  assert.equal(error.cause, cause);
});

async function expectReadyFailure(answer: ReadyProbeAnswer): Promise<AppError> {
  let failure: unknown;
  try {
    await withCoreDeviceProbe(answer, async () => {
      await ensureCoreDeviceReady(IOS_DEVICE);
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof AppError, 'expected ensureCoreDeviceReady to fail');
  assert.equal(failure.code, 'COMMAND_FAILED');
  return failure;
}

function readyPayload(tunnelState: string): { exitCode: number; json: unknown } {
  return {
    exitCode: 0,
    json: {
      info: { outcome: 'success' },
      result: { connectionProperties: { tunnelState } },
    },
  };
}

type ReadyProbeAnswer = (
  args: string[],
) => { exitCode?: number; stdout?: string; stderr?: string; json?: unknown } | Error;

/**
 * One details-probe session with a scripted `xcrun devicectl` answer. A `json` key is written to
 * the `--json-output` path the probe asked for, exactly as devicectl does.
 */
async function withCoreDeviceProbe<T>(answer: ReadyProbeAnswer, run: () => Promise<T>): Promise<T> {
  return await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (_cmd, args) => {
        const response = answer(args);
        if (response instanceof Error) throw response;
        const { exitCode = 0, stdout = '', stderr = '', json } = response;
        const outputPath = jsonOutputPath(args);
        if (json !== undefined && outputPath) fs.writeFileSync(outputPath, JSON.stringify(json));
        return { exitCode, stdout, stderr };
      },
    }),
    run,
  );
}

function jsonOutputPath(args: string[]): string | undefined {
  const index = args.indexOf('--json-output');
  return index >= 0 ? args[index + 1] : undefined;
}
