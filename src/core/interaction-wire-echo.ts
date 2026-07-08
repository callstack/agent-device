export type WireEchoMode = 'always' | 'omit-default';

export type WireEchoOptions = {
  defaultValue?: unknown;
  mode?: WireEchoMode;
};

export type CommandWireProjection = {
  wireEcho: Record<string, WireEchoOptions>;
};

export const INTERACTION_REPEAT_WIRE_ECHO_FIELDS = {
  count: { defaultValue: 1, mode: 'omit-default' },
  intervalMs: { defaultValue: 0, mode: 'omit-default' },
  holdMs: { defaultValue: 0, mode: 'omit-default' },
  jitterPx: { defaultValue: 0, mode: 'omit-default' },
  doubleTap: { defaultValue: false, mode: 'omit-default' },
} as const satisfies Record<string, WireEchoOptions>;

export const FILL_DELAY_WIRE_ECHO = {
  defaultValue: 0,
} as const satisfies WireEchoOptions;
