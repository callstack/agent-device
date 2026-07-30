import { isDeepLinkTarget } from '../../contracts/open-target.ts';
import type { Interactor, RunnerContext } from '../../contracts/interactor-types.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { createUnsupportedInteractor } from '../unsupported-interactor.ts';
import { closeVegaApp, openVegaApp, openVegaDevice } from './app-lifecycle.ts';
import { pressVegaTvRemote } from './input-actions.ts';

type VegaOpenOptions = Parameters<Interactor['open']>[1];

const UNSUPPORTED_VEGA_OPEN_VARIANTS = [
  {
    matches: (app: string, options: VegaOpenOptions) =>
      isDeepLinkTarget(app) || Boolean(options?.url),
    message: 'Vega open does not support URLs or deep links.',
    hint: 'Use open <component-id> with an installed Vega app component ID.',
  },
  {
    matches: (_app: string, options: VegaOpenOptions) => Boolean(options?.activity),
    message: 'Vega open does not support Android activity selection.',
    hint: 'Remove --activity and use the Vega component ID as the open target.',
  },
  {
    matches: (_app: string, options: VegaOpenOptions) => Boolean(options?.launchConsole),
    message: 'Vega open does not support launch-console output.',
    hint: 'Remove --launch-console and open the Vega component ID directly.',
  },
  {
    matches: (_app: string, options: VegaOpenOptions) => Boolean(options?.terminateRunningApp),
    message: 'Vega open does not support terminating the running app before launch.',
    hint: 'Close the Vega component explicitly before opening it again.',
  },
  {
    matches: (_app: string, options: VegaOpenOptions) => Boolean(options?.launchArgs?.length),
    message: 'Vega open does not support launch arguments.',
    hint: 'Remove --launch-arg values and open the Vega component ID directly.',
  },
] as const;

export function createVegaInteractor(
  device: DeviceInfo,
  _runnerContext: RunnerContext,
): Interactor {
  return {
    ...createUnsupportedInteractor('Vega OS'),
    open: async (app, options) => {
      assertVegaOpenSupported(app, options);
      await openVegaApp(device, app);
    },
    openDevice: () => openVegaDevice(device),
    close: (app) => closeVegaApp(device, app),
    back: () => pressVegaTvRemote(device, 'back'),
    home: () => pressVegaTvRemote(device, 'home'),
    tvRemote: (button, durationMs) => pressVegaTvRemote(device, button, durationMs),
  };
}

function assertVegaOpenSupported(app: string, options?: VegaOpenOptions): void {
  const unsupportedVariant = UNSUPPORTED_VEGA_OPEN_VARIANTS.find(({ matches }) =>
    matches(app, options),
  );
  if (unsupportedVariant) {
    throw new AppError('UNSUPPORTED_OPERATION', unsupportedVariant.message, {
      hint: unsupportedVariant.hint,
    });
  }
}
