import type {
  AppPushOptions,
  AppTriggerEventOptions,
  JsonObject,
} from '@agent-device/contracts/client';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import {
  commonInputFromFlags,
  direct,
  readJsonObject,
  requiredString,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import {
  jsonSchemaField,
  looseObjectField,
  looseObjectSchema,
  requiredField,
  stringField,
  stringSchema,
  type CommandField,
} from '../command-input.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const pushCommandMetadata = defineFieldCommandMetadata(
  'push',
  'Deliver push notification payloads to an installed app.',
  {
    app: requiredField(stringField()),
    payload: requiredField(
      jsonSchemaField<string | JsonObject>({
        oneOf: [stringSchema(), looseObjectSchema()],
      }),
    ),
  },
);

const triggerAppEventCommandMetadata = defineFieldCommandMetadata(
  'trigger-app-event',
  'Ask the app to handle an app-defined automation or test event, with an optional structured payload. Call this only for event names and payload shapes the app documents.',
  {
    event: requiredField(
      stringField('Name of an app-defined automation or test event the app documents.'),
    ),
    payload: jsonObjectField(
      'Structured payload passed to the event, in the shape the app documents for it.',
    ),
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
  positionalArgs: ['bundleOrPackage', 'payloadOrJson'],
} as const satisfies CommandSchemaOverride;

const triggerAppEventCliSchema = {
  usageOverride: 'trigger-app-event <event> [payloadJson]',
  listUsageOverride: 'trigger-app-event',
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
  text: {
    summary: 'Deliver a push notification payload',
  },
  metadata: pushCommandMetadata,
  definition: pushCommandDefinition,
  cliSchema: pushCliSchema,
  cliReader: pushCliReader,
  daemonWriter: pushDaemonWriter,
});

const triggerAppEventCommandFacet = defineCommandFacet({
  name: 'trigger-app-event',
  text: {
    summary: 'Invoke an app-defined automation event',
  },
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

function jsonObjectField(description?: string): CommandField<JsonObject> {
  return looseObjectField(description) as CommandField<JsonObject>;
}
