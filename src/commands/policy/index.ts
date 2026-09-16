import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import { AppError } from '@agent-device/kernel/errors';
import { commonInputFromFlags } from '../cli-grammar/common.ts';
import type { CliReader } from '../cli-grammar/types.ts';
import {
  enumField,
  numberField,
  requiredField,
  stringArrayField,
  stringField,
} from '../command-input.ts';
import { commonToClientOptions, type CommonCommandInput } from '../common-input-fields.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { DEFAULT_POLICY_MAX_STEPS, DEFAULT_POLICY_MIN_CONFIDENCE } from './act-loop.ts';
import { policyCliOutputFormatters } from './output.ts';
import {
  DEFAULT_POLICY_PROVIDER,
  JEV_API_KEY_ENV,
  POLICY_PROVIDER_NAMES,
} from './policy-provider.ts';
import { POLICY_INPUT_ENV_PREFIX } from './text-inputs.ts';

const SUGGEST_COMMAND_NAME = 'suggest';
const ACT_COMMAND_NAME = 'act';

const POLICY_PREAMBLE = `A policy head answers one question — which visible element advances the goal — as a typed decision with calibrated probabilities, in roughly the time a snapshot takes. It is optional: with no ${JEV_API_KEY_ENV} in the environment both commands refuse before touching the device, and nothing else changes.`;

const suggestDescription = `Ask a policy head which element to act on next, and print the decision without acting. ${POLICY_PREAMBLE}`;

const actDescription = `Run snapshot, decide, act until the policy reports the goal done, reports it blocked, or loses confidence. ${POLICY_PREAMBLE} Text is never generated. A field the policy chooses is filled from a caller-supplied entry keyed by that field's identifier or label, or from the matching environment entry when the value is a secret; a field with no entry escalates instead of being filled with a guess.`;

const goalField = requiredField(
  stringField('What the run should achieve, in one sentence, as the policy sees it.'),
);
const policyField = enumField(
  POLICY_PROVIDER_NAMES,
  `Policy head to ask. Default ${DEFAULT_POLICY_PROVIDER}.`,
);

export const suggestCommandMetadata = defineFieldCommandMetadata(
  SUGGEST_COMMAND_NAME,
  suggestDescription,
  { goal: goalField, policy: policyField },
);

export const actCommandMetadata = defineFieldCommandMetadata(ACT_COMMAND_NAME, actDescription, {
  goal: goalField,
  policy: policyField,
  maxSteps: numberField(`Stop after this many steps. Default ${DEFAULT_POLICY_MAX_STEPS}.`, {
    min: 1,
    max: 100,
  }),
  minConfidence: numberField(
    `Escalate instead of acting below this confidence. Default ${DEFAULT_POLICY_MIN_CONFIDENCE}.`,
    { min: 0, max: 1 },
  ),
  inputs: stringArrayField(
    'Text the loop may enter, as key=value. The key matches a field identifier or label.',
  ),
});

const suggestCliSchema = {
  usageOverride: 'suggest <goal> [--policy <name>]',
  usageFlags: [],
  listUsageOverride: 'suggest <goal>',
  positionalArgs: ['goal'],
  allowedFlags: ['policy'],
} as const satisfies CommandSchemaOverride;

const actCliSchema = {
  usageOverride:
    'act <goal> [--policy <name>] [--max-steps <n>] [--min-confidence <n>] [--input <key=value>]',
  usageFlags: [],
  listUsageOverride: 'act <goal>',
  positionalArgs: ['goal'],
  allowedFlags: ['policy', 'batchMaxSteps', 'minConfidence', 'policyInput'],
} as const satisfies CommandSchemaOverride;

export const suggestCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  goal: readGoal(positionals[0], SUGGEST_COMMAND_NAME),
  policy: flags.policy,
});

export const actCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  goal: readGoal(positionals[0], ACT_COMMAND_NAME),
  policy: flags.policy,
  maxSteps: flags.batchMaxSteps,
  minConfidence: flags.minConfidence,
  inputs: flags.policyInput,
});

type SuggestInput = CommonCommandInput & { goal: string; policy?: string };
type ActInput = SuggestInput & {
  maxSteps?: number;
  minConfidence?: number;
  inputs?: string[];
};

const suggestCommandFacet = defineCommandFacet({
  name: SUGGEST_COMMAND_NAME,
  text: {
    summary: 'Ask a policy head for the next element to act on',
    cliDetail: [
      `Prints the chosen ref, the probability it carries, and whether the policy considers the goal done or blocked. It never touches the device beyond one interactive snapshot, so it is safe to run repeatedly while checking a flow by hand.`,
      '',
      'Examples:',
      `  agent-device suggest "sign in with the test phone number"`,
      `  agent-device suggest "open the first item" --json`,
    ].join('\n'),
  },
  metadata: suggestCommandMetadata,
  run: (client, input) => client.policy.suggest(toSuggestOptions(input as SuggestInput)),
  cliSchema: suggestCliSchema,
  cliReader: suggestCliReader,
  cliOutputFormatter: policyCliOutputFormatters.suggest,
});

const actCommandFacet = defineCommandFacet({
  name: ACT_COMMAND_NAME,
  text: {
    summary: 'Drive a goal with a policy head until it is done or blocked',
    cliDetail: [
      `Each step snapshots, asks the policy, acts, and re-snapshots. An action that leaves the screen digest unchanged is recorded as a dead action; three unproductive steps in a row end the run as escalated. Per-step snapshot, decide, and action milliseconds are in the result, as is the policy token cost. Supply text with --input key=value, or keep a secret out of argv by exporting ${POLICY_INPUT_ENV_PREFIX}<KEY> instead.`,
      '',
      'Examples:',
      `  agent-device act "sign in and reach the main list" --input phone=5555550100 --max-steps 10`,
      `  agent-device act "open the first item" --min-confidence 0.6 --json`,
    ].join('\n'),
  },
  metadata: actCommandMetadata,
  run: (client, input) => client.policy.act(toActOptions(input as ActInput)),
  cliSchema: actCliSchema,
  cliReader: actCliReader,
  cliOutputFormatter: policyCliOutputFormatters.act,
});

export const policyCommandFamily = defineCommandFamilyFromFacets({
  name: 'policy',
  commands: [suggestCommandFacet, actCommandFacet],
});

function toSuggestOptions(input: SuggestInput) {
  return { ...commonToClientOptions(input), goal: input.goal, policy: input.policy };
}

function toActOptions(input: ActInput) {
  return {
    ...toSuggestOptions(input),
    maxSteps: input.maxSteps,
    minConfidence: input.minConfidence,
    inputs: input.inputs,
  };
}

function readGoal(value: string | undefined, command: string): string {
  const goal = value?.trim();
  if (!goal) {
    throw new AppError(
      'INVALID_ARGS',
      `${command} needs a goal, for example: ${command} "sign in"`,
    );
  }
  return goal;
}
