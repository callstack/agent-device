import { AppError } from '../../kernel/errors.ts';
import type { MaestroObservation } from './engine-types.ts';

export type MaestroExecutionContext = ReturnType<typeof createMaestroExecutionContext>;

export function createMaestroExecutionContext(
  defaults: Record<string, string | number | boolean> = {},
  runtimeOverrides: Record<string, string> = {},
) {
  const overrides = { ...runtimeOverrides };
  let values = { ...stringifyValues(defaults), ...overrides };
  let generation = 0;
  let observation: MaestroObservation | undefined;

  return {
    get values(): Readonly<Record<string, string>> {
      return values;
    },
    get generation(): number {
      return generation;
    },
    get observation(): MaestroObservation | undefined {
      return observation?.generation === generation ? observation : undefined;
    },
    enter(scopedValues: Record<string, string | number | boolean> = {}): () => void {
      const previous = values;
      values = { ...previous, ...stringifyValues(scopedValues), ...overrides };
      return () => {
        values = previous;
      };
    },
    merge(output: Record<string, string>): void {
      values = { ...values, ...output, ...overrides };
    },
    recordObservation(next: MaestroObservation): void {
      if (next.generation !== generation) {
        throw new AppError(
          'COMMAND_FAILED',
          `Maestro observation generation ${next.generation} does not match ${generation}.`,
        );
      }
      observation = next;
    },
    recordMutation(): void {
      generation += 1;
      observation = undefined;
    },
    resolve(value: string): string {
      return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (match, key: string) =>
        Object.hasOwn(values, key) ? values[key]! : match,
      );
    },
  };
}

function stringifyValues(
  values: Record<string, string | number | boolean>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));
}
