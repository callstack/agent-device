import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { AppPushOptions, AppTriggerEventOptions } from '../../client-types.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import {
  jsonSchemaField,
  looseObjectField,
  looseObjectSchema,
  requiredField,
  stringField,
  stringSchema,
} from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import {
  commonInputFromFlags,
  direct,
  readJsonObject,
  requiredString,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const pushCommandMetadata = defineFieldCommandMetadata('push', 'Deliver a push payload.', {
  app: requiredField(stringField()),
  payload: requiredField(
    jsonSchemaField<string | Record<string, unknown>>({
      oneOf: [stringSchema(), looseObjectSchema()],
    }),
  ),
});

const triggerAppEventCommandMetadata = defineFieldCommandMetadata(
  'trigger-app-event',
  'Trigger an app-defined event.',
  {
    event: requiredField(stringField()),
    payload: looseObjectField(),
  },
);

const pushCommandDefinition = defineExecutableCommand(pushCommandMetadata, (client, input) =>
  client.apps.push(input),
);

const triggerAppEventCommandDefinition = defineExecutableCommand(
  triggerAppEventCommandMetadata,
  (client, input) => client.apps.triggerEvent(input),
);

const pushCliSchema = {
  listUsageOverride: 'push',
  helpDescription: 'Deliver push notification payloads to an installed app.',
  summary: 'Deliver push notification payloads to an installed app',
  positionalArgs: ['bundleOrPackage', 'payloadOrJson'],
} as const satisfies CommandSchemaOverride;

const triggerAppEventCliSchema = {
  usageOverride: 'trigger-app-event <event> [payloadJson]',
  listUsageOverride: 'trigger-app-event',
  helpDescription:
    'Invoke app-defined automation or test events with an optional structured payload.',
  summary: 'Invoke app-defined automation/test events with optional structured payloads',
  positionalArgs: ['event', 'payloadJson?'],
} as const satisfies CommandSchemaOverride;

const pushCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  app: requiredString(positionals[0], 'push requires bundleOrPackage'),
  payload: requiredString(positionals[1], 'push requires payloadOrJson'),
});

const triggerAppEventCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  event: requiredString(positionals[0], 'trigger-app-event requires event'),
  payload: positionals[1] ? readJsonObject(positionals[1], 'trigger-app-event payload') : undefined,
});

const pushDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.push, (input) =>
  pushPositionals(input as AppPushOptions),
);

const triggerAppEventDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.triggerAppEvent, (input) =>
  triggerEventPositionals(input as AppTriggerEventOptions),
);

const pushCommandFacet = defineCommandFacet({
  name: 'push',
  metadata: pushCommandMetadata,
  definition: pushCommandDefinition,
  cliSchema: pushCliSchema,
  cliReader: pushCliReader,
  daemonWriter: pushDaemonWriter,
});

const triggerAppEventCommandFacet = defineCommandFacet({
  name: 'trigger-app-event',
  metadata: triggerAppEventCommandMetadata,
  definition: triggerAppEventCommandDefinition,
  cliSchema: triggerAppEventCliSchema,
  cliReader: triggerAppEventCliReader,
  daemonWriter: triggerAppEventDaemonWriter,
});

export const pushManagementCommandFacets = [pushCommandFacet, triggerAppEventCommandFacet] as const;

function pushPositionals(input: AppPushOptions): string[] {
  return [
    input.app,
    typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload),
  ];
}

function triggerEventPositionals(input: AppTriggerEventOptions): string[] {
  return [input.event, ...(input.payload ? [JSON.stringify(input.payload)] : [])];
}
