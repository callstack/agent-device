import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { appleRunnerTestHost } from '../test-host.ts';
import type { IosDeviceRunnerReadiness, IosPhysicalDeviceRunnerControl } from '../host.ts';
import { assertDeviceReadinessForIosRunner } from '../runner-device-readiness.ts';
import { RUNNER_DEVICE_READINESS_FAILURE_REASONS } from '../runner-contract.ts';
import { IOS_DEVICE, IOS_SIMULATOR, MACOS_DEVICE } from './device-fixtures.ts';
import {
  deviceReadinessFixtures,
  type IosDeviceReadinessReport,
} from './runner-startup-failure-fixtures.ts';

/**
 * Whether an iPhone can host development tooling is a fact the phone holds, not a fact a build log
 * implies (#2683). `devicectl` output has always had one hint covering both "Developer Mode is
 * disabled" and "developer disk image" complaints and always named the toggle, which sent people to
 * a Settings pane that was already correct whenever the image was the actual obstacle.
 *
 * These cases drive the recorded device reports through the preflight and assert on what reaches the
 * caller, including the two reports that must never be confused for one another.
 */

const REPORTS = deviceReadinessFixtures();

/**
 * Remedies no other module could produce, so a hint matching one of them can only have come from the
 * report this test handed over. That is the claim #2683 has to keep: the preflight reads the wording
 * the device fact carries, which `core/devicectl.ts` owns, and never words a fix of its own beside it.
 */
const REMEDIES = {
  developerModeOff: 'FIX-DEVELOPER-MODE-TOGGLE',
  developerDiskImageUnavailable: 'FIX-DEVELOPER-DISK-IMAGE',
} as const;

const HINT_FOR_REASON = {
  device_developer_mode_disabled: REMEDIES.developerModeOff,
  device_developer_disk_image_unavailable: REMEDIES.developerDiskImageUnavailable,
} as const;

/** The budget `runner-session.ts` hands the probe: its slice of the startup budget and its signal. */
const BUDGET = { budgetMs: 10_000 } as const;

const readDeviceReadiness = vi.fn(
  (
    _device: DeviceInfo,
    _budgetMs?: number,
    _signal?: AbortSignal,
  ): Promise<IosDeviceRunnerReadiness> =>
    Promise.reject(new Error('this case records no device report')),
);

beforeEach(() => {
  readDeviceReadiness.mockReset();
  appleRunnerTestHost.update({
    resolveIosPhysicalDeviceControl: () => fakeDeviceControl(readDeviceReadiness),
  });
});

for (const fixture of REPORTS) {
  test(`a device reporting ${fixture.deviceReport.developerMode} mode and ${fixture.deviceReport.developerDiskImage} disk image publishes ${fixture.reason}`, async () => {
    readDeviceReadiness.mockResolvedValue(readableReport(fixture.deviceReport));

    const error = await expectRefusal(IOS_DEVICE);

    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(error.details?.reason, fixture.reason);
    assert.equal(error.details?.hint, HINT_FOR_REASON[fixture.reason]);
    assert.equal(error.details?.deviceId, IOS_DEVICE.id);
    // Both states travel with the reason, so a caller can see what the device said rather than only
    // which of the two this reader decided to name.
    assert.equal(error.details?.developerMode, fixture.deviceReport.developerMode);
    assert.equal(error.details?.developerDiskImage, fixture.deviceReport.developerDiskImage);
  });

  test(`the ${fixture.reason} reason reaches rendered CLI JSON`, async () => {
    readDeviceReadiness.mockResolvedValue(readableReport(fixture.deviceReport));

    const error = await expectRefusal(IOS_DEVICE);
    const rendered = JSON.parse(
      JSON.stringify({ success: false, error: normalizeError(error, { diagnosticId: 'diag-1' }) }),
    ) as { success: boolean; error: Record<string, any> };

    assert.equal(rendered.success, false);
    assert.equal(rendered.error.code, 'COMMAND_FAILED');
    assert.equal(rendered.error.details.reason, fixture.reason);
    // `normalizeError` lifts the hint out of `details`, so rendered JSON carries it at top level.
    assert.equal(rendered.error.hint, HINT_FOR_REASON[fixture.reason]);
    assert.equal(rendered.error.details.hint, undefined);
    assert.equal(rendered.error.diagnosticId, 'diag-1');
  });
}

test('a device whose report cannot be read is not given a reason', async () => {
  readDeviceReadiness.mockResolvedValue({
    available: false,
    reason: 'device_readiness_unreadable',
    hint: 'Read the device state directly with `xcrun devicectl device info details`.',
  } satisfies IosDeviceRunnerReadiness);

  await assert.doesNotReject(() => assertDeviceReadinessForIosRunner(IOS_DEVICE, BUDGET));
});

