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
    longPress: () => unsupported('longPress'),
    focus: () => unsupported('focus'),
    type: () => unsupported('type'),
    fill: () => unsupported('fill'),
    scroll: () => unsupported('scroll'),
    screenshot: () => unsupported('screenshot'),
    snapshot: () => unsupported('snapshot'),
    back: () => unsupported('back'),
    setOrientation: () => unsupported('setOrientation'),
    tvRemote: () => unsupported('tvRemote'),
    readClipboard: () => unsupported('readClipboard'),
    writeClipboard: () => unsupported('writeClipboard'),
    setSetting: () => unsupported('setSetting'),
  };
}
