/** Closed set of durable session resources that participate in device ownership settlement. */
const DURABLE_SESSION_RESOURCE_KINDS = [
  'app-log',
  'screen-recording',
  'audio-probe',
  'perf-capture',
] as const;

export type DurableSessionResourceKind = (typeof DURABLE_SESSION_RESOURCE_KINDS)[number];
