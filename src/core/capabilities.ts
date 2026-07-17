import { deriveCapabilityMatrix } from './command-descriptor/derive.ts';
import { commandDescriptors } from './command-descriptor/registry.ts';
import { tryGetPlugin } from './platform-plugin/plugin.ts';
import { registerBuiltinPlatformPlugins } from './interactors/register-builtins.ts';
import type { DeviceInfo } from '../kernel/device.ts';
import { AppError } from '../kernel/errors.ts';
import type { GestureSemanticInput } from '../contracts/gesture-plan-types.ts';
import { assertAppleMultiTouchSupported } from '../contracts/apple-multitouch-support.ts';

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
  linux?: KindMatrix;
  web?: KindMatrix;
};

const WEB_DEVICE: KindMatrix = { device: true };
const WEB_RUNTIME_COMMANDS = ['open', 'close'] as const;
const WEB_RECORDING_COMMANDS = ['record'] as const;
const WEB_QUERY_COMMANDS = [
  'audio',
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
// byte-equal to it (platform/kind buckets). The per-command `supports()` /
// `unsupportedHint()` device closures no longer live here — they were relocated onto
// the owning PlatformPlugin's `capability.supportsByDefault` / `unsupportedHintByDefault`
// in Phase 3 step b.2 (see `isCommandSupportedOnDevice` below). The registry only
// type-imports CommandCapability from here, so this value-level dependency does not
// form a runtime cycle.
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

export function isCommandSupportedOnDevice(command: string, device: DeviceInfo): boolean {
  const capability = COMMAND_CAPABILITY_MATRIX[command];
  if (!capability) return true;
  // Platform -> capability-bucket selection now flows through the single
  // PlatformPlugin registry (ADR-0009, Phase 3 step b.1): the bucket a leaf
  // platform reads from a CommandCapability is the owning plugin's
  // `capability.bucket`. This replaces the former `selectCapabilityForPlatform`
  // fold over `platformDescriptors`; the plugin bucket is proven byte-for-byte
  // equal to that derivation by `platform-plugin/__tests__/parity.test.ts`, and
  // `__tests__/capability-plugin-routing-parity.test.ts` pins that this swap leaves
  // `isCommandSupportedOnDevice` unchanged across the full command x device matrix.
  // `tryGetPlugin` returns undefined only for an unregistered platform — the same
  // "no bucket -> unsupported" fall-through the fold produced for a platform with
  // no capability family (ADR-0009's plugin registry: `if (!plugin) return false`).
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

export function requireGestureSupported(input: GestureSemanticInput, device: DeviceInfo): void {
  if (device.platform === 'web' || device.appleOs === 'watchos') {
    throw unsupportedGesture(input, gesturePlatformMessage(input, device));
  }
  if (isMultiTouchGesture(input)) {
    requireMultiTouchGestureSupported(input, device);
    return;
  }
  if (device.appleOs === 'visionos') {
    throw unsupportedGesture(input, gesturePlatformMessage(input, device));
  }
  // Linux can preserve public coordinate/preset swipe through its drag primitive, but cannot
  // honor the speed semantics authored by `gesture fling`.
  if (input.intent === 'fling' && 'direction' in input && device.platform === 'linux') {
    throw unsupportedGesture(input, 'gesture fling is not supported on Linux');
  }
}

function isMultiTouchGesture(input: GestureSemanticInput): boolean {
  if (input.intent === 'pan') return ('pointerCount' in input ? input.pointerCount : 1) === 2;
  return input.intent === 'pinch' || input.intent === 'rotate' || input.intent === 'transform';
}

function requireMultiTouchGestureSupported(input: GestureSemanticInput, device: DeviceInfo): void {
  if (device.platform === 'android') {
    if (device.target !== 'tv') return;
    throw unsupportedGesture(
      input,
      `gesture ${input.intent} is not supported on Android TV`,
      'Android TV has no touch input — this gesture is supported on Android phones, tablets, and the iOS simulator only.',
    );
  }
  if (device.platform !== 'apple') {
    throw unsupportedGesture(input, gesturePlatformMessage(input, device));
  }
  assertAppleMultiTouchSupported(device, input.intent);
}

function gesturePlatformMessage(input: GestureSemanticInput, device: DeviceInfo): string {
  return `gesture ${input.intent} is not supported on ${device.appleOs ?? device.platform}`;
}

function unsupportedGesture(input: GestureSemanticInput, message: string, hint?: string): AppError {
  return new AppError('UNSUPPORTED_OPERATION', message, {
    gesture: input.intent,
    ...(hint ? { hint } : {}),
  });
}
