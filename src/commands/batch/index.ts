import type { BatchRunOptions } from '../../client/client-types.ts';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { commonInputFromFlags } from '../cli-grammar/common.ts';
import type { CliReader } from '../cli-grammar/types.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { commonToClientOptions } from '../command-input.ts';
import { batchCliOutputFormatters } from './output.ts';
import { createBatchCommandMetadata, type BatchInput } from './metadata.ts';
import { createBatchDaemonWriter } from './projection.ts';

const batchCommandMetadata = createBatchCommandMetadata();

const batchCommandDefinition = defineExecutableCommand(batchCommandMetadata, (client, input) =>
  client.batch.run(toBatchOptions(input)),
);

const batchCliSchema = {
  usageOverride: 'batch [--steps <json> | --steps-file <path>]',
  listUsageOverride: 'batch --steps <json> | --steps-file <path>',
  helpDescription: 'Execute multiple commands in one daemon request',
  summary: 'Run multiple commands',
  allowedFlags: ['steps', 'stepsFile', 'batchOnError', 'batchMaxSteps', 'out'],
} as const satisfies CommandSchemaOverride;

const batchCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  steps: flags.batchSteps ?? [],
  onError: flags.batchOnError,
  maxSteps: flags.batchMaxSteps,
  out: flags.out,
});

const batchCommandFacet = defineCommandFacet({
  name: 'batch',
  metadata: batchCommandMetadata,
  definition: batchCommandDefinition,
  cliSchema: batchCliSchema,
  cliReader: batchCliReader,
  cliOutputFormatter: batchCliOutputFormatters.batch,
});

export const batchCommandFamily = defineCommandFamilyFromFacets({
  name: 'batch',
  clientSurface: false,
  commands: [batchCommandFacet],
});

export { createBatchDaemonWriter };
export type { BatchCommandName } from './projection.ts';

function toBatchOptions(input: BatchInput): BatchRunOptions {
  return {
    ...commonToClientOptions(input),
    steps: input.steps,
    onError: input.onError,
    maxSteps: input.maxSteps,
    out: input.out,
  };
}
