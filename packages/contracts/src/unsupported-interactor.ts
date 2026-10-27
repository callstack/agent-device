import { AppError } from '@agent-device/kernel/errors';
import type { Interactor } from './interactor-types.ts';

/**
 * The required `Interactor` surface an owner has not proven, refused one operation at a time.
 * A platform composes its interactor from this stub and overrides what its backend serves, so
 * what stays here is what that owner's runtime facts refuse. A refusal names the operation and
 * the caller's platform label and resolves nothing: a partial result would read as a successful
 * interaction over an untouched device. Optional members stay absent, never denied — the fused
 * double-click, the system buttons, the clipboard halves, and the TV remote ride fact-gated
 * binders, so an absent member is the owner's absence and a denial here would fake a mechanic.
 * The `Interactor` return type is the pin: a new required member fails to compile until this
 * stub refuses it too.
 */
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
    setSetting: () => unsupported('setSetting'),
  };
}
