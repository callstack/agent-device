import { deriveCapabilityMatrix } from './command-descriptor/derive.ts';
import { commandDescriptors } from './command-descriptor/registry.ts';
import { deriveCapabilityForPlatform } from './platform-descriptor/derive.ts';
import { platformDescriptors } from './platform-descriptor/registry.ts';
import type { DeviceInfo } from '../kernel/device.ts';

type KindMatrix = {
  simulator?: boolean;
  device?: boolean;
  emulator?: boolean;
  unknown?: boolean;
};

export type CommandCapability = {
  apple?: KindMatrix;
  android?: KindMatrix;
  linux?: KindMatrix;
  web?: KindMatrix;
  supports?: (device: DeviceInfo) => boolean;
  /** Optional actionable hint surfaced when this command is rejected at admission for `device`. */
  unsupportedHint?: (device: DeviceInfo) => string | undefined;
};

const WEB_DEVICE: KindMatrix = { device: true };
const WEB_RUNTIME_COMMANDS = ['open', 'close'] as const;
const WEB_RECORDING_COMMANDS = ['record'] as const;
const WEB_QUERY_COMMANDS = [
  'find',
  'get',
  'is',
  'network',
  'screenshot',
  'snapshot',
  'wait',
] as const;
const WEB_INTERACTION_COMMANDS = ['click', 'fill', 'focus', 'press', 'scroll', 'type'] as const;
const WEB_SETTING_COMMANDS = ['viewport'] as const;
const WEB_SUPPORTED_COMMANDS = new Set<string>([
  ...WEB_RUNTIME_COMMANDS,
  ...WEB_RECORDING_COMMANDS,
  ...WEB_QUERY_COMMANDS,
  ...WEB_INTERACTION_COMMANDS,
  ...WEB_SETTING_COMMANDS,
]);
// Built from the additive command-descriptor registry (ADR-0008, Phase 1 step 3).
// The hand-authored literal was deleted after #906 proved deriveCapabilityMatrix is
// byte-equal to it (platform/kind buckets plus the supports/unsupportedHint closures,
// across the sample-device matrix). The registry only type-imports CommandCapability
// from here, so this value-level dependency does not form a runtime cycle.
export const BASE_COMMAND_CAPABILITY_MATRIX: Record<string, CommandCapability> =
  deriveCapabilityMatrix(commandDescriptors);

const COMMAND_CAPABILITY_MATRIX = addWebCommandCapabilities(BASE_COMMAND_CAPABILITY_MATRIX);

function addWebCommandCapabilities(
  matrix: Record<string, CommandCapability>,
): Record<string, CommandCapability> {
  const result: Record<string, CommandCapability> = {};
  for (const [command, capability] of Object.entries(matrix)) {
    result[command] = WEB_SUPPORTED_COMMANDS.has(command)
      ? { ...capability, web: WEB_DEVICE }
      : capability;
  }
  for (const command of WEB_SUPPORTED_COMMANDS) {
    if (!(command in matrix)) {
      throw new Error(`Web command "${command}" missing from capability matrix`);
    }
  }
  return result;
}

// Platform -> capability-bucket selection, folded from the additive
// platform-descriptor registry (ADR-0009, Phase 3 step 1). The hand-authored
// switch was deleted after `platform-descriptor/__tests__/parity.test.ts` proved
// deriveCapabilityForPlatform is byte-equal to it across all five platforms. The
// registry's compile-time totality keeps the prior safety: adding a new Platform
// without a descriptor row is a compile error, so it can no longer silently
// inherit web's capability matrix. The registry only type-imports CommandCapability
// from here, so this value-level dependency does not form a runtime cycle.
function selectCapabilityForPlatform(
  capability: CommandCapability,
  platform: DeviceInfo['platform'],
): KindMatrix | undefined {
  return deriveCapabilityForPlatform(platformDescriptors, capability, platform);
}

export function isCommandSupportedOnDevice(command: string, device: DeviceInfo): boolean {
  const capability = COMMAND_CAPABILITY_MATRIX[command];
  if (!capability) return true;
  const byPlatform = selectCapabilityForPlatform(capability, device.platform);
  if (!byPlatform) return false;
  if (capability.supports && !capability.supports(device)) return false;
  const kind = (device.kind ?? 'unknown') as keyof KindMatrix;
  return byPlatform[kind] === true;
}

export function unsupportedHintForDevice(command: string, device: DeviceInfo): string | undefined {
  return COMMAND_CAPABILITY_MATRIX[command]?.unsupportedHint?.(device);
}

export function listCapabilityCommands(): string[] {
  return Object.keys(COMMAND_CAPABILITY_MATRIX).sort();
}

/**
 * The platform families that DO support `command`, derived from the capability
 * matrix (a family counts when it has at least one supported device kind). Used
 * by the typed-error graft to populate `DaemonError.supportedOn` on platform
 * mismatches. Returns `[]` for commands with no capability row (supported
 * everywhere) so callers can omit the signal.
 */
export function supportedPlatformsForCommand(command: string): string[] {
  const capability = COMMAND_CAPABILITY_MATRIX[command];
  if (!capability) return [];
  const families: Array<keyof CommandCapability> = ['apple', 'android', 'linux', 'web'];
  const supported: string[] = [];
  for (const family of families) {
    const kinds = capability[family] as KindMatrix | undefined;
    if (kinds && Object.values(kinds).some((value) => value === true)) supported.push(family);
  }
  return supported;
}
