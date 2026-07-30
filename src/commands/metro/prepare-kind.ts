import { AppError } from '@agent-device/kernel/errors';
import type { MetroPrepareKind } from '../../contracts/metro.ts';

const METRO_PREPARE_KIND_VALUES: readonly MetroPrepareKind[] = [
  'auto',
  'react-native',
  'expo',
  'repack',
];

export function readMetroPrepareKind(value: string | undefined): MetroPrepareKind | undefined {
  if (value === undefined) return undefined;
  if ((METRO_PREPARE_KIND_VALUES as readonly string[]).includes(value)) {
    return value as MetroPrepareKind;
  }
  throw new AppError(
    'INVALID_ARGS',
    'metro prepare --kind must be auto, react-native, expo, or repack',
  );
}
