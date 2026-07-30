import type { FlagKey } from '../commands/cli-grammar/flag-types.ts';
import type { CliFlags } from '@agent-device/contracts/command';

export type CommandSchema = {
  helpDescription: string;
  summary?: string;
  positionalArgs?: readonly string[];
  allowsExtraPositionals?: boolean;
  allowedFlags?: readonly FlagKey[];
  supportedFlags?: readonly FlagKey[];
  defaults?: Partial<CliFlags>;
  usageOverride?: string;
  listUsageOverride?: string;
};

export type CommandSchemaOverride = Partial<CommandSchema>;
