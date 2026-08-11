import type { InventoryUse } from './platform-module.ts';
import type { RuntimeUseDeclaration } from './platform-runtime.ts';

export type CommandPlatformExecution =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'legacy' }>
  | Readonly<{ kind: 'inventory'; use: InventoryUse }>
  | Readonly<{ kind: 'device-runtime'; use: RuntimeUseDeclaration }>
  | Readonly<{
      kind: 'device-runtime';
      uses: readonly [RuntimeUseDeclaration, ...RuntimeUseDeclaration[]];
    }>;

// The discriminated union cannot prove uniqueness or required/preferred disjointness inside
// readonly arrays. Validate those declaration invariants where descriptors enter the registry.
export function assertCommandPlatformExecution(
  value: unknown,
): asserts value is CommandPlatformExecution {
  if (value === null || typeof value !== 'object') throw invalidPlatformExecution();
  const declaration = value as Record<string, unknown>;
  const keys = Object.keys(declaration).sort();
  if (declaration['kind'] === 'none' && sameKeys(keys, ['kind'])) return;
  if (declaration['kind'] === 'legacy' && sameKeys(keys, ['kind'])) return;
  if (
    declaration['kind'] === 'inventory' &&
    sameKeys(keys, ['kind', 'use']) &&
    hasExactInventoryUse(declaration['use'])
  ) {
    return;
  }
  if (
    declaration['kind'] === 'device-runtime' &&
    sameKeys(keys, ['kind', 'use']) &&
    hasRuntimeUseDeclaration(declaration['use'])
  ) {
    return;
  }
  if (
    declaration['kind'] === 'device-runtime' &&
    sameKeys(keys, ['kind', 'uses']) &&
    hasRuntimeUseDeclarations(declaration['uses'])
  ) {
    return;
  }
  throw invalidPlatformExecution();
}

function hasRuntimeUseDeclarations(
  value: unknown,
): value is readonly [RuntimeUseDeclaration, ...RuntimeUseDeclaration[]] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (!value.every(hasRuntimeUseDeclaration)) return false;
  const identities = value.map(runtimeUseIdentity);
  return new Set(identities).size === identities.length;
}

function runtimeUseIdentity(use: RuntimeUseDeclaration): string {
  return JSON.stringify({
    required: [...use.required].sort(),
    preferred: [...use.preferred].sort(),
  });
}

function hasExactInventoryUse(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const use = value as Record<string, unknown>;
  return use['kind'] === 'device-inventory' && sameKeys(Object.keys(use).sort(), ['kind']);
}

function hasRuntimeUseDeclaration(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const use = value as Record<string, unknown>;
  const required = stringArray(use['required']);
  const preferred = stringArray(use['preferred']);
  if (!required || !preferred) return false;
  if (!hasUniqueValues(required) || !hasUniqueValues(preferred)) return false;
  if (!areDisjoint(required, preferred)) return false;
  return sameKeys(Object.keys(use).sort(), ['preferred', 'required']);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((key): key is string => typeof key === 'string') ? value : null;
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function areDisjoint(left: readonly string[], right: readonly string[]): boolean {
  const leftValues = new Set(left);
  return right.every((value) => !leftValues.has(value));
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidPlatformExecution(): TypeError {
  return new TypeError(
    'Command platform execution must declare exactly one of none, legacy, inventory, or device-runtime',
  );
}
