import { AppError } from '../../kernel/errors.ts';
import type { MaestroObservation, MaestroRedactionVariable } from './engine-types.ts';

export type MaestroExecutionContext = ReturnType<typeof createMaestroExecutionContext>;

export function createMaestroExecutionContext(
  defaults: Record<string, string | number | boolean> = {},
  runtimeOverrides: Record<string, string> = {},
  publicVariableNames: Iterable<string> = [],
  onRedactionVariable?: (entry: MaestroRedactionVariable) => void,
) {
  const overrides = { ...runtimeOverrides };
  const publicNames = new Set(publicVariableNames);
  // Flow config and runFlow env values are stack-scoped; script output variables persist.
  let persistentValues = stringifyValues(defaults);
  const scopes: Record<string, string>[] = [];
  const redactionValues = new Map<string, Set<string>>();
  let cachedValues: Readonly<Record<string, string>> | undefined;
  let generation = 0;
  let observation: MaestroObservation | undefined;

  for (const [name, value] of Object.entries(overrides)) {
    recordSensitiveValue(name, value);
  }

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
    get redactionVariables(): readonly MaestroRedactionVariable[] {
      return [...redactionValues].flatMap(([name, values]) =>
        [...values].map((value) => ({ name, value })),
      );
    },
    enter(scopedValues: Record<string, string | number | boolean> = {}): () => void {
      const resolved = resolveScopedValues(scopedValues);
      scopes.push(resolved);
      cachedValues = undefined;
      return () => {
        const current = scopes.pop();
        if (current !== resolved) {
          throw new AppError(
            'COMMAND_FAILED',
            'Maestro environment scopes were left out of order.',
          );
        }
        cachedValues = undefined;
      };
    },
    merge(output: Record<string, string>): void {
      persistentValues = { ...persistentValues, ...output };
      cachedValues = undefined;
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
      return resolveValue(value, currentValues(), recordSensitiveValue);
    },
    resolveDeferred(value: string): string {
      return resolveValue(value, currentValues(), undefined, new Set(), false);
    },
    redact(value: string): string {
      return [...redactionValues]
        .flatMap(([name, values]) => [...values].map((entry) => ({ name, value: entry })))
        .sort((left, right) => right.value.length - left.value.length)
        .reduce((result, entry) => result.replaceAll(entry.value, `<var:${entry.name}>`), value);
    },
  };

  function currentValues(): Readonly<Record<string, string>> {
    if (cachedValues) return cachedValues;
    const scoped = scopes.reduce((values, scope) => ({ ...values, ...scope }), {
      ...persistentValues,
    });
    cachedValues = { ...scoped, ...overrides };
    return cachedValues;
  }

  function resolveScopedValues(
    scopedValues: Record<string, string | number | boolean>,
  ): Record<string, string> {
    const rawValues = stringifyValues(scopedValues);
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawValues)) {
      resolved[key] = resolveValue(
        value,
        {
          ...currentValues(),
          ...rawValues,
          ...resolved,
          ...overrides,
        },
        recordSensitiveValue,
        new Set(),
        false,
      );
      recordSensitiveValue(key, resolved[key]);
    }
    return resolved;
  }

  function recordSensitiveValue(name: string, value: string): void {
    if (publicNames.has(name) || value.length === 0) return;
    let values = redactionValues.get(name);
    if (!values) {
      values = new Set();
      redactionValues.set(name, values);
    }
    if (values.has(value)) return;
    values.add(value);
    onRedactionVariable?.({ name, value });
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
  failOnUnresolved = true,
): string {
  const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (match, key: string) => {
    if (!Object.hasOwn(values, key)) {
      if (!failOnUnresolved) return match;
      throw new AppError('INVALID_ARGS', `Maestro variable "${key}" is not defined.`);
    }
    if (resolving.has(key)) {
      if (!failOnUnresolved) return match;
      throw new AppError('INVALID_ARGS', `Maestro variable "${key}" has a cyclic reference.`);
    }
    const resolved = resolveValue(
      values[key]!,
      values,
      onExpanded,
      new Set([...resolving, key]),
      failOnUnresolved,
    );
    onExpanded?.(key, resolved);
    return resolved;
  });
  if (failOnUnresolved) assertNoUnsupportedInterpolation(resolved);
  return resolved;
}

function assertNoUnsupportedInterpolation(value: string): void {
  const interpolation = /\$\{[^{}]*\}/g;
  for (const match of value.matchAll(interpolation)) {
    if (isMaestroPlatformExpression(match[0])) continue;
    throw new AppError(
      'INVALID_ARGS',
      `Maestro interpolation "${match[0]}" is unresolved or unsupported.`,
    );
  }
}

function isMaestroPlatformExpression(value: string): boolean {
  const expression =
    /^\$\{\s*maestro\.platform\s*(?:==|!=)\s*(['"]).*\1(?:\s*(?:&&|\|\|).*)?\s*\}$/;
  return expression.test(value);
}
