import { randomBytes } from 'node:crypto';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  buildConnectionDeviceKey,
  resolveConnectionDeviceScope,
} from '@agent-device/remote/remote-connection-state';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonResponse } from '@agent-device/daemon-client';
import { vi } from 'vitest';
import type { CapturedDaemonRequest } from './cli-capture.ts';

export const sessionName = 'cloud-qa';
export const hostedDevice = {
  id: '00000000-0000-4000-8000-000000000001',
  vendor: 'provider-a',
  transport: 'agent-device-daemon',
  platform: 'ios',
  deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
  viewerUrl: 'https://viewer.example/session?token=private',
  attach: {
    kind: 'agent-device-daemon',
    daemonBaseUrl: 'https://daemon.example/device',
    daemonAuthToken: 'scoped-daemon-token',
  },
};

export function cloudEnv() {
  return {
    AGENT_DEVICE_SESSION: sessionName,
    AGENT_DEVICE_STATE_DIR: mkdtempForTestSync('agent-device-cloud-session-'),
    AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example',
    AGENT_DEVICE_CLOUD_API_KEY_ORIGIN: 'https://cloud.example',
    AGENT_DEVICE_CLOUD_API_KEY: 'cloud-api-test-key',
  };
}

export function stubCloudApi(
  response: typeof hostedDevice & { fallbackFrom?: string[] } = hostedDevice,
) {
  const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
    if (init.method === 'POST') return Response.json(response, { status: 201 });
    if (init.method === 'GET') return Response.json({ id: response.id, state: 'running' });
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export const connectArgs = ['connect', 'cloud', '--platform', 'ios', '--json'];

export function locationOf(env: ReturnType<typeof cloudEnv>) {
  return { stateDir: env.AGENT_DEVICE_STATE_DIR, session: env.AGENT_DEVICE_SESSION };
}

export function timeOutNextCreate(
  fetchMock: ReturnType<typeof stubCloudApi>,
  response?: Response,
  beforeReply?: () => void,
): void {
  const clock = vi.spyOn(Date, 'now');
  fetchMock.mockImplementationOnce(async () => {
    beforeReply?.();
    clock.mockReturnValue(Date.now() + 240_001);
    if (response) return response;
    throw new DOMException('request timed out', 'TimeoutError');
  });
}

export function postKey(init: RequestInit): string | null {
  return new Headers(init.headers).get('Idempotency-Key');
}

/** The same hosted daemon, announced as a proxy front that requires a lease before commands. */
export const proxyFrontDevice = {
  ...hostedDevice,
  attach: { ...hostedDevice.attach, leasing: 'proxy-front' as const },
};

const HOSTED_UDID = '0CD5D6AC-2B14-4C16-8360-8FA5EB7ECD54';

function mintLeaseId(): string {
  return randomBytes(16).toString('hex');
}

type ActiveLease = {
  tenantId: unknown;
  runId: unknown;
  clientId: unknown;
  deviceKey: string;
};

/**
 * Answers the proxy lease RPCs a proxy front serves: the allocate names the device, a lease id the
 * front already holds is reused, and a release ends it. Every other request goes to `inner`, except
 * that a command the front does not serve is refused unless it carries the lease metadata of an
 * active lease, as the real front does.
 */
export function withLeaseAllocation(
  inner?: (req: CapturedDaemonRequest) => Promise<DaemonResponse> | DaemonResponse,
) {
  const device = { udid: HOSTED_UDID, model: 'iPhone 16', osVersion: '26.2', physical: false };
  const deviceKey = buildConnectionDeviceKey(
    resolveConnectionDeviceScope({
      id: HOSTED_UDID,
      platform: 'ios',
      target: 'mobile',
      device,
    } as unknown as DeviceInfo),
  );
  const activeLeases = new Map<string, ActiveLease>();
  return async (req: CapturedDaemonRequest): Promise<DaemonResponse> => {
    if (req.command === 'lease_allocate' || req.command === 'lease_heartbeat') {
      return allocateOrRenew(req, activeLeases, device, deviceKey);
    }
    if (req.command === 'lease_release') return releaseLease(req, activeLeases);
    const refusal = refuseWithoutLeaseMeta(req, activeLeases);
    if (refusal) return refusal;
    return inner ? await inner(req) : { ok: true, data: {} };
  };
}

const SCOPE_MISMATCH: DaemonResponse = {
  ok: false,
  error: { code: 'INVALID_ARGS', message: 'Lease scope mismatch.' },
};

/** A renewal names the scope the lease was allocated under; it never replaces that scope. */
function allocateOrRenew(
  req: CapturedDaemonRequest,
  activeLeases: Map<string, ActiveLease>,
  device: Record<string, unknown>,
  deviceKey: string,
): DaemonResponse {
  const { tenantId, runId, clientId } = req.meta ?? {};
  // The client names the lease when its connection is a proxy; the front mints one otherwise.
  const leaseId = typeof req.meta?.leaseId === 'string' ? req.meta.leaseId : mintLeaseId();
  const held = activeLeases.get(leaseId);
  if (held && !sameScope(held, { tenantId, runId, clientId, deviceKey })) return SCOPE_MISMATCH;
  activeLeases.set(leaseId, { tenantId, runId, clientId, deviceKey });
  return {
    ok: true,
    data: {
      lease: {
        leaseId,
        tenantId,
        runId,
        backend: 'ios-instance',
        leaseProvider: 'proxy',
        deviceKey,
        clientId,
        device,
      },
      reused: held !== undefined,
    },
  };
}

function releaseLease(
  req: CapturedDaemonRequest,
  activeLeases: Map<string, ActiveLease>,
): DaemonResponse {
  const leaseId = req.meta?.leaseId;
  const held = typeof leaseId === 'string' ? activeLeases.get(leaseId) : undefined;
  if (typeof leaseId !== 'string' || held === undefined) {
    return { ok: true, data: { released: false, absent: true } };
  }
  if (!sameScope(held, scopeOf(req.meta ?? {}))) return SCOPE_MISMATCH;
  activeLeases.delete(leaseId);
  return { ok: true, data: { released: true } };
}

/** Mirrors the real proxy front: a command must name an active lease with its scope, or it is refused. */
function refuseWithoutLeaseMeta(
  req: CapturedDaemonRequest,
  activeLeases: ReadonlyMap<string, ActiveLease>,
): DaemonResponse | undefined {
  const meta = req.meta ?? {};
  const lease = typeof meta.leaseId === 'string' ? activeLeases.get(meta.leaseId) : undefined;
  const complete =
    typeof meta.tenantId === 'string' &&
    typeof meta.runId === 'string' &&
    typeof meta.clientId === 'string';
  if (lease !== undefined && complete && sameScope(lease, scopeOf(meta))) return undefined;
  const message =
    req.command === 'open'
      ? 'Proxy open requires leaseId, tenantId, runId, clientId, and deviceKey lease metadata.'
      : `Proxy ${req.command} requires leaseId, tenantId, runId, clientId, and deviceKey lease metadata.`;
  return { ok: false, error: { code: 'INVALID_ARGS', message } };
}

function scopeOf(meta: Record<string, unknown>): ActiveLease {
  return {
    tenantId: meta.tenantId,
    runId: meta.runId,
    clientId: meta.clientId,
    deviceKey: meta.deviceKey as string,
  };
}

function sameScope(a: ActiveLease, b: ActiveLease): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.runId === b.runId &&
    a.clientId === b.clientId &&
    a.deviceKey === b.deviceKey
  );
}
