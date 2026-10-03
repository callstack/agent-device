import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { appleRunnerTestHost } from '../test-host.ts';
import type { IosPhysicalDeviceRunnerControl } from '../../core/physical-device-routing.ts';
import type { IosDeviceReadiness } from '../host.ts';
import { preflightIosRunnerDeviceReadiness } from '../runner-device-readiness.ts';
import { RUNNER_DEVICE_READINESS_FAILURE_REASONS } from '../runner-error-classification.ts';
import { IOS_DEVICE, IOS_SIMULATOR, MACOS_DEVICE } from './device-fixtures.ts';
import {
  deviceReadinessFixtures,
  type IosDeviceReadinessFixture,
  type IosDeviceReadinessReport,
} from './runner-startup-failure-fixtures.ts';

/**
 * Whether an iPhone can host development tooling is a fact the phone holds, not a fact a build log
 * implies (#2683). `devicectl` output has always had one hint covering both "Developer Mode is
 * disabled" and "developer disk image" complaints and always named the toggle, which sent people to
 * a Settings pane that was already correct whenever the image was the actual obstacle.
 *
 * Only one of those two states may stop a run before the build. The toggle is owner-only and no later
 * step turns it on; the developer disk image is mounted on demand by CoreDevice during build and
 * launch since iOS 17, so a phone that has just been rebooted reports it down while the very next build
 * clears it (#2683 review). These cases drive the recorded device reports through the preflight and
 * assert which one refuses, which one is carried forward, and that the two are never confused.
 */

const REPORTS = deviceReadinessFixtures();

/** The one report the preflight is allowed to refuse a build for: the owner's toggle. */
const REFUSALS = REPORTS.filter(
  (fixture): fixture is IosDeviceReadinessFixture =>
    fixture.reason === 'device_developer_mode_disabled',
);

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
  (_device: DeviceInfo, _budgetMs?: number, _signal?: AbortSignal): Promise<IosDeviceReadiness> =>
    Promise.reject(new Error('this case records no device report')),
);

beforeEach(() => {
  readDeviceReadiness.mockReset();
  appleRunnerTestHost.update({
    resolveIosPhysicalDeviceControl: () => fakeDeviceControl(readDeviceReadiness),
  });
});

for (const fixture of REFUSALS) {
  test(`a device reporting ${fixture.deviceReport.developerMode} mode refuses the run with ${fixture.reason}`, async () => {
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

for (const fixture of REPORTS.filter((f) => f.reason !== 'device_developer_mode_disabled')) {
  test(`a device reporting ${fixture.deviceReport.developerDiskImage} disk image with ${fixture.deviceReport.developerMode} mode builds anyway`, async () => {
    // The refusal #2683 shipped with was wrong here (#2683 review): iOS 17+ mounts the image on demand
    // during build and launch, so this state has to reach the build rather than stop it.
    readDeviceReadiness.mockResolvedValue(readableReport(fixture.deviceReport));

    await assert.doesNotReject(() => preflightIosRunnerDeviceReadiness(IOS_DEVICE, BUDGET));
  });

  test(`the ${fixture.reason} report is carried forward for the failure it explains`, async () => {
    readDeviceReadiness.mockResolvedValue(readableReport(fixture.deviceReport));

    const states = await preflightIosRunnerDeviceReadiness(IOS_DEVICE, BUDGET);

    assert.deepEqual(states, {
      developerMode: fixture.deviceReport.developerMode,
      developerDiskImage: fixture.deviceReport.developerDiskImage,
      developerDiskImageHint: REMEDIES.developerDiskImageUnavailable,
    });
  });
}

test('a device whose report cannot be read is not given a reason', async () => {
  readDeviceReadiness.mockResolvedValue({
    available: false,
    reason: 'device_readiness_unreadable',
    hint: 'Read the device state directly with `xcrun devicectl device info details`.',
  } satisfies IosDeviceReadiness);

  await assert.doesNotReject(() => preflightIosRunnerDeviceReadiness(IOS_DEVICE, BUDGET));
});

test('a device whose report cannot be read carries no state forward', async () => {
  // Nothing was read, so nothing may be claimed later (#2683).
  readDeviceReadiness.mockResolvedValue({
    available: false,
    reason: 'device_readiness_unreadable',
    hint: 'Read the device state directly with `xcrun devicectl device info details`.',
  } satisfies IosDeviceReadiness);

  assert.equal(await preflightIosRunnerDeviceReadiness(IOS_DEVICE, BUDGET), undefined);
});

test('a device reporting both states healthy is not a failure and carries an available image', async () => {
  readDeviceReadiness.mockResolvedValue(
    readableReport({ developerMode: 'enabled', developerDiskImage: 'available' }),
  );

  const states = await preflightIosRunnerDeviceReadiness(IOS_DEVICE, BUDGET);

  assert.equal(states?.developerDiskImage, 'available');
});

test('a device that reports neither state is not read as accusing its owner', async () => {
  // A toolchain that spells these fields differently, or omits one, earns no verdict. Reading
  // "unknown" as "off" is how a version bump turns into a claim about someone's Settings (#2683).
  readDeviceReadiness.mockResolvedValue(
    readableReport({ developerMode: 'unknown', developerDiskImage: 'unknown' }),
  );

  await assert.doesNotReject(() => preflightIosRunnerDeviceReadiness(IOS_DEVICE, BUDGET));
});

test('an unavailable disk image on a device with Developer Mode on is never named as the toggle', async () => {
  // The conflation #2682 answered with "enable Developer Mode" for a device that had it on. The
  // unread half of the states has to stay unread too: only the image may be named here.
  for (const developerMode of ['enabled', 'unknown'] as const) {
    readDeviceReadiness.mockResolvedValue(
      readableReport({ developerMode, developerDiskImage: 'unavailable' }),
    );

    const states = await preflightIosRunnerDeviceReadiness(IOS_DEVICE, BUDGET);

    assert.equal(states?.developerDiskImage, 'unavailable');
    // Only the image remedy may be carried: the toggle remedy mentions the Settings pane.
    assert.doesNotMatch(String(states?.developerDiskImageHint), /Privacy & Security/);
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
    await assert.doesNotReject(() => preflightIosRunnerDeviceReadiness(device, BUDGET));
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

  await preflightIosRunnerDeviceReadiness(IOS_DEVICE, {
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
      preflightIosRunnerDeviceReadiness(IOS_DEVICE, {
        budgetMs: 10_000,
        signal: controller.signal,
      }),
    (error: unknown) => (error as Error).name === 'AbortError',
  );
});

function readableReport(
  report: IosDeviceReadinessReport,
): Extract<IosDeviceReadiness, { available: true }> {
  return { available: true, ...report, remedies: REMEDIES };
}

async function expectRefusal(device: DeviceInfo): Promise<AppError> {
  let caught: unknown;
  await assert.rejects(
    () => preflightIosRunnerDeviceReadiness(device, BUDGET),
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
