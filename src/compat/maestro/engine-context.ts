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
  const expandedValues = new Map<string, string>();
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
    get expandedVariables(): Readonly<Record<string, string>> {
      return Object.fromEntries(expandedValues);
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
    invalidateObservation(): void {
      generation += 1;
      observation = undefined;
    },
    resolve(value: string): string {
      return resolveValue(value, currentValues(), recordExpandedValue);
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
    const rawValues = stringifyValues(scopedValues);
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawValues)) {
      resolved[key] = resolveValue(value, {
        ...currentValues(),
        ...rawValues,
        ...resolved,
        ...overrides,
      });
    }
    return resolved;
  }

  function recordExpandedValue(name: string, value: string): void {
    expandedValues.set(name, value);
  }
}

function stringifyValues(
  values: Record<string, string | number | boolean>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));
}

function resolveValue(
  value: string,
  values: Readonly<Record<string, string>>,
  onExpanded?: (name: string, value: string) => void,
  resolving = new Set<string>(),
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (match, key: string) => {
    if (!Object.hasOwn(values, key) || resolving.has(key)) return match;
    const resolved = resolveValue(values[key]!, values, onExpanded, new Set([...resolving, key]));
    onExpanded?.(key, resolved);
    return resolved;
  });
}
