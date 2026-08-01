import {
  canonicalizeAgentCommands,
  canonicalizeUpstreamFlow,
  type CanonicalCommand,
} from '../../src/internal/conformance-normalize.ts';
import {
  MAESTRO_COMPATIBILITY_PRESETS,
  MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
} from '../../src/internal/compatibility-policy.ts';
import { SUPPORTED_MAESTRO_COMMAND_NAMES } from '../../src/internal/program-ir-command-parser.ts';
import { parseMaestroProgram } from '../../src/internal/program-ir-parser.ts';

export type { CanonicalCommand };
export { canonicalizeUpstreamFlow, SUPPORTED_MAESTRO_COMMAND_NAMES };

export const MAESTRO_CONFORMANCE_CONSTANTS = {
  retryMaxRetries: MAESTRO_COMPATIBILITY_PRESETS.control.retryMaxRetries,
  animationWaitThreshold:
    MAESTRO_COMPATIBILITY_PRESETS.command.waitForAnimationToEndDifferencePercent,
  animationWaitTimeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.waitForAnimationToEndTimeoutMs,
  maxEraseCharacters: MAESTRO_COMPATIBILITY_PRESETS.command.eraseTextMaxCharacters,
  swipeDurationMs: MAESTRO_COMPATIBILITY_PRESETS.command.swipeDurationMs,
} as const;

export { MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS };

export function parseMaestroConformanceSource(
  source: string,
  sourcePath: string,
): { commands: CanonicalCommand[]; kinds: Set<string> } {
  const program = parseMaestroProgram(source, { sourcePath });
  const kinds = new Set<string>();
  collectCommandKinds(program.commands, kinds);
  return { commands: canonicalizeAgentCommands(program), kinds };
}

function collectCommandKinds(
  commands: Array<{ kind: string; commands?: unknown }>,
  into: Set<string>,
): void {
  for (const command of commands) {
    into.add(command.kind);
    if (Array.isArray(command.commands)) {
      collectCommandKinds(command.commands as Array<{ kind: string; commands?: unknown }>, into);
    }
  }
}
