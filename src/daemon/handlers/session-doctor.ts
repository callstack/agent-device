import path from 'node:path';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import { readVersion } from '../../utils/version.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { appendAndroidChecks } from './session-doctor-android.ts';
import { appendAppChecks } from './session-doctor-app.ts';
import { appendDeviceInventoryCheck, platformScopeChecks } from './session-doctor-device.ts';
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
import { appendReactNativeOverlayCheck } from './session-doctor-react-native.ts';
import type { DoctorCheck } from './session-doctor-types.ts';

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
    const status = summarizeDoctorStatus(checks);
    return {
      ok: true,
      data: {
        status,
        summary: doctorSummary(status),
        kind: options.kind,
        targetApp: options.targetApp,
        checks: sortChecks(checks),
      },
    };
  }

  const inventory = await appendDeviceInventoryCheck(checks, req, session);
  const device = session?.device;
  if (device) {
    appendDoctorChecks(checks, ...platformScopeChecks(device, options));
    await appendAppChecks(checks, { device, session, targetApp: options.targetApp });
    await appendAndroidChecks(checks, {
      device,
      metroPort: options.metroPort,
      shouldProbeMetro: options.shouldProbeMetro,
      androidAdbExecutor,
    });
    appendReactNativeOverlayCheck(checks, session, options);
  }
  if (options.shouldProbeMetro) {
    appendDoctorCheck(checks, await probeMetro(options.metroHost, options.metroPort, options.kind));
  }

  const status = summarizeDoctorStatus(checks);
  return {
    ok: true,
    data: {
      status,
      summary: doctorSummary(status),
      kind: options.kind,
      platform: device?.platform ?? inventory?.platform,
      target: device?.target ?? inventory?.target,
      targetApp: options.targetApp,
      metro: options.shouldProbeMetro
        ? { host: options.metroHost, port: options.metroPort }
        : undefined,
      checks: sortChecks(checks),
    },
  };
}

function resolveDoctorStateDir(sessionStore: SessionStore, sessionName: string): string {
  const sessionsDir = path.dirname(sessionStore.resolveSessionDir(sessionName));
  return path.basename(sessionsDir) === 'sessions' ? path.dirname(sessionsDir) : sessionsDir;
}
