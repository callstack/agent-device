export type WireEchoMode = 'always' | 'omit-default';

export type WireEchoOptions = {
  defaultValue?: unknown;
  mode?: WireEchoMode;
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

const TOUCH_WIRE_ECHO_FIELDS = {
  ...INTERACTION_REPEAT_WIRE_ECHO_FIELDS,
} as const satisfies Record<string, WireEchoOptions>;

const INTERACTION_WIRE_ECHO_FIELDS = {
  click: TOUCH_WIRE_ECHO_FIELDS,
  press: TOUCH_WIRE_ECHO_FIELDS,
  fill: {
    ...TOUCH_WIRE_ECHO_FIELDS,
    delayMs: FILL_DELAY_WIRE_ECHO,
  },
} as const satisfies Record<string, Record<string, WireEchoOptions>>;

export type InteractionWireEchoCommand = keyof typeof INTERACTION_WIRE_ECHO_FIELDS;

export function interactionWireEchoFromInput(
  command: InteractionWireEchoCommand,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return projectWireEchoSpecsFromInput(INTERACTION_WIRE_ECHO_FIELDS[command], input ?? {});
}

export function projectInteractionWireData(
  command: InteractionWireEchoCommand,
  input: Record<string, unknown> | undefined,
  base: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return projectWireEchoSpecsFromInput(INTERACTION_WIRE_ECHO_FIELDS[command], input ?? {}, base);
}

function projectWireEchoSpecsFromInput(
  specs: Record<string, WireEchoOptions>,
  input: Record<string, unknown>,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const projected = { ...base };
  for (const [key, spec] of Object.entries(specs)) {
    const value = input[key] === undefined ? spec.defaultValue : input[key];
    if (value === undefined || (spec.mode === 'omit-default' && value === spec.defaultValue)) {
      delete projected[key];
      continue;
    }
    projected[key] = value;
  }
  return Object.fromEntries(Object.entries(projected).filter(([, value]) => value !== undefined));
}
