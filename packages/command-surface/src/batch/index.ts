import type { BatchRunOptions } from '@agent-device/contracts/client';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import { commonInputFromFlags } from '../cli-grammar/common.ts';
import type { CliReader } from '../cli-grammar/types.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { commonToClientOptions } from '../common-input-fields.ts';
import { createBatchCommandMetadata, type BatchCommandStep, type BatchInput } from './metadata.ts';
import { STRUCTURED_BATCH_COMMAND_NAMES } from '@agent-device/command-registry/batch-policy';

const batchCommandMetadata = createBatchCommandMetadata();

const batchCliSchema = {
  usageOverride: 'batch [--steps <json> | --steps-file <path>]',
  usageFlags: [],
  listUsageOverride: 'batch --steps <json> | --steps-file <path>',
  allowedFlags: ['steps', 'stepsFile', 'batchOnError', 'batchMaxSteps', 'out'],
} as const satisfies CommandSchemaOverride;

const batchCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  steps: flags.batchSteps ?? [],
  onError: flags.batchOnError,
  maxSteps: flags.batchMaxSteps,
  out: flags.out,
});

/**
 * The step examples `help batch` prints. A step's `input` is keyed by the command's structured
 * field names, which no CLI help text spells out — `help press` documents the positional and the
 * flags, not `ref` or `selector` — so these lines are the only place the terminal states them.
 * `cli-help-examples.test.ts` reads them back out of the rendered help and runs each `input`
 * through its own command's `readInput`, so a renamed field fails there instead of shipping an
 * example nobody can run (#2062).
 */
const BATCH_STEP_EXAMPLES: readonly BatchCommandStep[] = [
  { command: 'press', input: { ref: '@e12', settle: true } },
  { command: 'press', input: { selector: 'label=Settings', settle: true } },
  { command: 'fill', input: { selector: 'id="field-email"', text: 'qa@example.com' } },
  { command: 'scroll', input: { direction: 'down', until: 'label=Privacy', settle: true } },
  { command: 'back', input: { settle: true } },
  { command: 'wait', input: { kind: 'text', text: 'Saved' } },
  { command: 'snapshot', input: { interactiveOnly: true } },
];

/**
 * The MCP description: a model batches a walk it already knows from this text alone, without
 * loading each step command's schema. The step examples are the same tested ones `help batch` prints.
 */
const BATCH_MCP_DETAIL = [
  'Use it for a known multi-step walk, such as press A, press B, back, instead of one tool call per step.',
  "steps is an array of {command, input} objects; input takes the same arguments as that command's own tool (ref, selector, or x and y for targets; settle: true for the settled diff).",
  'Steps run serially in one session; onError: "stop" halts at the first failing step, and the result reports the steps that ran.',
  'The whole batch has a 60-second work budget; split longer walks.',
  `Example steps, in order (refs such as @e12 come from the last snapshot or settled diff): ${BATCH_STEP_EXAMPLES.map((step) => JSON.stringify(step)).join(', ')}.`,
].join(' ');

/**
 * `help batch` documented neither the step shape nor which commands batch accepts, so an agent
 * discovered both by trial: `["press @e12"]` and `{"command":"press","args":[...]}` were refused
 * without either being named (#2062). The accepted set is RENDERED from the command-descriptor
 * registry's `batchable` trait, so it cannot drift from what the runtime allowlist enforces.
 */
function buildBatchCliDetail(): string {
  const prose = [
    'Each step is {"command":"<name>","input":{...}}, and input is that command\'s structured input object rather than its terminal spelling: a CLI positional becomes a named field (for example ref, label, selector, x, y, text, direction) and a CLI flag becomes a camelCase key (--settle -> "settle":true, -i -> "interactiveOnly":true). There is no positional step form; args, argv, positionals, and flags are not step fields. agent-device help <command> lists arguments in CLI spelling only. The examples below carry the structured spelling; over MCP, the command tool schema states it in full.',
    'Steps run serially in one daemon request against the same session, in order. Mutating UI verbs are included (press, click, fill, longpress, scroll, back), which is where the round-trip saving is; --on-error stop halts at the first failing step.',
    'The whole batch has a 60-second work budget inside a 90-second client timeout. The running step receives ordinary request cancellation at the budget. When it settles, failure returns COMMAND_FAILED with details.reason daemon_request_timeout and preserves executed, partialResults, and dispatch status. The daemon and other sessions stay available if it responds; a close step may already have ended its session. A completed batch returns success even if it settles just after the deadline. Cancellation does not prove native device work stopped. A step that ignores cancellation beyond the 30-second margin may cause a transport timeout; an unresponsive daemon retains the client liveness-based reset. Split longer sequences into separate requests.',
    `Available through batch: ${[...STRUCTURED_BATCH_COMMAND_NAMES].sort().join(', ')}.`,
    'Every other command is excluded: batch and replay never nest, and session, daemon, connection, and host tooling commands own lifecycle a batch request cannot carry. Run those on their own.',
  ].join(' ');
  const examples = [
    `  agent-device batch --steps '${JSON.stringify(BATCH_STEP_EXAMPLES)}'`,
    '  agent-device batch --steps-file ./steps.json --json',
  ].join('\n');
  return `${prose}\n\nExamples:\n${examples}`;
}

const batchCommandFacet = defineCommandFacet({
  name: 'batch',
  effect: 'destructive',
  text: {
    summary: 'Run multiple commands',
    mcpDetail: BATCH_MCP_DETAIL,
    searchHint: 'sequence chain several taps',
    cliDetail: buildBatchCliDetail(),
  },
  metadata: batchCommandMetadata,
  run: (client, input) => client.batch.run(toBatchOptions(input)),
  cliSchema: batchCliSchema,
  cliReader: batchCliReader,
});

export const batchCommandFamily = defineCommandFamilyFromFacets({
  name: 'batch',
  clientSurface: false,
  commands: [batchCommandFacet],
});

function toBatchOptions(input: BatchInput): BatchRunOptions {
  return {
    ...commonToClientOptions(input),
    steps: input.steps,
    onError: input.onError,
    maxSteps: input.maxSteps,
    out: input.out,
  };
}
