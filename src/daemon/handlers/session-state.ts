import { AppError, asAppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import {
  appStateUse,
  pairWearableUse,
  resolveDeviceReadinessRuntimePlan,
  shutdownTargetUse,
} from '@agent-device/contracts/platform-runtime-operations';
import {
  isApplePlatform,
  isIosFamily,
  isMacOs,
  publicPlatformString,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';
import { SessionStore } from '../session-store.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { AppleApplicationState } from '@agent-device/kernel/snapshot';
import { resolveAndroidSerialAllowlist } from '@agent-device/kernel/device-isolation';
import {
  hasExplicitSessionFlag,
  requireSessionOrExplicitSelector,
  resolveCommandDevice,
  selectorTargetsSessionDevice,
} from '../session-device-resolution.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import {
  admitRuntimeOperations,
  admitRuntimeUse,
  type UnavailableRuntimeResponse,
} from '../runtime-admission.ts';
import type { RuntimeCommandHandlerParams } from '../session-runtime-admission.ts';
import { errorResponse } from '@agent-device/kernel/contracts';

const IOS_APPSTATE_SESSION_REQUIRED_MESSAGE =
  'iOS appstate requires an active session on the target device. Run open first (for example: open --session sim --platform ios --device "<name>" <app>).';
const MACOS_APPSTATE_SESSION_REQUIRED_MESSAGE =
  'macOS appstate requires an active session on the target device. Run open first (for example: open --session macos --platform macos "System Settings").';

/** `boot --headless` reports an unsupported cell as a request error, not a device capability gap. */
function bootUnavailableResponse(headless: boolean): UnavailableRuntimeResponse {
  return (unavailable) =>
    errorResponse(
      headless ? 'INVALID_ARGS' : 'UNSUPPORTED_OPERATION',
      headless
        ? 'boot --headless is supported only for Android emulators.'
        : 'boot is not supported on this device',
      undefined,
      unavailable.hint ? { hint: unavailable.hint } : undefined,
    );
}

function requireInspectFacts(
  inspectFacts: InspectDeviceRuntimeFacts | undefined,
): InspectDeviceRuntimeFacts {
  if (inspectFacts) return inspectFacts;
  throw new AppError('COMMAND_FAILED', 'Device runtime facts inspection is unavailable.', {
    reason: 'runtime-gateway-missing',
  });
}

function requireBindDevice(bindDevice: BindDeviceRuntime | undefined): BindDeviceRuntime {
  if (bindDevice) return bindDevice;
  throw new AppError('COMMAND_FAILED', 'Device runtime binding is unavailable.', {
    reason: 'runtime-gateway-missing',
  });
}

function shutdownUnavailableResponse(fact: RuntimeOperationFact) {
  if (fact.available) return null;
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    'shutdown is supported only for Apple simulators and Android emulators.',
    undefined,
    fact.hint ? { hint: fact.hint } : undefined,
  );
}

function hasAndroidAvdIdentity(
  selectedName: string | undefined,
  sessionDevice: DeviceInfo | undefined,
): boolean {
  return Boolean(
    selectedName?.trim() ||
    (sessionDevice?.platform === 'android' && sessionDevice.kind === 'emulator'),
  );
}

/**
 * The session app's state as a live runner reads it, when this device's owner admits the read;
 * nothing otherwise, so the session record alone answers and no state is invented. The owner never
 * starts a runner for it. A runner that cannot answer right now (busy, mid-restart) leaves the
 * session answer as it was and says so in the log; a cancelled request stays cancelled.
 */
