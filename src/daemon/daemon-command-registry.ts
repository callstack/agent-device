import {
  type DaemonCommandDescriptor,
  type DaemonCommandRoute,
  type SessionlessLeaseAdmissionExemption,
  type SessionCommandKind,
} from '../core/command-descriptor/daemon-command-descriptor.ts';
import { deriveDaemonCommandDescriptors } from '../core/command-descriptor/derive.ts';
import {
  commandDescriptors,
  resolveCommandRecordingEffect,
  resolveCommandDeviceClaimPolicy,
} from '../core/command-descriptor/registry.ts';
import type { RefFrameEffect } from '@agent-device/contracts/replay';
import type { DaemonRequest } from './types.ts';

export type { DaemonCommandDescriptor, DaemonCommandRoute, SessionCommandKind };

export type DaemonProviderDeviceResolutionIntent =
  | 'existing-session'
  | 'explicit-device'
  | 'sessionless-default-device'
  | 'skip';

// Built from the additive command-descriptor registry (ADR-0008, Phase 1 step 2).
// The hand-authored literal that previously lived here was proven byte-equal to
// this derived value by `src/core/command-descriptor/__tests__/parity.test.ts` (#906)
// and has been deleted; the daemon now derives its routes/traits from the single
// source.
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

/** #1478: whether `flags.saveScript` is accepted on this command's request. */
export function ownsSaveScriptFlag(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.saveScriptFlagOwner === true;
}

/** #1478: the released `--save-script` flag owners, sorted for stable messages. */
export function listSaveScriptFlagOwnerCommands(): string[] {
  return DAEMON_COMMAND_DESCRIPTORS.filter((descriptor) => descriptor.saveScriptFlagOwner === true)
    .map((descriptor) => descriptor.command)
    .sort();
}

export function canOverrideLockPolicySelector(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.lockPolicySelectorOverride === true;
}

export function shouldGuardAndroidBlockingDialog(command: string): boolean {
  return getDaemonCommandDescriptor(command)?.androidBlockingDialogGuard === true;
}

export function isHumanControlMutation(req: DaemonRequest): boolean {
  if (req.command === 'human_control' || req.command === 'lease_heartbeat') return false;
  const recordingEffect = resolveCommandRecordingEffect(req);
  if (recordingEffect !== undefined) return recordingEffect !== 'observes-app';
  if (getSessionCommandKind(req.command) === 'observability') return false;
  return resolveCommandDeviceClaimPolicy(req.command) !== 'observe';
}

export function shouldPreferExplicitDeviceOverExistingSession(req: DaemonRequest): boolean {
  return getDaemonCommandDescriptor(req.command)?.preferExplicitDeviceOverExistingSession === true;
}

export function usesSessionlessDefaultProviderDevice(req: DaemonRequest): boolean {
  const allow = getDaemonCommandDescriptor(req.command)?.allowSessionlessDefaultDevice;
  return typeof allow === 'function' ? allow(req) : false;
}

export function resolveSessionlessLeaseAdmissionExemption(
  req: DaemonRequest,
): SessionlessLeaseAdmissionExemption | undefined {
  return getDaemonCommandDescriptor(req.command)?.sessionlessLeaseAdmissionExemption?.(req);
}

/**
 * ADR 0014: the ref-frame effect a request resolves to, honoring the
 * request-sensitive resolver form. Returns `undefined` for commands with no
 * daemon descriptor (never daemon-projected) — the completeness gate ensures
 * every daemon-projected command declares an effect, so `undefined` here means
 * the command does not reach a session-owning daemon leaf.
 */
export function resolveRefFrameEffect(req: DaemonRequest): RefFrameEffect | undefined {
  const effect = getDaemonCommandDescriptor(req.command)?.refFrameEffect;
  return typeof effect === 'function' ? effect(req) : effect;
}

export function resolveProviderDeviceResolutionIntent(
  req: DaemonRequest,
  params: {
    hasExistingSession: boolean;
    hasExplicitDeviceIdentity: boolean;
    hasDeviceSelectionInput: boolean;
  },
): DaemonProviderDeviceResolutionIntent {
  if (params.hasExistingSession) {
    return shouldPreferExplicitDeviceOverExistingSession(req) && params.hasExplicitDeviceIdentity
      ? 'explicit-device'
      : 'existing-session';
  }
  if (shouldSkipSessionlessProviderDevice(req)) return 'skip';
  if (params.hasDeviceSelectionInput) return 'explicit-device';
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
  const descriptor = getDaemonCommandDescriptor(req.command);
  // Lease-route requests manage lease lifecycle/artifacts, not a device
  // session: resolving a default device for provider scoping would spuriously
  // trigger local device discovery before any lease exists. Derived from the
  // route so a new lease-route command cannot regress it.
  if (descriptor?.route === 'lease') return true;
  const skip = descriptor?.skipSessionlessProviderDevice;
  return typeof skip === 'function' ? skip(req) : false;
}
