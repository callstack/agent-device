import { buildPrimaryEnvVarName } from '../utils/source-value.ts';

/**
 * Where an operator supplies a value that no model-facing surface may accept as
 * an argument. Declared beside the field it governs, so the refusal text is
 * rendered from the declaration instead of hand-written again in whichever
 * boundary happens to enforce it.
 */
export type OperatorInputSource =
  /**
   * Environment variables named after these CLI flag keys carry the value — the
   * input key itself when `envFlagKeys` is omitted — plus
   * `~/.agent-device/config.json` under the input key when `operatorConfig`.
   */
  | { envFlagKeys?: readonly [string, ...string[]]; operatorConfig?: boolean }
  /**
   * No environment variable (the `ENV_EXCLUDED_FLAG_KEYS` set in
   * `cli-schema/option-schema.ts`), so the config file is the only path.
   */
  | { envFlagKeys: readonly []; operatorConfig: true }
  /** Neither env nor config resolves it: the declaration states its own sentence. */
  | { operatorPath: string };

/**
 * Who may write an input key. An absent audience means the model — the default,
 * and the only audience a tool schema advertises.
 *
 * `operator` keys stay in the CLI and Node input schemas but are removed from
 * every model-facing tool schema and refused there: the model both reads
 * untrusted app UI text and picks tool arguments, so a screen that steers it
 * into writing a token, an endpoint, or an infrastructure path must find no
 * parameter to write it into. Operator-sourced values still flow in from env
 * and config outside the model-writable surface.
 *
 * `retired` keys are released keys that were removed. They are absent from
 * every schema but still recognized, so supplying one answers with migration
 * guidance instead of silently dropping the value or rejecting it as unknown.
 */
export type InputAudience =
  | { kind: 'operator'; source: OperatorInputSource }
  | { kind: 'retired'; message: string };

/** Non-model audiences by input key. Keys absent from the map are model-writable. */
export type InputAudienceMap = Readonly<Record<string, InputAudience>>;

export function operatorAudience(source: OperatorInputSource): InputAudience {
  return { kind: 'operator', source };
}

/** The refusal a model-facing surface answers with, rendered from the declared source. */
export function operatorInputRefusal(key: string, source: OperatorInputSource): string {
  return `${key} is not accepted as a tool argument. ${operatorPathSentence(key, source)}`;
}

function operatorPathSentence(key: string, source: OperatorInputSource): string {
  if ('operatorPath' in source) return source.operatorPath;
  const forTheServer = 'for the process serving these tools.';
  // The type admits an empty `envFlagKeys` only together with `operatorConfig`,
  // so a source can never render a sentence naming no path at all.
  const envNames = (source.envFlagKeys ?? [key]).map(buildPrimaryEnvVarName).join(' or ');
  if (envNames === '') return `Set ${key} in ~/.agent-device/config.json ${forTheServer}`;
  const configPath = source.operatorConfig ? ` (or ${key} in ~/.agent-device/config.json)` : '';
  return `Set the ${envNames} environment variable${configPath} ${forTheServer}`;
}