async function readAppleSessionAppState(
  params: RuntimeCommandHandlerParams,
  session: Readonly<{ device: DeviceInfo; appBundleId?: string }>,
): Promise<AppleApplicationState | undefined> {
  if (!session.appBundleId) return undefined;
  const admitted = await admitRuntimeUse({
    command: 'appstate',
    device: session.device,
    use: appStateUse,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (admitted.type === 'response') return undefined;
  try {
    const read = await admitted.runtime.operations.appState({ appBundleId: session.appBundleId });
    return read.applicationState;
  } catch (error) {
    if (isRequestCanceledError(error)) throw error;
    emitDiagnostic({
      level: 'warn',
      phase: 'apple_appstate_runner_read_failed',
      data: { code: asAppError(error).code, message: asAppError(error).message },
    });
    return undefined;
  }
}

// App-state supports both live sessions and explicit device selection in one compatibility path.
// fallow-ignore-next-line complexity
async function handleAppStateCommand(params: RuntimeCommandHandlerParams): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const normalizedPlatform = flags.platform;

  if (!session && hasExplicitSessionFlag(flags)) {
    const message =
      normalizedPlatform === 'ios'
        ? `No active session "${sessionName}". Run open with --session ${sessionName} first.`
        : `No active session "${sessionName}". Run open with --session ${sessionName} first, or omit --session to query by device selector.`;
    return errorResponse('SESSION_NOT_FOUND', message);
  }

  const guard = requireSessionOrExplicitSelector('appstate', session, flags);
  if (guard) return guard;

  const shouldUseSessionStateForApple =
    isApplePlatform(session?.device.platform) && selectorTargetsSessionDevice(flags, session);
  const targetsIos = normalizedPlatform === 'ios';
  const targetsMacOs = normalizedPlatform === 'macos';

  if (targetsIos && !shouldUseSessionStateForApple) {
    return errorResponse('SESSION_NOT_FOUND', IOS_APPSTATE_SESSION_REQUIRED_MESSAGE);
  }
  if (targetsMacOs && !shouldUseSessionStateForApple) {
    return errorResponse('SESSION_NOT_FOUND', MACOS_APPSTATE_SESSION_REQUIRED_MESSAGE);
  }

  if (shouldUseSessionStateForApple && session) {
    const appName = session.appName ?? session.appBundleId;
    if (!session.appName && !session.appBundleId) {
      if (
        isMacOs(session.device) &&
        session.surface &&
        session.surface !== 'app' &&
        session.surface !== 'frontmost-app'
      ) {
        return {
          ok: true,
          data: {
            platform: publicPlatformString(session.device),
            appName: session.surface,
            appBundleId: session.appBundleId,
            source: 'session',
            surface: session.surface,
          },
        };
      }

      const sessionPlatform = isMacOs(session.device) ? 'macOS' : 'iOS';
      return errorResponse(
        'COMMAND_FAILED',
        `No foreground app is tracked for this ${sessionPlatform} session. Open an app in the session, then retry appstate.`,
      );
    }

    const state = await readAppleSessionAppState(params, session);
    return {
      ok: true,
      data: {
        platform: publicPlatformString(session.device),
        appName: appName ?? 'unknown',
        appBundleId: session.appBundleId,
        source: state ? 'runner' : 'session',
        ...(state ? { state } : {}),
        surface: session.surface ?? 'app',
        ...(isIosFamily(session.device)
          ? {
              device_udid: session.device.id,
              ios_simulator_device_set: session.device.simulatorSetPath ?? null,
            }
          : {}),
      },
    };
  }

  const device = await resolveCommandDevice({
    session,
    flags,
  });
  if (isIosFamily(device)) {
    return errorResponse('SESSION_NOT_FOUND', IOS_APPSTATE_SESSION_REQUIRED_MESSAGE);
  }
  if (isMacOs(device)) {
    return errorResponse('SESSION_NOT_FOUND', MACOS_APPSTATE_SESSION_REQUIRED_MESSAGE);
  }
  const admitted = await admitRuntimeUse({
    command: 'appstate',
    device,
    use: appStateUse,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
    unavailableResponse: (unavailable) =>
      errorResponse(
        'UNSUPPORTED_OPERATION',
        device.platform === 'web'
          ? 'appstate is not supported on web.'
          : 'appstate is not supported on this device',
        undefined,
        unavailable.hint ? { hint: unavailable.hint } : undefined,
      ),
  });
  if (admitted.type === 'response') return admitted.response;
  const runtime = admitted.runtime;
  await runtime.operations.ensureReady({
    serial: flags.serial,
    androidSerialAllowlist: resolveAndroidSerialAllowlistForAppState(flags.androidDeviceAllowlist),
  });
  const state = await runtime.operations.appState();
  return {
    ok: true,
    data: {
      platform: publicPlatformString(device),
      package: state.package,
      activity: state.activity,
    },
  };
}

// This dispatcher is the sole daemon owner for the session-state command family.
// fallow-ignore-next-line complexity
export async function handleSessionStateCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore } = params;

  if (req.command === 'pair-wearable') {
    const input = readPairWearableInput(req.input);
    const device = await resolveCommandDevice({
      session: undefined,
      flags:
        input.phone.platform === 'ios'
          ? { platform: 'ios', udid: input.phone.deviceId }
          : { platform: 'android', serial: input.phone.deviceId },
      androidAvdSelection: 'include-stopped',
    });
    const admitted = await admitRuntimeUse({
      command: 'pair-wearable',
      device,
      use: pairWearableUse,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
      unavailableResponse: (unavailable) =>
        errorResponse(
          'UNSUPPORTED_OPERATION',
          'wearable pairing is supported only for iPhone/iPad Simulators and Android phone targets.',
          undefined,
          unavailable.hint ? { hint: unavailable.hint } : undefined,
        ),
    });
    if (admitted.type === 'response') return admitted.response;
    const result = await admitted.runtime.operations.pairWearable({
      wearable: input.wearable,
      boot: input.boot,
    });
    return {
      ok: true,
      data: {
        pairId: result.pairId,
        phone: serializePairingDevice(result.phone),
        wearable: serializePairingDevice(result.wearable),
        status: result.status,
        ...(result.remainingHumanStep ? { remainingHumanStep: result.remainingHumanStep } : {}),
      },
    };
  }

  if (req.command === 'boot') {
    const session = sessionStore.get(sessionName);
    const flags = req.flags ?? {};
    const guard = requireSessionOrExplicitSelector(req.command, session, flags);
    if (guard) return guard;

    const resolvedAndroidSerialAllowlist = resolveAndroidSerialAllowlist(
      flags.androidDeviceAllowlist,
    );
    const androidSerialAllowlist = resolvedAndroidSerialAllowlist
      ? [...resolvedAndroidSerialAllowlist].sort()
      : undefined;
    const plan = resolveDeviceReadinessRuntimePlan({ headless: flags.headless === true });

    let device: DeviceInfo;
    try {
      device = await resolveCommandDevice({
        session,
        flags,
        androidAvdSelection: 'include-stopped',
      });
    } catch (error) {
      const appErr = asAppError(error);
      if (
        plan.kind === 'boot-target-headless' &&
        !hasAndroidAvdIdentity(flags.device, session?.device) &&
        appErr.code === 'DEVICE_NOT_FOUND'
      ) {
        return errorResponse(
          'INVALID_ARGS',
          'boot --headless requires --device <avd-name> (or an Android emulator session target).',
        );
      }
      throw error;
    }

    if (flags.target && (device.target ?? 'mobile') !== flags.target) {
      return errorResponse(
        'DEVICE_NOT_FOUND',
        `No ${device.platform} device found matching --target ${flags.target}.`,
      );
    }

    const admitted = await admitRuntimeOperations({
      command: 'boot',
      device,
      required: plan.use.required,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
      unavailableResponse: bootUnavailableResponse(plan.kind === 'boot-target-headless'),
    });
    if (admitted.type === 'response') return admitted.response;

    const input = { serial: flags.serial, androidSerialAllowlist };
    if (plan.kind === 'boot-target-headless') {
      device = await (await admitted.bind(device, plan.use)).operations.bootTargetHeadless(input);
    } else {
      device = await (await admitted.bind(device, plan.use)).operations.bootTarget(input);
    }

    return {
      ok: true,
      data: {
        platform: publicPlatformString(device),
        target: device.target ?? 'mobile',
        device: device.name,
        id: device.id,
        kind: device.kind,
        booted: true,
        // Additive Apple-OS discriminant; Apple devices only. Gate on the platform
        // (not just field presence) so a non-Apple record with a stray appleOs never
        // surfaces it.
        ...(isApplePlatform(device.platform) && device.appleOs ? { appleOs: device.appleOs } : {}),
      },
    };
  }

  if (req.command === 'shutdown') {
    const activeSession = sessionStore.get(sessionName);
    const flags = req.flags ?? {};
    const guard = requireSessionOrExplicitSelector(req.command, activeSession, flags);
    if (guard) return guard;

    const device = await resolveCommandDevice({
      flags,
      session: activeSession,
      androidAvdSelection: 'include-stopped',
    });
    const inspectFacts = requireInspectFacts(params.inspectFacts);
    const facts = await inspectFacts(device);
    const unsupported = shutdownUnavailableResponse(facts.operations.shutdownTarget);
    if (unsupported) return unsupported;

    if (
      activeSession &&
      activeSession.device.platform === device.platform &&
      activeSession.device.id === device.id
    ) {
      return errorResponse(
        'DEVICE_IN_USE',
        'Cannot shut down an active session device directly. Use close --shutdown to end the session and turn off the simulator/emulator.',
        {
          hint: `Run agent-device close --shutdown --session ${sessionName}`,
          session: sessionName,
          platform: publicPlatformString(device),
          target: device.target ?? 'mobile',
          device: device.name,
          id: device.id,
          kind: device.kind,
        },
      );
    }

    const bindDevice = requireBindDevice(params.bindDevice);
    const shutdown = await (
      await bindDevice(device, shutdownTargetUse)
    ).operations.shutdownTarget();
    if (!shutdown.success) {
      return errorResponse(
        shutdown.error?.code ?? 'COMMAND_FAILED',
        shutdownFailureMessage(shutdown),
        {
          platform: publicPlatformString(device),
          target: device.target ?? 'mobile',
          device: device.name,
          id: device.id,
          kind: device.kind,
          shutdown,
        },
      );
    }

    return {
      ok: true,
      data: {
        platform: publicPlatformString(device),
        target: device.target ?? 'mobile',
        device: device.name,
        id: device.id,
        kind: device.kind,
        shutdown,
        // Additive Apple-OS discriminant; Apple devices only. Gate on the platform
        // (not just field presence) so a non-Apple record with a stray appleOs never
        // surfaces it.
        ...(isApplePlatform(device.platform) && device.appleOs ? { appleOs: device.appleOs } : {}),
      },
    };
  }

  if (req.command === 'appstate') {
    return await handleAppStateCommand({
      req,
      sessionName,
      sessionStore,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    });
  }

  return null;
}

