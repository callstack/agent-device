import { deriveDaemonCommandDescriptors } from '../core/command-descriptor/derive.ts';
import { commandDescriptors } from '../core/command-descriptor/registry.ts';
import type { DaemonCommandRoute } from './request-handler-chain.ts';
import type { DaemonRequest } from './types.ts';

export type { DaemonCommandRoute } from './request-handler-chain.ts';

export type SessionCommandKind = 'inventory' | 'state' | 'observability' | 'replay';

export type DaemonCommandDescriptor = {
  command: string;
  route: DaemonCommandRoute;
  sessionKind?: SessionCommandKind;
  leaseAdmissionExempt?: boolean;
  sessionExecutionLockExempt?: boolean;
  selectorValidationExempt?: boolean;
  replayScopedAction?: boolean;
  allowInvalidRecording?: boolean;
  lockPolicySelectorOverride?: boolean;
  androidBlockingDialogGuard?: boolean;
  preferExplicitDeviceOverExistingSession?: boolean;
  allowSessionlessDefaultDevice?: (req: DaemonRequest) => boolean;
  skipSessionlessProviderDevice?: (req: DaemonRequest) => boolean;
};

export type DaemonProviderDeviceResolutionIntent =
  | 'existing-session'
  | 'explicit-device'
  | 'sessionless-default-device'
  | 'skip';

// Built from the additive command-descriptor registry (ADR-0008, Phase 1 step 2).
// The hand-authored literal that previously lived here was proven byte-equal to
// this derived value by `src/core/command-descriptor/__tests__/parity.test.ts` (#906)
// and has been deleted; the daemon now derives its routes/traits from the single
// source. The back-edge from derive.ts/registry.ts to this module's
// `DaemonCommandDescriptor` is type-only (erased at runtime), so there is no
// runtime import cycle.
export const DAEMON_COMMAND_DESCRIPTORS: readonly DaemonCommandDescriptor[] =
  deriveDaemonCommandDescriptors(commandDescriptors);

const DAEMON_COMMAND_REGISTRY = buildDaemonCommandRegistry(DAEMON_COMMAND_DESCRIPTORS);

export function getDaemonCommandRoute(command: string): DaemonCommandRoute {
  return getDaemonCommandDescriptor(command)?.route ?? 'generic';
}

export function getSessionCommandKind(command: string): SessionCommandKind | undefined {
  return getDaemonCommandDescriptor(command)?.sessionKind;
}

export function isLeaseAdmissionExempt(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.leaseAdmissionExempt === true;
}

export function shouldValidateSessionSelector(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.selectorValidationExempt !== true;
}

export function shouldLockSessionExecution(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.sessionExecutionLockExempt !== true;
}

export function canRunReplayScopedAction(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.replayScopedAction === true;
}

export function shouldBlockForInvalidRecording(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.allowInvalidRecording !== true;
}

export function canOverrideLockPolicySelector(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.lockPolicySelectorOverride === true;
}

export function shouldGuardAndroidBlockingDialog(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.androidBlockingDialogGuard === true;
}

export function shouldPreferExplicitDeviceOverExistingSession(req: DaemonRequest): boolean {
  return getDaemonCommandDescriptor(req.command)?.preferExplicitDeviceOverExistingSession === true;
}

export function usesSessionlessDefaultProviderDevice(req: DaemonRequest): boolean {
  const allow = getDaemonCommandDescriptor(req.command)?.allowSessionlessDefaultDevice;
  return typeof allow === 'function' ? allow(req) : false;
}

export function resolveProviderDeviceResolutionIntent(
  req: DaemonRequest,
  params: { hasExistingSession: boolean; hasExplicitDeviceSelector: boolean },
): DaemonProviderDeviceResolutionIntent {
  if (params.hasExistingSession) {
    return shouldPreferExplicitDeviceOverExistingSession(req) && params.hasExplicitDeviceSelector
      ? 'explicit-device'
      : 'existing-session';
  }
  if (shouldSkipSessionlessProviderDevice(req)) return 'skip';
  if (params.hasExplicitDeviceSelector) return 'explicit-device';
  return usesSessionlessDefaultProviderDevice(req) ? 'sessionless-default-device' : 'skip';
}

function getDaemonCommandDescriptor(command: string): DaemonCommandDescriptor | undefined {
  return DAEMON_COMMAND_REGISTRY.descriptorsByCommand.get(command);
}

function buildDaemonCommandRegistry(descriptors: readonly DaemonCommandDescriptor[]) {
  const descriptorsByCommand = new Map<string, DaemonCommandDescriptor>();
  for (const descriptor of descriptors) {
    if (descriptorsByCommand.has(descriptor.command)) {
      throw new Error(`Duplicate daemon command descriptor: ${descriptor.command}`);
    }
    descriptorsByCommand.set(descriptor.command, descriptor);
  }
  return { descriptorsByCommand };
}

function shouldSkipSessionlessProviderDevice(req: DaemonRequest): boolean {
  const skip = getDaemonCommandDescriptor(req.command)?.skipSessionlessProviderDevice;
  return typeof skip === 'function' ? skip(req) : false;
}
