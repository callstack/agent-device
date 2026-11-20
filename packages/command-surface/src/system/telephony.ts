import {
  TELEPHONY_ACTIONS,
  TELEPHONY_CALL_ACTIONS,
  TELEPHONY_USAGE,
  parseTelephonyEventInput,
  parseTelephonyPositionals,
  telephonyPositionals,
} from '@agent-device/contracts/device';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import { commonInputFromFlags, direct } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import {
  constSchema,
  enumField,
  enumSchema,
  readFieldInput,
  requiredField,
  stringField,
} from '../command-input.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const TELEPHONY_COMMAND_NAME = 'telephony';

const telephonyCommandDescription =
  'Simulate an incoming phone call or SMS on an Android emulator through its console over adb: call rings from the number, accept answers, cancel ends the call, and sms delivers a text message. The call screen or notification can cover the app and invalidate earlier UI observations.';

const telephonyFields = {
  action: requiredField(
    enumField(
      TELEPHONY_ACTIONS,
      'call starts an incoming call, accept answers it, cancel ends it, sms delivers a text message.',
    ),
  ),
  number: requiredField(
    stringField('Caller or sender phone number: digits with an optional leading +.'),
  ),
  text: stringField(
    'Message text for sms; required for sms and refused for the call actions. The emulator drops characters outside the Basic Multilingual Plane, such as emoji.',
  ),
};

const telephonyFieldMetadata = defineFieldCommandMetadata(
  TELEPHONY_COMMAND_NAME,
  telephonyCommandDescription,
  telephonyFields,
  {
    readInput: (input) => {
      const { action, number, text, ...common } = readFieldInput(input, telephonyFields);
      return { ...common, ...parseTelephonyEventInput({ action, number, text }) };
    },
    inputExample: { action: 'call', number: '+15555550100' },
  },
);

const telephonyCommandMetadata = {
  ...telephonyFieldMetadata,
  inputSchema: {
    ...telephonyFieldMetadata.inputSchema,
    oneOf: [
      { properties: { action: constSchema('sms') }, required: ['text'] },
      { properties: { action: enumSchema(TELEPHONY_CALL_ACTIONS) }, not: { required: ['text'] } },
    ],
  },
};

const telephonyCliSchema = {
  usageOverride: TELEPHONY_USAGE,
  listUsageOverride: 'telephony call|accept|cancel|sms <number> [text]',
  positionalArgs: ['call|accept|cancel|sms', 'number', 'text?'],
  allowsExtraPositionals: true,
} as const satisfies CommandSchemaOverride;

export const telephonyCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...parseTelephonyPositionals(positionals),
});

export const telephonyDaemonWriter: DaemonWriter = direct(TELEPHONY_COMMAND_NAME, (input) =>
  telephonyPositionals(parseTelephonyEventInput(input)),
);

export const telephonyCommandFacet = defineCommandFacet({
  name: TELEPHONY_COMMAND_NAME,
  effect: 'destructive',
  text: {
    summary: 'Simulate an incoming call or SMS on an Android emulator over adb',
    searchHint: 'voice gsm cellular',
    cliDetail:
      'Android emulators through the local adb executor; WebDriver (Appium) and Limrun sessions refuse it. Quote the SMS text, or pass it as the remaining words. Re-snapshot after the event: the call screen or notification can cover the app.',
  },
  metadata: telephonyCommandMetadata,
  run: (client, input) => client.command.telephony(input),
  cliSchema: telephonyCliSchema,
  cliReader: telephonyCliReader,
  daemonWriter: telephonyDaemonWriter,
});
