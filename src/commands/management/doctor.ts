import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import * as commandInput from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { commonInputFromFlags, direct } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

const doctorCommandMetadata = defineFieldCommandMetadata(
  'doctor',
  'Diagnose device, app, Metro, and React Native setup/readiness issues.',
  {
    targetApp: commandInput.stringField(
      'Installed app package/bundle id or app name to verify without opening a session.',
    ),
    remote: commandInput.booleanField(
      'Check remote connection setup instead of local device inventory.',
    ),
  },
);

const doctorCommandDefinition = defineExecutableCommand(doctorCommandMetadata, (client, input) =>
  client.command.doctor(input),
);

const doctorCliSchema = {
  usageOverride:
    'doctor [--platform ios|android|macos|linux|web|apple] [--app <id-or-name>] [--remote]',
  helpDescription:
    'Setup and recovery diagnostic for device, app, dev-server, and RN/Expo readiness issues. Reports local device inventory, active sessions, optional app discovery, scoped toolchain info, and Metro reachability inferred from cwd/runtime. On iOS simulators it also warms the XCTest runner build cache in the background when missing. Pass --app to verify a target app on the one matching booted device without opening a session. Use --remote to check remote connection setup without probing local devices. Default output is compact; use --json for full checks and evidence.',
  summary: 'Diagnose device, app, dev-server, and RN/Expo readiness',
  allowedFlags: ['targetApp', 'remote'],
} as const satisfies CommandSchemaOverride;

const doctorCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  targetApp: flags.targetApp,
  remote: flags.remote,
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
