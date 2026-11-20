import { expect, test } from 'vitest';
import {
  assertProducedRunnerRequests,
  bindTestCommandHost,
  IOS_SIMULATOR,
} from '@agent-device/test-kit';
import { withAppleRunnerProvider } from '@agent-device/apple-runner';
import {
  recordingRunnerProvider,
  type RecordedRunnerCall,
} from './__tests__/recording-runner-provider.ts';
import { collectNativeAudit } from './native-audit.ts';

bindTestCommandHost();

test('sends the native audit through the runner transport with app scope and cancellation', async () => {
  const calls: RecordedRunnerCall[] = [];
  const controller = new AbortController();
  const findings = await withAppleRunnerProvider(
    recordingRunnerProvider(calls, {
      accessibilityAudit: { auditIssues: [{ auditType: 'textClipped', description: 'Clipped' }] },
    }),
    { deviceId: IOS_SIMULATOR.id, requestId: 'audit-request' },
    () =>
      collectNativeAudit(
        IOS_SIMULATOR,
        {
          appBundleId: 'com.example.app',
          requestId: 'audit-request',
        },
        controller.signal,
      ),
  );
  expect(findings[0]).toMatchObject({ source: 'native', auditType: 'textClipped' });
  expect(calls[0]?.options.requestId).toBe('audit-request');
  expect(calls[0]?.options.signal).toBe(controller.signal);
  assertProducedRunnerRequests(import.meta.filename, [
    ['ios-simulator.native-audit', calls[0]!.command],
  ]);
});
