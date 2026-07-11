import type { CliFlags } from '../../contracts/cli-flags.ts';

export type { CliFlags, DaemonExcludedCliFlag } from '../../contracts/cli-flags.ts';

export type FlagKey = keyof CliFlags;
type FlagType = 'boolean' | 'int' | 'enum' | 'string' | 'booleanOrString';

export type FlagDefinition = {
  key: FlagKey;
  names: readonly string[];
  type: FlagType;
  multiple?: boolean;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  setValue?: CliFlags[FlagKey];
  usageLabel?: string;
  usageDescription?: string;
};
