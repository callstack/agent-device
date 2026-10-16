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
