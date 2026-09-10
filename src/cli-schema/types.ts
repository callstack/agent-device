import type { FlagKey } from '../commands/cli-grammar/flag-types.ts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { CommandText } from '../commands/command-text.ts';

/**
 * Command grammar plus its resolved text. Prose lives entirely in `text`; everything else here
 * describes what the parser accepts, so no field is both authored and generated.
 */
export type CommandSchema = {
  text: CommandText;
  positionalArgs?: readonly string[];
  allowsExtraPositionals?: boolean;
  allowedFlags?: readonly FlagKey[];
  supportedFlags?: readonly FlagKey[];
  defaults?: Partial<CliFlags>;
  /**
   * Replaces the generated synopsis grammar in `--help`, for shapes the generator cannot express.
   * The flag tail after it stays generated from `usageFlags`, so this string never restates the
   * command's option list; a bracket it writes itself must be declared out of that tail.
   */
  usageOverride?: string;
  /**
   * The options the synopsis names in its `[label]` flag tail; defaults to `allowedFlags`. Declare
   * `[]` when the synopsis is pure grammar (or writes its own mutually-exclusive brackets) and the
   * `Command flags:` section is the option list. Affects the synopsis only: every option in
   * `allowedFlags` is documented and parsed regardless.
   */
  usageFlags?: readonly FlagKey[];
  /** Replaces the generated synopsis in the command list, which stays terser than `--help`. */
  listUsageOverride?: string;
  // Swaps a shared flag's usageDescription for this command only, when the flag's generic
  // documentation (flag-definitions-*.ts) does not fit every command it is allowed on — for
  // example `--save-script` arms authoring on open/close but a repair transaction on replay.
  flagDescriptionOverrides?: Partial<Record<FlagKey, string>>;
};

/** Grammar a facet may override. Its prose is authored as the facet's `text`, never here. */
export type CommandSchemaOverride = Partial<Omit<CommandSchema, 'text'>>;
