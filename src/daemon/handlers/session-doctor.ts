import path from 'node:path';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { readVersion } from '../../utils/version.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { appendAndroidChecks } from './session-doctor-android.ts';
import { appendAppChecks } from './session-doctor-app.ts';
import {
  appendDeviceInventoryCheck,
  type DoctorDeviceInventory,
  resolveDoctorDeviceForAppCheck,
} from './session-doctor-device.ts';
import { probeMetro } from './session-doctor-metro.ts';
import {
  readDoctorOptions,
  remoteConnectionChecks,
  sessionChecks,
} from './session-doctor-options.ts';
import {
  appendDoctorCheck,
  appendDoctorChecks,
  doctorSummary,
  sortChecks,
  summarizeDoctorStatus,
} from './session-doctor-output.ts';
import { appendToolchainChecks } from './session-doctor-toolchain.ts';
import type { DoctorCheck, DoctorOptions } from './session-doctor-types.ts';

export async function handleDoctorCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  androidAdbExecutor?: AndroidAdbExecutor;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore, androidAdbExecutor } = params;
  if (req.command !== PUBLIC_COMMANDS.doctor) return null;

  const session = sessionStore.get(sessionName);
  const options = readDoctorOptions(req, session);
  const stateDir = resolveDoctorStateDir(sessionStore, sessionName);
  const checks: DoctorCheck[] = [];
  appendDoctorChecks(
    checks,
    {
      id: 'agent-device',
      status: 'pass',
      summary: `agent-device ${readVersion()} using ${stateDir}`,
      evidence: { version: readVersion(), stateDir },
    },
    ...remoteConnectionChecks(req, { required: options.remote }),
    ...sessionChecks(sessionStore, sessionName, session, { remote: options.remote }),
  );

  if (options.remote) {
    return doctorResponse(checks, options);
  }

  const inventory = await appendDeviceInventoryCheck(checks, req, session);
  await appendToolchainChecks(checks, session?.device.platform ?? inventory?.platform);
  const appCheckDevice = await appendLocalDoctorChecks({
    androidAdbExecutor,
    checks,
    inventory,
    options,
    session,
  });
  return doctorResponse(checks, options, { device: appCheckDevice, includeMetro: true, inventory });
}

function resolveDoctorStateDir(sessionStore: SessionStore, sessionName: string): string {
  const sessionsDir = path.dirname(sessionStore.resolveSessionDir(sessionName));
  return path.basename(sessionsDir) === 'sessions' ? path.dirname(sessionsDir) : sessionsDir;
}

async function appendLocalDoctorChecks(params: {
  androidAdbExecutor?: AndroidAdbExecutor;
  checks: DoctorCheck[];
  inventory: DoctorDeviceInventory | undefined;
  options: DoctorOptions;
  session: SessionState | undefined;
}): Promise<DeviceInfo | undefined> {
  const { checks, inventory, options, session, androidAdbExecutor } = params;
  const appCheckDevice =
    session?.device ?? resolveDoctorDeviceForAppCheck(checks, inventory, options.targetApp);
  if (appCheckDevice) {
    await appendDeviceScopedDoctorChecks(checks, {
      androidAdbExecutor,
      device: appCheckDevice,
      options,
      session,
    });
  }
  if (options.shouldProbeMetro) {
    appendDoctorCheck(checks, await probeMetro(options.metroHost, options.metroPort, options.kind));
  }
  return appCheckDevice;
}

async function appendDeviceScopedDoctorChecks(
  checks: DoctorCheck[],
  params: {
    androidAdbExecutor?: AndroidAdbExecutor;
    device: DeviceInfo;
    options: DoctorOptions;
    session: SessionState | undefined;
  },
): Promise<void> {
  const { androidAdbExecutor, device, options, session } = params;
  await appendAppChecks(checks, { device, session, targetApp: options.targetApp });
  await appendAndroidChecks(checks, {
    androidAdbExecutor,
    device,
    metroPort: options.metroPort,
    shouldProbeMetro: options.shouldProbeMetro,
  });
}

function doctorResponse(
  checks: DoctorCheck[],
  options: DoctorOptions,
  scope: { device?: DeviceInfo; includeMetro?: boolean; inventory?: DoctorDeviceInventory } = {},
): DaemonResponse {
  const status = summarizeDoctorStatus(checks);
  return {
    ok: true,
    data: {
      status,
      summary: doctorSummary(status),
      kind: options.kind,
      platform: scope.device?.platform ?? scope.inventory?.platform,
      target: scope.device?.target ?? scope.inventory?.target,
      targetApp: options.targetApp,
      metro:
        scope.includeMetro && options.shouldProbeMetro
          ? { host: options.metroHost, port: options.metroPort }
          : undefined,
      checks: sortChecks(checks),
    },
  };
}
