import type {
  ClipboardReadInput,
  ClipboardWriteInput,
} from '@agent-device/contracts/clipboard-runtime';
import {
  clipboardReadUse,
  clipboardWriteUse,
} from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { contextFromFlags, type DaemonCommandContext } from '../context.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { admitRuntimeUse, type RuntimeAdmissionBindings } from '../runtime-admission.ts';
import { runtimeExecutionFromContext } from '../snapshot-runtime-capture-input.ts';
import { successText } from '../../utils/success-text.ts';
import { errorResponse, type DaemonFailureResponse } from './response.ts';
import { recordSessionAction } from './handler-utils.ts';
import { requireSessionOrExplicitSelector, resolveCommandDevice } from './session-device-utils.ts';

type ClipboardAction = 'read' | 'write';

/**
 * What the admit-then-bind step reports: either the refusal an unadmitted cell produced — nothing
 * has touched the device yet — or the one bound invocation to run. Mirrors
 * {@link ResolvedKeyboardExecution}'s shape for the same reason: the plan is chosen from the
 * parsed action, and only the chosen leg ever binds.
 */
type ResolvedClipboardExecution =
  | Readonly<{ ok: false; response: DaemonFailureResponse }>
  | Readonly<{
      ok: true;
      execute: (context: DaemonCommandContext) => Promise<Record<string, unknown>>;
    }>;

/**
 * `clipboard <read|write>`, on the same parse the retired leaf used. The subcommand is read
 * before any device is resolved, exactly as the retired daemon handler did, so a typo still
 * fails as `INVALID_ARGS` without waking a device.
 */
function readClipboardAction(positionals: readonly string[]): ClipboardAction | undefined {
  const action = (positionals[0] ?? '').toLowerCase();
  return action === 'read' || action === 'write' ? action : undefined;
}

function clipboardInput(context: DaemonCommandContext): ClipboardReadInput {
  return {
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

/**
 * `clipboard read`. The argument check stays inside the bound execution rather than moving ahead
 * of admission: the retired leaf validated it in `dispatchCommand`, downstream of the capability
 * gate, so an over-argued read on an unsupported device must still report the unsupported cell.
 */
async function executeClipboardRead(
  runtime: BoundDeviceRuntime<typeof clipboardReadUse>,
  context: DaemonCommandContext,
  positionals: readonly string[],
): Promise<Record<string, unknown>> {
  if (positionals.length !== 1) {
    throw new AppError('INVALID_ARGS', 'clipboard read does not accept additional arguments');
  }
  const text = await runtime.operations.readClipboard(clipboardInput(context));
  return { action: 'read', text };
}

/** `clipboard write <text…>`; `""` clears, so an empty string is a value, not a missing argument. */
async function executeClipboardWrite(
  runtime: BoundDeviceRuntime<typeof clipboardWriteUse>,
  context: DaemonCommandContext,
  positionals: readonly string[],
): Promise<Record<string, unknown>> {
  if (positionals.length < 2) {
    throw new AppError('INVALID_ARGS', 'clipboard write requires text (use "" to clear clipboard)');
  }
  const text = positionals.slice(1).join(' ');
  const input: ClipboardWriteInput = { ...clipboardInput(context), text };
  await runtime.operations.writeClipboard(input);
  return {
    action: 'write',
    textLength: Array.from(text).length,
    ...successText('Clipboard updated'),
  };
}

/**
 * The one place `clipboard` reaches a device (ADR 0019 §9). Exactly one action-selected use is
 * admitted and bound — `read` or `write`, never both. Each branch admits its own literal use, so
 * the bound runtime narrows from that instantiation rather than from an assertion. Both name the
 * bare command in their refusal: the retired `requireCommandSupported('clipboard', device)` gate
 * refused per command, not per subcommand, and the wording is parity-pinned.
 */
async function resolveBoundClipboardRuntime(
  params: Readonly<{
    device: DeviceInfo;
    action: ClipboardAction;
    positionals: readonly string[];
  }> &
    RuntimeAdmissionBindings,
): Promise<ResolvedClipboardExecution> {
  const { device, action, positionals, inspectFacts, bindDevice } = params;
  if (action === 'read') {
    const admission = await admitRuntimeUse({
      command: 'clipboard',
      device,
      use: clipboardReadUse,
      inspectFacts,
      bindDevice,
    });
    if (admission.type === 'response') return { ok: false, response: admission.response };
    const runtime = admission.runtime;
    return { ok: true, execute: (context) => executeClipboardRead(runtime, context, positionals) };
  }
  const admission = await admitRuntimeUse({
    command: 'clipboard',
    device,
    use: clipboardWriteUse,
    inspectFacts,
    bindDevice,
  });
  if (admission.type === 'response') return { ok: false, response: admission.response };
  const runtime = admission.runtime;
  return { ok: true, execute: (context) => executeClipboardWrite(runtime, context, positionals) };
}

export async function handleSessionClipboardCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, inspectFacts, bindDevice } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const guard = requireSessionOrExplicitSelector(PUBLIC_COMMANDS.clipboard, session, flags);
  if (guard) return guard;

  const positionals = req.positionals ?? [];
  const action = readClipboardAction(positionals);
  if (!action) {
    return errorResponse('INVALID_ARGS', 'clipboard requires a subcommand: read or write');
  }

  const device = await resolveCommandDevice({ session, flags, ensureReady: true });
  const bound = await resolveBoundClipboardRuntime({
    device,
    action,
    positionals,
    inspectFacts,
    bindDevice,
  });
  if (!bound.ok) return bound.response;

  const result = await bound.execute(
    contextFromFlags(logPath, req.flags, session?.appBundleId, session?.trace?.outPath),
  );
  recordSessionAction(sessionStore, session, req, req.command, result);
  return { ok: true, data: { platform: publicPlatformString(device), ...result } };
}
