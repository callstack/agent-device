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
  /**
   * The reader observed this request but not its path: `url` is the origin of
   * the connection it reused. Absent means `url` is the request URL as logged.
   */
  pathUnavailable?: boolean;
  /**
   * Why the request did not produce a response, as the app reported it. Absent means the request
   * was not observed failing; a missing `status` with no `error` means the reader simply never saw
   * a response for it.
   */
  error?: string;
  raw: string;
  line: number;
};
