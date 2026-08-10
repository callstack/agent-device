// One parsed network-log entry.
//
// Lives here because platform runtimes parse neutral host-supplied app-log text and the
// command surface renders the same cross-layer result shape.

export type NetworkEntry = {
  method?: string;
  url: string;
  status?: number;
  timestamp?: string;
  durationMs?: number;
  packetId?: string;
  headers?: string;
  requestBody?: string;
  responseBody?: string;
  raw: string;
  line: number;
};
