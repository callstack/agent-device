import type { CliFlags, FlagKey } from './cli-flags.ts';

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
