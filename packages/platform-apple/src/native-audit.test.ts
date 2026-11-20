import { expect, test } from 'vitest';
import {
  bindTestCommandHost,
  IOS_SIMULATOR,
  IOS_DEVICE,
  TVOS_SIMULATOR,
  MACOS_DEVICE,
} from '@agent-device/test-kit';
import { withAppleRunnerProvider } from '@agent-device/apple-runner';
import { recordingRunnerProvider } from './__tests__/recording-runner-provider.ts';
import { collectNativeAudit } from './native-audit.ts';
import { isRunnerServedIos } from './native-audit-support.ts';

bindTestCommandHost();

test('maps Apple audit types, descriptions and point geometry without snapshot refs', async () => {
  expect(
    await readNativeAudit({
      auditIssues: [
        {
          auditType: 'contrast',
          description: 'Insufficient contrast',
          rect: { x: 10.5, y: 23, width: 90, height: 12 },
        },
        { auditType: 'dynamicType', description: 'Text does not scale' },
        { auditType: 'unknown:8', description: 'A future audit' },
      ],
    }),
  ).toEqual([
    {
      source: 'native',
      kind: 'native',
      severity: 'warning',
      platform: 'ios',
      auditType: 'contrast',
      description: 'Insufficient contrast',
      rect: { x: 10.5, y: 23, width: 90, height: 12 },
    },
    {
      source: 'native',
      kind: 'native',
      severity: 'warning',
      platform: 'ios',
      auditType: 'dynamicType',
      description: 'Text does not scale',
    },
    {
      source: 'native',
      kind: 'native',
      severity: 'warning',
      platform: 'ios',
      auditType: 'unknown:8',
      description: 'A future audit',
    },
  ]);
  expect(await readNativeAudit({ auditIssues: [] })).toEqual([]);
});

test.each([
  {},
  { auditIssues: [null] },
  { auditIssues: [{ auditType: 'contrast' }] },
  {
    auditIssues: [
      {
        auditType: 'contrast',
        description: 'bad geometry',
        rect: { x: Number.NaN, y: 0, width: 1, height: 1 },
      },
    ],
  },
])('rejects malformed native audit results: %j', async (data) => {
  await expect(readNativeAudit(data)).rejects.toMatchObject({
    details: { reason: 'native-audit-invalid-result' },
  });
});

test.each([IOS_DEVICE, TVOS_SIMULATOR, MACOS_DEVICE])(
  'does not admit native audit without the iOS runner: $name',
  (device) => {
    expect(isRunnerServedIos(device)).toBe(false);
  },
);

test('admits simulator and physical iOS targets served by XCTest', () => {
  expect(isRunnerServedIos(IOS_SIMULATOR)).toBe(true);
  expect(isRunnerServedIos({ ...IOS_DEVICE, iosPhysicalDeviceBackend: 'xctest' })).toBe(true);
});

async function readNativeAudit(data: Record<string, unknown>) {
  return await withAppleRunnerProvider(
    recordingRunnerProvider([], { accessibilityAudit: data }),
    { deviceId: IOS_SIMULATOR.id },
    () => collectNativeAudit(IOS_SIMULATOR, {}, new AbortController().signal),
  );
}

test('preserves new runner type names as unknown issues', async () => {
  const findings = await readNativeAudit({
    auditIssues: [
      { auditType: 'futureAppleCheck', description: 'New check' },
      { auditType: 'unknown:1024', description: 'New SDK bit' },
    ],
  });
  expect(findings.map((finding) => finding.auditType)).toEqual([
    'unknown:futureAppleCheck',
    'unknown:1024',
  ]);
});
