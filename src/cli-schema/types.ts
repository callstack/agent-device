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
  // Swaps a shared flag's usageDescription for this command only, when the flag's generic
  // documentation (flag-definitions-*.ts) does not fit every command it is allowed on — for
  // example `--save-script` arms authoring on open/close but a repair transaction on replay.
  flagDescriptionOverrides?: Partial<Record<FlagKey, string>>;
};

export type CommandSchemaOverride = Partial<CommandSchema>;
