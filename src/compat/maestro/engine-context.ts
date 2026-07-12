import { AppError } from '../../kernel/errors.ts';
import type { MaestroObservation } from './engine-types.ts';

export type MaestroExecutionContext = ReturnType<typeof createMaestroExecutionContext>;

export function createMaestroExecutionContext(
  defaults: Record<string, string | number | boolean> = {},
  runtimeOverrides: Record<string, string> = {},
) {
  const overrides = { ...runtimeOverrides };
  // Flow config and runFlow env values are stack-scoped; script output variables persist.
  let persistentValues = stringifyValues(defaults);
  const scopes: Record<string, string>[] = [];
  let generation = 0;
  let observation: MaestroObservation | undefined;

  return {
    get values(): Readonly<Record<string, string>> {
      return currentValues();
    },
    get generation(): number {
      return generation;
    },
    get observation(): MaestroObservation | undefined {
      return observation?.generation === generation ? observation : undefined;
    },
    enter(scopedValues: Record<string, string | number | boolean> = {}): () => void {
      const resolved = resolveScopedValues(scopedValues);
      scopes.push(resolved);
      return () => {
        const current = scopes.pop();
        if (current !== resolved) {
          throw new AppError(
            'COMMAND_FAILED',
            'Maestro environment scopes were left out of order.',
          );
        }
      };
    },
    merge(output: Record<string, string>): void {
      persistentValues = { ...persistentValues, ...output };
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
      return resolveValue(value, currentValues());
    },
  };

  function currentValues(): Record<string, string> {
    const scoped = scopes.reduce((values, scope) => ({ ...values, ...scope }), {
      ...persistentValues,
    });
    return { ...scoped, ...overrides };
  }

  function resolveScopedValues(
    scopedValues: Record<string, string | number | boolean>,
  ): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(stringifyValues(scopedValues))) {
      resolved[key] = resolveValue(value, { ...currentValues(), ...resolved, ...overrides });
    }
    return resolved;
  }
}

function stringifyValues(
  values: Record<string, string | number | boolean>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));
}

function resolveValue(value: string, values: Readonly<Record<string, string>>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? values[key]! : match,
  );
}
