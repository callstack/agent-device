import { detectProjectRuntimeKind } from '../../utils/project-runtime.ts';
import { publicPlatformString } from '../../kernel/device.ts';
import type { SessionStore } from '../session-store.ts';
import type { DaemonRequest, SessionState } from '../types.ts';
import type { DoctorCheck, DoctorKind, DoctorOptions } from './session-doctor-types.ts';

const DEFAULT_METRO_HOST = '127.0.0.1';
const DEFAULT_METRO_PORT = 8081;
const REMOTE_CONNECTION_FLAG_KEYS = [
  'daemonBaseUrl',
  'tenant',
  'runId',
  'leaseId',
  'leaseProvider',
] as const;
const REMOTE_PROVIDER_FLAG_KEYS = [
  'provider',
  'providerSessionId',
  'providerApp',
  'providerOsVersion',
  'providerProject',
  'providerBuild',
  'providerSessionName',
  'awsProjectArn',
  'awsDeviceArn',
  'awsAppArn',
  'awsRegion',
  'awsInteractionMode',
] as const;

export function readDoctorOptions(
  req: DaemonRequest,
  session: SessionState | undefined,
): DoctorOptions {
  const kind = detectProjectRuntimeKind(req.meta?.cwd);
  const targetApp = readNonEmptyString(req.flags?.targetApp) ?? session?.appBundleId;
  const metroHost = readNonEmptyString(req.runtime?.metroHost) ?? DEFAULT_METRO_HOST;
  const metroPort = readPositivePort(req.runtime?.metroPort) ?? DEFAULT_METRO_PORT;
  return {
    targetApp,
    metroHost,
    metroPort,
    kind,
    remote: req.flags?.remote === true,
    shouldProbeMetro: shouldProbeMetro(req, kind),
  };
}

export function remoteConnectionChecks(
  req: DaemonRequest,
  options: { required?: boolean } = {},
): DoctorCheck[] {
  const evidence = remoteConnectionEvidence(req);
  if (!evidence) {
    if (!options.required) return [];
    return [
      {
        id: 'remote-connection',
        status: 'fail',
        summary: 'No remote daemon/session or provider scope is configured.',
        hint: 'Use connect, --remote-config <path>, or direct remote/provider flags for the command.',
      },
    ];
  }
  return [
    {
      id: 'remote-connection',
      status: options.required ? 'pass' : 'info',
      summary: 'Remote daemon/session or provider scope is configured.',
      evidence,
    },
  ];
}

export function sessionChecks(
  sessionStore: SessionStore,
  sessionName: string,
  session: SessionState | undefined,
  options: { remote?: boolean } = {},
): DoctorCheck[] {
  const sameDeviceSessions = session
    ? sessionStore
        .toArray()
        .filter(
          (candidate) =>
            candidate.name !== session.name &&
            candidate.device.platform === session.device.platform &&
            candidate.device.id === session.device.id,
        )
        .map((candidate) => candidate.name)
    : [];

  if (!session) {
    return [
      {
        id: 'session',
        status: 'info',
        summary: options.remote
          ? `No active session named ${sessionName}. Remote doctor will use configured remote scope.`
          : `No active session named ${sessionName}. Doctor will use device inventory only.`,
        hint: 'This is expected before a run. Use open when app foreground state matters.',
      },
    ];
  }

  return [
    {
      id: 'session',
      status: sameDeviceSessions.length > 0 ? 'warn' : 'pass',
      summary:
        sameDeviceSessions.length > 0
          ? `Other active sessions target the same device: ${sameDeviceSessions.join(', ')}`
          : `Active session ${session.name} targets ${session.device.name}`,
      hint:
        sameDeviceSessions.length > 0
          ? 'Close stale sessions before a QA run if they belong to old attempts.'
          : undefined,
      command:
        sameDeviceSessions.length > 0
          ? `agent-device close --session ${sameDeviceSessions[0]} --platform ${publicPlatformString(session.device)}`
          : undefined,
      evidence: {
        session: session.name,
        sameDeviceSessions,
        sessionStateDir: sessionStore.resolveSessionDir(session.name),
      },
    },
  ];
}

function shouldProbeMetro(req: DaemonRequest, kind: DoctorKind): boolean {
  return (
    kind !== 'auto' ||
    typeof req.runtime?.metroPort === 'number' ||
    typeof req.runtime?.metroHost === 'string'
  );
}

function remoteConnectionEvidence(req: DaemonRequest): Record<string, unknown> | undefined {
  const configured = Object.fromEntries(
    [...REMOTE_CONNECTION_FLAG_KEYS, ...REMOTE_PROVIDER_FLAG_KEYS].flatMap((key) =>
      typeof req.flags?.[key] === 'string' ? [[key, '<configured>']] : [],
    ),
  );
  const evidence = {
    ...configured,
    ...(req.flags?.sessionIsolation === 'tenant' ? { sessionIsolation: 'tenant' } : {}),
  };
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readPositivePort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
