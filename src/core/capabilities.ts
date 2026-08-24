import { deriveCapabilityMatrix } from './command-descriptor/derive.ts';
import { commandDescriptors } from './command-descriptor/registry.ts';
import { tryGetPlugin } from './platform-plugin-registry.ts';
import { registerBuiltinPlatformPlugins } from './interactors/register-builtins.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';

// Populate the PlatformPlugin registry once at module load (idempotent; registers
// only lazy closures, so no leaf code is imported and CLI cold-start is unaffected
// — mirrors the same call in `core/interactors.ts`). `isCommandSupportedOnDevice`
// reads each platform's capability bucket from this registry, and the admission
// path reaches it (e.g. `daemon/handlers/response.ts`) without necessarily having
// loaded `core/interactors.ts` first, so the registry must be populated here.
registerBuiltinPlatformPlugins();

type KindMatrix = {
  simulator?: boolean;
  device?: boolean;
  emulator?: boolean;
  unknown?: boolean;
};

export type CommandCapability = {
  apple?: KindMatrix;
  android?: KindMatrix;
  harmonyos?: KindMatrix;
  vega?: KindMatrix;
  linux?: KindMatrix;
  web?: KindMatrix;
};

const WEB_DEVICE: KindMatrix = { device: true };
const HARMONYOS_ALL: KindMatrix = { emulator: true, device: true };
const HARMONYOS_SUPPORTED_COMMANDS = new Set<string>(['perf', 'app-switcher', 'settings']);
const WEB_QUERY_COMMANDS = ['audio'] as const;
const WEB_SUPPORTED_COMMANDS = new Set<string>(WEB_QUERY_COMMANDS);
// Built from the additive command-descriptor registry (ADR-0008, Phase 1 step 3).
// The hand-authored literal was deleted after #906 proved deriveCapabilityMatrix is
// byte-equal to it (platform/kind buckets). The per-command `supports()` /
// `unsupportedHint()` device closures no longer live here — they were relocated onto
// the owning PlatformPlugin's `capability.supportsByDefault` / `unsupportedHintByDefault`
// in Phase 3 step b.2 (see `isCommandSupportedOnDevice` below). The registry only
// type-imports CommandCapability from here, so this value-level dependency does not
// form a runtime cycle.
export const BASE_COMMAND_CAPABILITY_MATRIX: Record<string, CommandCapability> =
  deriveCapabilityMatrix(commandDescriptors);

const COMMAND_CAPABILITY_MATRIX = addHarmonyAndWebCommandCapabilities(
  BASE_COMMAND_CAPABILITY_MATRIX,
);

function addHarmonyAndWebCommandCapabilities(
  matrix: Record<string, CommandCapability>,
): Record<string, CommandCapability> {
  const withHarmony: Record<string, CommandCapability> = {};
  for (const [command, capability] of Object.entries(matrix)) {
    withHarmony[command] = HARMONYOS_SUPPORTED_COMMANDS.has(command)
      ? { ...capability, harmonyos: HARMONYOS_ALL }
      : capability;
  }
  return addWebCommandCapabilities(withHarmony);
}

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

export function isCommandSupportedOnDevice(command: string, device: DeviceInfo): boolean {
  const capability = COMMAND_CAPABILITY_MATRIX[command];
  if (!capability) return true;
  // Platform -> capability-bucket selection flows through the single
  // PlatformPlugin registry (ADR-0009, Phase 3 step b.1): the bucket a leaf
  // platform reads from a CommandCapability is the owning plugin's
  // `capability.bucket`, pinned against a hardcoded platform -> bucket table by
  // `platform-plugin/__tests__/parity.test.ts` and
  // `__tests__/capability-plugin-routing-parity.test.ts`. `tryGetPlugin` returns
  // undefined only for an unregistered platform, which falls through to
  // "no bucket -> unsupported" below.
  const plugin = tryGetPlugin(device.platform);
  if (!plugin) return false;
  const byPlatform = capability[plugin.capability.bucket];
  if (!byPlatform) return false;
  // The per-command `supports()` gate now flows through the owning PlatformPlugin
  // (ADR-0009, Phase 3 step b.2): the family that owns `device.platform` carries the
  // `supports()` closure RELOCATED VERBATIM in `capability.supportsByDefault`, keyed by
  // command. A family with no entry for `command` admits it unchanged — proven equal to
  // the former command-facet closure across the device matrix by
  // `__tests__/capability-plugin-routing-parity.test.ts`.
  const supportsByDefault = plugin.capability.supportsByDefault?.[command];
  if (supportsByDefault && !supportsByDefault(device)) return false;
  const kind = (device.kind ?? 'unknown') as keyof KindMatrix;
  return byPlatform[kind] === true;
}

export function unsupportedHintForDevice(command: string, device: DeviceInfo): string | undefined {
  // Counterpart of the `supports()` relocation (Phase 3 step b.2): the hint closure is
  // owned by the family that owns `device.platform`, keyed by command.
  return tryGetPlugin(device.platform)?.capability.unsupportedHintByDefault?.[command]?.(device);
}

export function listCapabilityCommands(): string[] {
  return commandDescriptors
    .filter(
      (descriptor) =>
        descriptor.catalog.group === 'public' &&
        (('capability' in descriptor && descriptor.capability !== undefined) ||
          descriptor.platformExecution.kind === 'device-runtime'),
    )
    .map((descriptor) => descriptor.name)
    .sort();
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
  const families: Array<keyof CommandCapability> = [
    'apple',
    'android',
    'harmonyos',
    'vega',
    'linux',
    'web',
  ];
  const supported: string[] = [];
  for (const family of families) {
    const kinds = capability[family] as KindMatrix | undefined;
    if (kinds && Object.values(kinds).some((value) => value === true)) supported.push(family);
  }
  return supported;
}
