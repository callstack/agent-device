import type { DaemonHealthPayload } from '@agent-device/contracts/daemon-http';
import { readDaemonCapabilities } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonInfo } from './daemon-client-metadata.ts';

export type RemoteDaemonHealth = {
  reachable: boolean;
  statusCode?: number;
  service?: string;
  version?: string;
  rpcProtocolVersion?: number;
  instanceId?: string;
  hostArch?: string;
  capabilities?: DaemonInfo['capabilities'];
  /** The daemon behind a proxy, as the proxy's health reported it. */
  upstream?: RemoteDaemonHealthLink;
  /** The probe ran out of its time budget before an answer, rather than failing outright. */
  timedOut?: true;
};

export type RemoteDaemonHealthLink = Pick<
  RemoteDaemonHealth,
  'service' | 'version' | 'rpcProtocolVersion' | 'instanceId' | 'hostArch' | 'capabilities'
>;

type RemoteHealthRecord = Omit<RemoteDaemonHealth, 'reachable' | 'statusCode' | 'timedOut'>;

export function readHealthPayload(body: string): RemoteHealthRecord {
  try {
    return readRemoteHealthRecord(JSON.parse(body));
  } catch {
    return {};
  }
}

/** The contract fields of a `/health` record, from the daemon or the cache; anything else is absent. */
export function readRemoteHealthRecord(parsed: unknown): RemoteHealthRecord {
  if (!parsed || typeof parsed !== 'object') return {};
  const record = parsed as Record<string, unknown>;
  const upstream =
    record.upstream && typeof record.upstream === 'object'
      ? readHealthLink(record.upstream as Record<string, unknown>)
      : undefined;
  return { ...readHealthLink(record), ...(upstream ? { upstream } : {}) };
}

function readHealthLink(parsed: Record<string, unknown>): RemoteDaemonHealthLink {
  return {
    service: isHealthService(parsed.service) ? parsed.service : undefined,
    version: readHealthVersion(parsed.version),
    rpcProtocolVersion:
      typeof parsed.rpcProtocolVersion === 'number' ? parsed.rpcProtocolVersion : undefined,
    ...(typeof parsed.instanceId === 'string' ? { instanceId: parsed.instanceId } : {}),
    ...(typeof parsed.hostArch === 'string' ? { hostArch: parsed.hostArch } : {}),
    ...(parsed.capabilities === undefined
      ? {}
      : { capabilities: readDaemonCapabilities(parsed.capabilities) }),
  };
}

// The remote picks what /health says and agents read the refusal built from it, so only a service
// the contract names and a version-shaped string are kept; anything else reads as absent.
const HEALTH_SERVICES: Readonly<Record<DaemonHealthPayload['service'], true>> = {
  'agent-device-daemon': true,
  'agent-device-proxy': true,
};
const HEALTH_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HEALTH_VERSION_MAX_LENGTH = 64;

function isHealthService(value: unknown): value is DaemonHealthPayload['service'] {
  return typeof value === 'string' && Object.hasOwn(HEALTH_SERVICES, value);
}

function readHealthVersion(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= HEALTH_VERSION_MAX_LENGTH &&
    HEALTH_VERSION.test(value)
    ? value
    : undefined;
}

/** Points `info` at the daemon a `/health` answer describes: its instances and capabilities. */
export function applyRemoteDaemonHealth(info: DaemonInfo, health: RemoteDaemonHealth): void {
  info.remoteInstanceId = health.instanceId;
  info.remoteUpstreamInstanceId = health.upstream?.instanceId;
  info.capabilities = (health.upstream ?? health).capabilities;
}
