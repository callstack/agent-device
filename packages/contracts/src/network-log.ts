// One parsed network-log entry.
//
// Lives here rather than in the daemon because the `network` command's output formatting
// (`commands/observability/`) is declared in terms of it: the daemon parses the log, the
// command surface renders what was parsed.

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
