import type { SessionRuntimeHints } from '../kernel/contracts.ts';
import { stopMetroCompanion } from './client-metro-companion.ts';
import { resolveRuntimeTransportHints } from '../utils/runtime-transport.ts';

export type { MetroBridgeDescriptor } from './metro-types.ts';

export function resolveRuntimeTransport(
  runtime: SessionRuntimeHints | undefined,
): { host: string; port: number; scheme: 'http' | 'https' } | undefined {
  return resolveRuntimeTransportHints(runtime);
}

export type MetroTunnelPingMessage = {
  type: 'ping';
  timestamp: number;
};

export type MetroTunnelPongMessage = {
  type: 'pong';
  timestamp: number;
};

export type MetroTunnelHttpRequestMessage = {
  type: 'http-request';
  requestId: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
};

export type MetroTunnelHttpResponseMessage = {
  type: 'http-response';
  requestId: string;
  status: number;
  headers: Record<string, string>;
  bodyBase64?: string;
};

export type MetroTunnelHttpErrorMessage = {
  type: 'http-error';
  requestId: string;
  message: string;
};

export type MetroTunnelWebSocketOpenMessage = {
  type: 'ws-open';
  streamId: string;
  path: string;
  headers?: Record<string, string>;
};

export type MetroTunnelWebSocketOpenResultMessage = {
  type: 'ws-open-result';
  streamId: string;
  success: boolean;
  headers?: Record<string, string>;
  error?: string;
};

export type MetroTunnelWebSocketFrameMessage = {
  type: 'ws-frame';
  streamId: string;
  dataBase64: string;
  binary: boolean;
};

export type MetroTunnelWebSocketCloseMessage = {
  type: 'ws-close';
  streamId: string;
  code?: number;
  reason?: string;
};

export type MetroTunnelRequestMessage =
  | MetroTunnelPingMessage
  | MetroTunnelHttpRequestMessage
  | MetroTunnelWebSocketOpenMessage
  | MetroTunnelWebSocketFrameMessage
  | MetroTunnelWebSocketCloseMessage;

export type MetroTunnelResponseMessage =
  | MetroTunnelPongMessage
  | MetroTunnelHttpResponseMessage
  | MetroTunnelHttpErrorMessage
  | MetroTunnelWebSocketOpenResultMessage
  | MetroTunnelWebSocketFrameMessage
  | MetroTunnelWebSocketCloseMessage;

export type StopMetroTunnelOptions = {
  projectRoot: string;
  profileKey?: string;
  consumerKey?: string;
};

export async function stopMetroTunnel(options: StopMetroTunnelOptions): Promise<void> {
  await stopMetroCompanion(options);
}
