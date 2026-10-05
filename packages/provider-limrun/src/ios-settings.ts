import type { SettingOptions } from '@agent-device/contracts/settings';
import { AppError, sessionAppRequiredDetails } from '@agent-device/kernel/errors';
import type { LimrunIosSession } from './ios.ts';

/**
 * Changes one setting on a Limrun iOS instance. `appearance`, `permission`, and `location` run the
 * Apple simctl plan on the instance's one simulator; `clear-app-state` uses Limrun's data reset,
 * because the local route edits the data container on the host.
 */
export async function setLimrunIosSetting(
  session: LimrunIosSession,
  setting: string,
  state: string,
  appId: string | undefined,
  options: SettingOptions | undefined,
): Promise<Record<string, unknown> | void> {
  const normalized = setting.toLowerCase();
  switch (normalized) {
    case 'appearance':
    case 'permission':
    case 'location':
      return await session.dependencies.ios.applySimctlSetting({
        runSimctl: (args) => runLimrunSimctl(session, args),
        udid: 'booted',
        setting: normalized,
        state,
        appBundleId:
          appId === undefined ? undefined : await session.dependencies.ios.resolveAppAlias(appId),
        options,
      });
    case 'clear-app-state':
      return await clearAppState(session, state, appId);
    default:
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        `Limrun iOS direct sessions support appearance, permission, location, and clear-app-state settings, not ${setting}.`,
        { command: 'settings' },
      );
  }
}

async function runLimrunSimctl(
  session: LimrunIosSession,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await session.client.simctl(args).wait();
  if (result.code !== 0) {
    throw new AppError('COMMAND_FAILED', `Limrun iOS simctl exited with code ${result.code}`, {
      args,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result;
}

async function clearAppState(
  session: LimrunIosSession,
  state: string,
  appId: string | undefined,
): Promise<Record<string, unknown>> {
  if (state.toLowerCase() !== 'clear') {
    throw new AppError('INVALID_ARGS', 'settings clear-app-state only supports clear.');
  }
  if (!appId) {
    throw new AppError(
      'INVALID_ARGS',
      'settings clear-app-state requires an app id or an active app session.',
      sessionAppRequiredDetails(),
    );
  }
  const bundleId = await session.dependencies.ios.resolveAppAlias(appId);
  try {
    await session.client.softReset(bundleId, { strategy: 'data' });
    // Limrun's reset relaunches the app. A local clear leaves it stopped, so stop it here too.
    await session.client.terminateApp(bundleId);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'COMMAND_FAILED',
      'Limrun iOS could not clear app state.',
      { setting: 'clear-app-state', bundleId },
      error,
    );
  }
  return { bundleId, cleared: true };
}
