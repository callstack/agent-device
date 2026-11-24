import { mkdtempForTestSync } from '@agent-device/test-kit';
import { vi } from 'vitest';

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
