import { assertWaitText } from './live-assertions.ts';
import { type LiveContext, runStep } from './live-harness.ts';

export type AndroidEmulatorScenarioStart = {
  ime: 'system' | 'test';
  route: 'form' | 'home';
};

const ROUTES: Record<AndroidEmulatorScenarioStart['route'], { landmark: string; url: string }> = {
  form: {
    landmark: 'Checkout form',
    url: 'agent-device-test-app:///form',
  },
  home: {
    landmark: 'Agent Device Tester',
    url: 'agent-device-test-app:///',
  },
};

export async function prepareAndroidEmulatorScenario(
  context: LiveContext,
  start?: AndroidEmulatorScenarioStart,
): Promise<void> {
  if (context.sessionOpen) {
    await runStep(context, 'close prior scenario session', ['close']);
  }
  if (!start) return;

  await runStep(context, 'install cached fixture APK for isolated scenario', [
    'install',
    context.appPath,
  ]);
  const route = ROUTES[start.route];
  await runStep(context, `open ${start.route} with ${start.ime} IME`, [
    'open',
    context.appId,
    '--relaunch',
    ...(start.ime === 'system' ? ['--no-test-ime'] : []),
    route.url,
  ]);
  await assertWaitText(context, route.landmark);
}
