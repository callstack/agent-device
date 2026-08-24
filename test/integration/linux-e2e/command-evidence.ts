import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';

/** Commands exercised by the separate Linux/Xvfb command-evidence lane. */
export const LINUX_COMMAND_EVIDENCE_COMMANDS = [
  PUBLIC_COMMANDS.capabilities,
  PUBLIC_COMMANDS.doctor,
  PUBLIC_COMMANDS.events,
  PUBLIC_COMMANDS.replay,
  PUBLIC_COMMANDS.test,
  PUBLIC_COMMANDS.batch,
  PUBLIC_COMMANDS.diff,
  PUBLIC_COMMANDS.find,
  PUBLIC_COMMANDS.swipe,
] as const;

export const LINUX_COMMAND_EVIDENCE_SCRIPT =
  'test/integration/linux-e2e/command-evidence.ad' as const;