function readPairWearableInput(value: unknown): {
  phone: { platform: 'ios' | 'android'; deviceId: string };
  wearable?: { deviceId?: string; name?: string };
  boot: boolean;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'pair-wearable requires an input object.');
  }
  const record = value as Record<string, unknown>;
  const phone = record.phone;
  if (!phone || typeof phone !== 'object' || Array.isArray(phone)) {
    throw new AppError('INVALID_ARGS', 'pair-wearable requires phone.platform and phone.deviceId.');
  }
  const phoneRecord = phone as Record<string, unknown>;
  const platform = phoneRecord.platform;
  const deviceId = typeof phoneRecord.deviceId === 'string' ? phoneRecord.deviceId.trim() : '';
  if ((platform !== 'ios' && platform !== 'android') || deviceId.length === 0) {
    throw new AppError(
      'INVALID_ARGS',
      'phone.platform must be ios or android and phone.deviceId must be non-empty.',
    );
  }
  const wearable = readWearableSelector(record.wearable);
  if (typeof record.boot !== 'boolean') {
    throw new AppError('INVALID_ARGS', 'pair-wearable requires boolean boot.');
  }
  return { phone: { platform, deviceId }, ...(wearable ? { wearable } : {}), boot: record.boot };
}

function readWearableSelector(value: unknown): { deviceId?: string; name?: string } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'wearable must be an object with deviceId or name.');
  }
  const record = value as Record<string, unknown>;
  const deviceId = typeof record.deviceId === 'string' ? record.deviceId.trim() : undefined;
  const name = typeof record.name === 'string' ? record.name.trim() : undefined;
  if (!deviceId && !name) {
    throw new AppError('INVALID_ARGS', 'wearable must include a non-empty deviceId or name.');
  }
  return { ...(deviceId ? { deviceId } : {}), ...(name ? { name } : {}) };
}

function serializePairingDevice(device: DeviceInfo) {
  return {
    platform: publicPlatformString(device),
    ...(device.appleOs ? { appleOs: device.appleOs } : {}),
    id: device.id,
    name: device.name,
    kind: device.kind,
    target: device.target ?? 'mobile',
    ...(typeof device.booted === 'boolean' ? { booted: device.booted } : {}),
  };
}

function resolveAndroidSerialAllowlistForAppState(value: string | undefined): string[] | undefined {
  const allowlist = resolveAndroidSerialAllowlist(value);
  return allowlist ? [...allowlist].sort() : undefined;
}

function shutdownFailureMessage(shutdown: TargetShutdownResult): string {
  const message = shutdown.error?.message ?? shutdown.stderr.trim();
  return message.length > 0 ? message : 'Shutdown failed';
}
