import {
  assertCommandPlatformExecution,
  type CommandPlatformExecution,
} from '@agent-device/contracts/command-platform-execution';
import type { DispatchedCommand } from '@agent-device/contracts/command';
import type { RefFrameEffect } from '@agent-device/contracts/replay';
import { isReadOnlyFindAction, parseFindArgs } from '@agent-device/selectors';
import { resolveSettingsRuntimePlan } from '@agent-device/contracts/platform-runtime-operations';
import type { DaemonCommandDescriptor } from './daemon-command-descriptor.ts';
import type { RecordingEffect } from './types.ts';

export const NO_PLATFORM_EXECUTION = { kind: 'none' } as const;
// Host-scoped platform work (ADR 0019): the descriptor consumes a neutral typed host service and
// binds no device runtime of its own.
export const HOST_PLATFORM_EXECUTION = { kind: 'host' } as const;

/**
 * Structural on purpose: the gate must see an *absent* discriminator, and the
 * registry's raw descriptor type — which forbids that — lives in this module's
 * consumer.
 */
type PlatformExecutionDeclarationSite = {
  readonly name: string;
  readonly platformExecution?: unknown;
};

/**
 * ADR 0019 §6: every descriptor declares its platform-execution mode explicitly.
 * An undeclared discriminator is a registry-load error, so a command cannot
 * acquire platform execution by omission.
 *
 * This gate sees one descriptor at a time. Platform execution delegated to
 * another command is covered by the CLI-route dominance gate in
 * `__tests__/platform-execution-cli-route.test.ts`.
 */
export function readDeclaredPlatformExecution(
  descriptor: PlatformExecutionDeclarationSite,
): CommandPlatformExecution {
  const declared = descriptor.platformExecution;
  if (declared === undefined) {
    throw new TypeError(
      `Command descriptor "${descriptor.name}" must declare platformExecution (none, host, inventory, or device-runtime); there is no registry-entry default`,
    );
  }
  assertCommandPlatformExecution(declared);
  return declared;
}

// #2016: a plain `close` (no app-target positional) has nothing to close via
// flags, so it's the only close shape eligible for the sessionless
// no-lease-anywhere admission bypass in request-admission.ts. `close <app>`
// resolves its device straight from flags when there's no session and must
// stay behind full lease/tenant admission.
export const resolvePlainCloseLeaseAdmissionExemption = (
  req: DispatchedCommand,
): { kind: 'unconditional' } | undefined =>
  (req.positionals?.length ?? 0) === 0 ? { kind: 'unconditional' } : undefined;

export const resolveDeferredProviderAppCatalogLeaseAdmissionExemption: NonNullable<
  DaemonCommandDescriptor['sessionlessLeaseAdmissionExemption']
> = (req) => {
  const provider = req.flags?.leaseProvider;
  return req.flags?.leaseId === undefined &&
    typeof provider === 'string' &&
    (req.flags?.platform === 'android' || req.flags?.platform === 'ios')
    ? { kind: 'provider-app-catalog', provider }
    : undefined;
};

// ADR 0014 request-sensitive ref-frame resolvers. The action is the leading
// positional (see keyboard/alert daemon writers in src/commands/system/index.ts
// and src/commands/capture/alert.ts). Only the read-only status probes preserve
// the frame; every mutating subaction crosses a device side effect.
//
// keyboard actions are status/get/dismiss/enter/return (src/commands/system/
// runtime/system.ts): status/get inspect, while dismiss hides the keyboard and
// enter/return dispatch a real return key. Anything other than a read is
// classified may-invalidate (the honest superset for unknown subactions).
const KEYBOARD_READ_ONLY_ACTIONS = new Set(['status', 'get']);
export const keyboardRefFrameEffect = (req: DispatchedCommand): RefFrameEffect =>
  readOnlySubactionRefFrameEffect(req, KEYBOARD_READ_ONLY_ACTIONS, 'status');

// alert actions are get/wait/accept/dismiss: get/wait read, accept/dismiss act.
const ALERT_READ_ONLY_ACTIONS = new Set(['get', 'wait']);
export const alertRefFrameEffect = (req: DispatchedCommand): RefFrameEffect =>
  readOnlySubactionRefFrameEffect(req, ALERT_READ_ONLY_ACTIONS, 'get');

export const keyboardRecordingEffect = (req: DispatchedCommand): RecordingEffect =>
  readOnlySubactionRecordingEffect(req, KEYBOARD_READ_ONLY_ACTIONS, 'status');

export const alertRecordingEffect = (req: DispatchedCommand): RecordingEffect =>
  readOnlySubactionRecordingEffect(req, ALERT_READ_ONLY_ACTIONS, 'get');

export const findRecordingEffect = (req: DispatchedCommand): RecordingEffect => {
  try {
    return isReadOnlyFindAction(parseFindArgs(req.positionals ?? []).action)
      ? 'observes-app'
      : 'mutates-app';
  } catch {
    // Invalid requests never record, but classify the unknown shape conservatively.
    return 'mutates-app';
  }
};

export const clipboardRecordingEffect = (req: DispatchedCommand): RecordingEffect =>
  readOnlySubactionRecordingEffect(req, new Set(['read']), '');

// A settings request reads only when it names a readable setting with nothing after it; every other
// settings request changes device state — including `settings text-size <category>`, which names the
// same word and performs a mutation. The leg comes from the same resolver the daemon admits with, so
// the classification and the operation it selects are one declaration rather than two that a test
// holds together.
const settingsRequestReads = (req: DispatchedCommand): boolean =>
  resolveSettingsRuntimePlan(req.positionals).kind === 'read';

export const settingsRecordingEffect = (req: DispatchedCommand): RecordingEffect =>
  settingsRequestReads(req) ? 'observes-app' : 'mutates-app';

export const settingsRefFrameEffect = (req: DispatchedCommand): RefFrameEffect =>
  settingsRequestReads(req) ? 'preserve' : 'may-invalidate';

function readOnlySubactionRefFrameEffect(
  req: DispatchedCommand,
  readOnlyActions: ReadonlySet<string>,
  defaultAction: string,
): RefFrameEffect {
  return readOnlyActions.has((req.positionals?.[0] ?? defaultAction).toLowerCase())
    ? 'preserve'
    : 'may-invalidate';
}

function readOnlySubactionRecordingEffect(
  req: DispatchedCommand,
  readOnlyActions: ReadonlySet<string>,
  defaultAction: string,
): RecordingEffect {
  return readOnlyActions.has((req.positionals?.[0] ?? defaultAction).toLowerCase())
    ? 'observes-app'
    : 'mutates-app';
}