test('a device reporting both states healthy is not a failure', async () => {
  readDeviceReadiness.mockResolvedValue(
    readableReport({ developerMode: 'enabled', developerDiskImage: 'available' }),
  );

  await assert.doesNotReject(() => assertDeviceReadinessForIosRunner(IOS_DEVICE, BUDGET));
});

test('a device that reports neither state is not read as accusing its owner', async () => {
  // A toolchain that spells these fields differently, or omits one, earns no verdict. Reading
  // "unknown" as "off" is how a version bump turns into a claim about someone's Settings (#2683).
  readDeviceReadiness.mockResolvedValue(
    readableReport({ developerMode: 'unknown', developerDiskImage: 'unknown' }),
  );

  await assert.doesNotReject(() => assertDeviceReadinessForIosRunner(IOS_DEVICE, BUDGET));
});

test('an unavailable disk image on a device with Developer Mode on is never named as the toggle', async () => {
  // The conflation #2682 answered with "enable Developer Mode" for a device that had it on. The
  // unread half of the states has to stay unread too: only the image may be named here.
  for (const developerMode of ['enabled', 'unknown'] as const) {
    readDeviceReadiness.mockResolvedValue(
      readableReport({ developerMode, developerDiskImage: 'unavailable' }),
    );

    const error = await expectRefusal(IOS_DEVICE);

    assert.equal(error.details?.reason, 'device_developer_disk_image_unavailable');
    // Only the image remedy may be published: the toggle remedy mentions the Settings pane.
    assert.doesNotMatch(String(error.details?.hint), /Privacy & Security/);
  }
});

test('a device with Developer Mode off names the toggle even when the image is down too', async () => {
  // The direction that does hold: the toggle explains the image, so naming the toggle is the claim
  // that leaves the reader with one thing to fix.
  readDeviceReadiness.mockResolvedValue(
    readableReport({ developerMode: 'disabled', developerDiskImage: 'unavailable' }),
  );

  const error = await expectRefusal(IOS_DEVICE);

  assert.equal(error.details?.reason, 'device_developer_mode_disabled');
});

test('a simulator or the desktop target never asks the device', async () => {
  for (const device of [IOS_SIMULATOR, MACOS_DEVICE]) {
    await assert.doesNotReject(() => assertDeviceReadinessForIosRunner(device, BUDGET));
  }

  assert.equal(readDeviceReadiness.mock.calls.length, 0);
});

test('every device-readiness reason has a recorded device report', () => {
  const reasonsWithReports = new Set(REPORTS.map((fixture) => fixture.reason));

  assert.equal(reasonsWithReports.size, RUNNER_DEVICE_READINESS_FAILURE_REASONS.length);
  for (const reason of RUNNER_DEVICE_READINESS_FAILURE_REASONS) {
    assert.ok(reasonsWithReports.has(reason), `no device report records the ${reason} reason`);
  }
});

test('the probe is bounded by the startup budget it runs inside', async () => {
  // A preflight that ignores the budget it was given can outlive the command that started it, which
  // is how a cancelled `prepare` ends up building anyway (#2683).
  const controller = new AbortController();
  readDeviceReadiness.mockResolvedValue(
    readableReport({ developerMode: 'enabled', developerDiskImage: 'available' }),
  );

  await assertDeviceReadinessForIosRunner(IOS_DEVICE, {
    budgetMs: 2_500,
    signal: controller.signal,
  });

  assert.deepEqual(readDeviceReadiness.mock.lastCall?.[1], 2_500);
  assert.equal(readDeviceReadiness.mock.lastCall?.[2], controller.signal);
});

test('a budget that ran out during the probe stops the startup even on a healthy device', async () => {
  // The read returning just as the caller gave up is not permission to keep going: nobody is waiting
  // for a build that cannot be delivered (#2683).
  const controller = new AbortController();
  readDeviceReadiness.mockImplementation(() => {
    controller.abort();
    return Promise.resolve(
      readableReport({ developerMode: 'enabled', developerDiskImage: 'available' }),
    );
  });

  await assert.rejects(
    () =>
      assertDeviceReadinessForIosRunner(IOS_DEVICE, {
        budgetMs: 10_000,
        signal: controller.signal,
      }),
    (error: unknown) => (error as Error).name === 'AbortError',
  );
});

function readableReport(
  report: IosDeviceReadinessReport,
): Extract<IosDeviceRunnerReadiness, { available: true }> {
  return { available: true, ...report, remedies: REMEDIES };
}

async function expectRefusal(device: DeviceInfo): Promise<AppError> {
  let caught: unknown;
  await assert.rejects(
    () => assertDeviceReadinessForIosRunner(device, BUDGET),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.ok(caught instanceof AppError, 'the preflight must refuse with an AppError');
  return caught;
}

function fakeDeviceControl(read: typeof readDeviceReadiness): IosPhysicalDeviceRunnerControl {
  return {
    backend: 'coredevice',
    resolveTunnel: async () => ({ tunnelIp: null }),
    readDeviceReadiness: read,
  };
}
