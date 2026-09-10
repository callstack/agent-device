import type { CliFlags } from '@agent-device/contracts/command';

export type FlagKey = keyof CliFlags;
export type FlagType = 'boolean' | 'int' | 'number' | 'enum' | 'string' | 'booleanOrString';

/**
 * One command option, declared once.
 *
 * This is where an option's CLI token, value type and value bounds live, and it
 * is also where its PROSE lives. An option has at most two audiences and they
 * are legitimately different lengths — `usageDescription` is the one-line
 * `--help` entry a CLI reader scans, `inputDescription` is the tool/SDK field
 * description a model or a TypeScript caller reads — but they are one fact with
 * one owner, stated side by side here so rewriting one is rewriting both. A
 * command's input field derives from this declaration through `optionField`;
 * a doc comment on `CliFlags`, on a public option type, or a second
 * `booleanField('…')` carrying the same sentence is a copy, not a declaration.
 */
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
  /** The `--help` audience: one line, command-prefixed. */
  usageDescription?: string;
  /**
   * The tool/SDK audience. Present iff a command derives its input field from
   * this option with `optionField`.
   */
  inputDescription?: string;
  /**
   * Whether the key may be set from a project `agent-device.json`. Fail-closed by
   * declaration, not by a list: a repository-controlled config may set a flag only
   * when this says so, so the compiler holds the property a hand-maintained
   * allowlist used to hold by omission. Omit it and the declaration will not
   * compile.
   */
  projectConfig: boolean;
  /**
   * Whether the session recorder copies this key into `SessionAction.flags`. Also
   * fail-closed by declaration: a recorded action carries only what a flag
   * explicitly opts into.
   */
  recorded: boolean;
};
