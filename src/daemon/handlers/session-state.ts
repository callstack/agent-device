import { AppError, asAppError } from '@agent-device/kernel/errors';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import {
  appStateUse,
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
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { resolveAndroidSerialAllowlist } from '@agent-device/kernel/device-isolation';
import {
  hasExplicitSessionFlag,
  requireSessionOrExplicitSelector,
  resolveCommandDevice,
  selectorTargetsSessionDevice,
} from '../session-device-resolution.ts';
import { errorResponse } from '../response.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import {
  admitRuntimeOperations,
  admitRuntimeUse,
  type UnavailableRuntimeResponse,
} from '../runtime-admission.ts';
import type { RuntimeCommandHandlerParams } from '../session-runtime-admission.ts';

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

    return {
      ok: true,
      data: {
        platform: publicPlatformString(session.device),
        appName: appName ?? 'unknown',
        appBundleId: session.appBundleId,
        source: 'session',
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
    ensureReady: false,
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

export async function handleSessionStateCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore } = params;

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
        ensureReady: false,
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
      ensureReady: false,
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

function resolveAndroidSerialAllowlistForAppState(value: string | undefined): string[] | undefined {
  const allowlist = resolveAndroidSerialAllowlist(value);
  return allowlist ? [...allowlist].sort() : undefined;
}

function shutdownFailureMessage(shutdown: TargetShutdownResult): string {
  const message = shutdown.error?.message ?? shutdown.stderr.trim();
  return message.length > 0 ? message : 'Shutdown failed';
}
