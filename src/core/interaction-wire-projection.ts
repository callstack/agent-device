import { resolveCommandWireProjection } from './command-descriptor/registry.ts';
import type { WireEchoOptions } from './interaction-wire-echo.ts';

export type InteractionWireEchoCommand = 'click' | 'press' | 'fill';

export function interactionWireEchoFromInput(
  command: InteractionWireEchoCommand,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return projectWireEchoSpecsFromInput(readCommandWireEchoSpecs(command), input ?? {});
}

export function projectInteractionWireData(
  command: InteractionWireEchoCommand,
  input: Record<string, unknown> | undefined,
  base: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return projectWireEchoSpecsFromInput(readCommandWireEchoSpecs(command), input ?? {}, base);
}

function readCommandWireEchoSpecs(
  command: InteractionWireEchoCommand,
): Record<string, WireEchoOptions> {
  const projection = resolveCommandWireProjection(command);
  if (!projection) {
    throw new Error(`Missing wire projection descriptor for ${command}`);
  }
  return projection.wireEcho;
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
