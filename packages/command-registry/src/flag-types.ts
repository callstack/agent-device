import type { CliFlags, CommandFlags } from '@agent-device/contracts/command';

export type FlagKey = keyof CliFlags;
export type FlagType = 'boolean' | 'int' | 'number' | 'enum' | 'string' | 'booleanOrString';

/**
 * Keys a CLI token can carry but a dispatched command's `flags` never does, so a
 * recorded action has nowhere to put them. `recorded` is therefore locked to
 * `false` for these; the recorder indexes `CommandFlags`, and widening a CLI-only
 * key there would leak an uncarrable value (a `daemonAuthToken`, say) into a `.ad`.
 */
export type NonRecordableFlagKey = Exclude<FlagKey, keyof CommandFlags>;
/** The complement: a key the session recorder may copy into `SessionAction.flags`. */
export type RecordableFlagKey = Extract<FlagKey, keyof CommandFlags>;

type FlagDefinitionBody = {
  names: readonly string[];
  type: FlagType;
  multiple?: boolean;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  setValue?: CliFlags[FlagKey];
  usageLabel?: string;
  /**
   * Keeps this option out of generated command synopses while `usageLabel` still
   * renders it under `Command flags:`. Reserve it for cross-cutting opt-ins whose
   * synopsis bracket would read as noise on every command that accepts them.
   */
  usageHidden?: boolean;
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
};

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
 *
 * The union is the recorder's `recorded` constraint stated as a type: only a
 * `RecordableFlagKey` may set `recorded: true`, so the guard the old
 * `satisfies readonly (keyof CommandFlags)[]` list held lives on the declaration.
 */
export type FlagDefinition =
  | (FlagDefinitionBody & {
      key: RecordableFlagKey;
      /**
       * Whether the session recorder copies this key into `SessionAction.flags`.
       * Fail-closed by declaration: a recorded action carries only what a flag
       * explicitly opts into.
       */
      recorded: boolean;
    })
  | (FlagDefinitionBody & {
      key: NonRecordableFlagKey;
      /** A CLI-only key never reaches `CommandFlags`, so it is never recorded. */
      recorded: false;
    });

/** A declaration whose key the session recorder can carry, i.e. one that may set `recorded: true`. */
export type RecordableFlagDefinition = Extract<FlagDefinition, { key: RecordableFlagKey }>;
