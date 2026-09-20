import { AppError } from '@agent-device/kernel/errors';
import type { Interactor } from '@agent-device/contracts/interactor-types';

export function createUnsupportedInteractor(platformLabel: string): Interactor {
  const unsupported = async (operation: string): Promise<never> => {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `${operation} is not supported on ${platformLabel}`,
    );
  };

  return {
    open: () => unsupported('open'),
    openDevice: () => unsupported('openDevice'),
    close: () => unsupported('close'),
    tap: () => unsupported('tap'),
    doubleTap: () => unsupported('doubleTap'),
    longPress: () => unsupported('longPress'),
    focus: () => unsupported('focus'),
    type: () => unsupported('type'),
    fill: () => unsupported('fill'),
    scroll: () => unsupported('scroll'),
    screenshot: () => unsupported('screenshot'),
    snapshot: () => unsupported('snapshot'),
    back: () => unsupported('back'),
    home: () => unsupported('home'),
    setOrientation: () => unsupported('setOrientation'),
    appSwitcher: () => unsupported('appSwitcher'),
    tvRemote: () => unsupported('tvRemote'),
    readClipboard: () => unsupported('readClipboard'),
    writeClipboard: () => unsupported('writeClipboard'),
    setSetting: () => unsupported('setSetting'),
    readAlert: () => unsupported('readAlert'),
    awaitAlert: () => unsupported('awaitAlert'),
    acceptAlert: () => unsupported('acceptAlert'),
    dismissAlert: () => unsupported('dismissAlert'),
  };
}
