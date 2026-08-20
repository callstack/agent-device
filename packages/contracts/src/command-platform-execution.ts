import type { InventoryUse } from './platform-module.ts';
import type { RuntimeUseDeclaration } from './platform-runtime.ts';
import { runtimeUseIdentity } from './platform-runtime-use.ts';

export type CommandPlatformExecution =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'legacy' }>
  | Readonly<{ kind: 'inventory'; use: InventoryUse }>
  | Readonly<{ kind: 'device-runtime'; use: RuntimeUseDeclaration }>
  | Readonly<{
      kind: 'device-runtime';
      uses: readonly [RuntimeUseDeclaration, ...RuntimeUseDeclaration[]];
    }>;

// The discriminated union cannot prove uniqueness or operation-category disjointness inside
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

function hasExactInventoryUse(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const use = value as Record<string, unknown>;
  return use['kind'] === 'device-inventory' && sameKeys(Object.keys(use).sort(), ['kind']);
}

function hasRuntimeUseDeclaration(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const use = value as Record<string, unknown>;
  const categories = [
    stringArray(use['required']),
    stringArray(use['preferred']),
    stringArray(use['conditional'] ?? []),
  ];
  if (!hasValidRuntimeUseCategories(categories)) return false;
  const operations = categories.flat();
  if (new Set(operations).size !== operations.length) return false;
  return sameKeys(
    Object.keys(use).sort(),
    use['conditional'] === undefined
      ? ['preferred', 'required']
      : ['conditional', 'preferred', 'required'],
  );
}

function hasValidRuntimeUseCategories(
  categories: readonly (string[] | null)[],
): categories is readonly string[][] {
  return categories.every(
    (category): category is string[] => category !== null && hasUniqueValues(category),
  );
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((key): key is string => typeof key === 'string') ? value : null;
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidPlatformExecution(): TypeError {
  return new TypeError(
    'Command platform execution must declare exactly one of none, legacy, inventory, or device-runtime',
  );
}
