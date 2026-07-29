import {
  assertCoverageComplete,
  cleanupSession,
  createContext,
  runScenario,
  sessionExists,
  writeCoverageReport,
} from './live-harness.ts';
import { ANDROID_EMULATOR_LIVE_SCENARIOS } from './scenarios.ts';

export async function runAndroidEmulatorE2E(): Promise<void> {
  const context = createContext();
  let primaryError: unknown;
  try {
    for (const scenario of ANDROID_EMULATOR_LIVE_SCENARIOS) {
      await runScenario(context, scenario);
    }
    assertCoverageComplete(context);
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    context.sessionOpen = context.sessionOpen || (await sessionExists(context));
    await cleanupSession(context);
  } catch (error) {
    cleanupError = error;
  }
  try {
    const reportPath = writeCoverageReport(context);
    console.log(`Android emulator coverage report: ${reportPath}`);
    console.log(`Android emulator live run: ${Date.now() - context.startedAtMs}ms`);
    for (const timing of context.timings) {
      console.log(`  ${timing.id}: ${timing.durationMs}ms`);
    }
  } catch (error) {
    cleanupError = cleanupError ?? error;
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'Android E2E failed and cleanup also failed',
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
}
