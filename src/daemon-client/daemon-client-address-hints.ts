import type { DaemonResponse } from './daemon-client.ts';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';

/** Adds copyable addressing for a kept-alive replay session, without URL credentials. */
export function attachActiveSessionAddressHint(
  response: Extract<DaemonResponse, { ok: true }>,
  stateDir: string | undefined,
  remoteBaseUrl?: string,
): Extract<DaemonResponse, { ok: true }> {
  const data = response.data ?? {};
  const sessionName = typeof data.session === 'string' ? data.session : undefined;
  const addressFlags = [
    ...(remoteBaseUrl
      ? [`--daemon-base-url ${shellQuoteIfNeeded(publicRemoteEndpoint(remoteBaseUrl))}`]
      : []),
    ...(stateDir ? [`--state-dir ${shellQuoteIfNeeded(stateDir)}`] : []),
    ...(sessionName ? [`--session ${shellQuoteIfNeeded(sessionName)}`] : []),
  ];
  if (addressFlags.length === 0) return response;
  const addressHint =
    `This session's daemon was kept alive because its script left the session active; ` +
    `pass ${addressFlags.join(' ')} on your next command to reach it.` +
    (remoteBaseUrl
      ? ' If authentication is required, provide or configure --daemon-auth-token.'
      : '');
  const existingMessage = typeof data.message === 'string' ? data.message : undefined;
  return {
    ...response,
    data: {
      ...data,
      hint: addressHint,
      message: existingMessage ? `${existingMessage} ${addressHint}` : addressHint,
    },
  };
}

function publicRemoteEndpoint(baseUrl: string): string {
  const endpoint = new URL(baseUrl);
  endpoint.username = '';
  endpoint.password = '';
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.toString().replace(/\/+$/, '');
}
