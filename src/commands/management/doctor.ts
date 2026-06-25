import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { enumField, integerField, stringField } from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { commonInputFromFlags, direct } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

const doctorCommandMetadata = defineFieldCommandMetadata(
  'doctor',
  'Diagnose device, app, Metro, and React Native readiness before a run.',
  {
    targetApp: stringField('Expected app bundle id, package name, or app name.'),
    metroHost: stringField('Metro host to probe.'),
    metroPort: integerField('Metro port to probe.'),
    kind: enumField(['auto', 'react-native', 'expo']),
  },
);

const doctorCommandDefinition = defineExecutableCommand(doctorCommandMetadata, (client, input) =>
  client.command.doctor(input),
);

const doctorCliSchema = {
  usageOverride:
    'doctor [--platform ios|android|macos|linux|web|apple] [--target-app <id|name>] [--metro-host <host>] [--metro-port <port>] [--react-native|--expo|--kind auto|react-native|expo]',
  helpDescription:
    'Read-only preflight for QA and dogfood runs. Reports device readiness, active sessions, target app discovery, Metro reachability, and obvious React Native overlay blockers from the current session snapshot. Default output is compact; use --json for full checks and evidence.',
  summary: 'Preflight device, app, Metro, and RN/Expo readiness',
  allowedFlags: ['targetApp', 'metroHost', 'metroPort', 'doctorReactNative', 'doctorExpo', 'kind'],
} as const satisfies CommandSchemaOverride;

const doctorCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  targetApp: flags.targetApp,
  metroHost: flags.metroHost,
  metroPort: flags.metroPort,
  kind: resolveDoctorKind(flags),
});

const doctorDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.doctor);

export const doctorCommandFacet = defineCommandFacet({
  name: 'doctor',
  metadata: doctorCommandMetadata,
  definition: doctorCommandDefinition,
  cliSchema: doctorCliSchema,
  cliReader: doctorCliReader,
  daemonWriter: doctorDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.doctor,
});

function resolveDoctorKind(flags: Parameters<CliReader>[1]): 'auto' | 'react-native' | 'expo' {
  if (flags.doctorExpo) return 'expo';
  if (flags.doctorReactNative) return 'react-native';
  if (flags.kind === 'expo' || flags.kind === 'react-native' || flags.kind === 'auto') {
    return flags.kind;
  }
  return 'auto';
}
