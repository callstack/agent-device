import { AppError } from '@agent-device/kernel/errors';
import { PROVIDER_PROFILE_FIELD_FLAGS } from '@agent-device/contracts/remote';

export function formFactor(flags?: Readonly<Record<string, unknown>>) {
  for (const [field, flag] of Object.entries(PROVIDER_PROFILE_FIELD_FLAGS)) {
    if (flags?.[field] !== undefined)
      throw new AppError('INVALID_ARGS', `ADC does not support ${flag}.`);
  }
  if (flags?.platform && flags.platform !== 'android')
    throw new AppError('INVALID_ARGS', 'ADC requires Android.');
  if (flags?.target === 'tv') return 'tv';
  if (flags?.target && flags.target !== 'mobile')
    throw new AppError('INVALID_ARGS', 'ADC supports mobile and TV targets.');
  return 'phone';
}
