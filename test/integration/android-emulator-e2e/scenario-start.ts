import assert from 'node:assert/strict';
import { assertWaitText } from './live-assertions.ts';
import { type LiveContext, runStep } from './live-harness.ts';

export type AndroidEmulatorScenarioStart = {
  ime: 'system' | 'test';
  landmark: string;
  url: string;
};

export async function prepareAndroidEmulatorScenario(
  context: LiveContext,
  start?: AndroidEmulatorScenarioStart,
): Promise<void> {
  if (context.sessionOpen) {
    await runStep(context, 'close prior scenario session', ['close']);
  }
  if (!start) return;

  await runStep(context, `open deterministic fixture route with ${start.ime} IME`, [
    'open',
    context.appId,
    '--relaunch',
    ...(start.ime === 'system' ? ['--no-test-ime'] : []),
    start.url,
  ]);
  const preflight = await runStep(context, 'preflight Android snapshot helper', ['snapshot', '-i']);
  assert.equal(preflight.json?.data?.androidSnapshot?.backend, 'android-helper');
  await assertWaitText(context, start.landmark);
}
