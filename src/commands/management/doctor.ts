import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import * as commandInput from '../command-input.ts';
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
    remote: commandInput.booleanField(
      'Check remote connection setup instead of local device inventory.',
    ),
    metroHost: commandInput.stringField('Metro host to probe (forces a Metro reachability check).'),
    metroPort: commandInput.integerField(
      'Metro port to probe (forces a Metro reachability check).',
      { min: 1, max: 65535 },
    ),
  },
);

const doctorCommandDefinition = defineExecutableCommand(doctorCommandMetadata, (client, input) =>
  client.command.doctor(input),
);

const doctorCliSchema = {
  usageOverride:
    'doctor [--platform ios|android|macos|linux|web|apple] [--metro-host <host>] [--metro-port <port>] [--remote]',
  helpDescription:
    'Read-only preflight for QA and dogfood runs. Reports local device inventory, active sessions, app discovery from the active session, Metro reachability inferred from cwd/runtime, and obvious React Native overlay blockers from the current session snapshot. Pass --metro-host/--metro-port to force a Metro probe against a specific endpoint (e.g. outside an RN/Expo project directory). Use --remote to check remote connection setup without probing local devices. Default output is compact; use --json for full checks and evidence.',
  summary: 'Preflight device, app, Metro, and RN/Expo readiness',
  allowedFlags: ['remote', 'metroHost', 'metroPort'],
} as const satisfies CommandSchemaOverride;

const doctorCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  remote: flags.remote,
  metroHost: flags.metroHost,
  metroPort: flags.metroPort,
});
// Both the field-command definition (client.command.doctor) and this facet
// cli reader forward metroHost/metroPort so the Metro probe is controllable
// regardless of which dispatch path executes.

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
