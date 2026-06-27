import { deriveCapabilityMatrix } from './command-descriptor/derive.ts';
import { commandDescriptors } from './command-descriptor/registry.ts';
import type { DeviceInfo } from '../utils/device.ts';

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

// Exhaustive platform -> capability-bucket selection. Switching over the full Platform
// union (instead of an if/else ladder that funnels every unmatched platform into
// `capability.web`) makes adding a new Platform a compile error here, so a future
// platform can no longer silently inherit web's capability matrix.
function selectCapabilityForPlatform(
  capability: CommandCapability,
  platform: DeviceInfo['platform'],
): KindMatrix | undefined {
  switch (platform) {
    case 'ios':
    case 'macos':
      return capability.apple;
    case 'android':
      return capability.android;
    case 'linux':
      return capability.linux;
    case 'web':
      return capability.web;
    default: {
      const exhaustive: never = platform;
      return exhaustive;
    }
  }
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
