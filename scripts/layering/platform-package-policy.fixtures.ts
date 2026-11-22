// The scan input the managed-platform rules are judged against: package declarations and platform
// sources a compliant tree produces, plus the host-kit sources of this checkout. Both the package
// policy and the exec-reachability derivation need one fixture set, so a fixture that stops being
// compliant fails the same way in either test.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_PLATFORM_FAMILIES,
  checkPlatformPackagePolicy,
  type PlatformPackageDeclaration,
} from './platform-package-policy.ts';
import { hostKitSources } from './host-kit-runtime-reach.ts';

const inventoryModuleNames = {
  apple: 'appleInventoryModule',
  android: 'androidInventoryModule',
  harmonyos: 'harmonyosInventoryModule',
  vega: 'vegaInventoryModule',
  linux: 'linuxInventoryModule',
  web: 'webInventoryModule',
} as const;

export const MANAGED_FAMILIES = ['web', 'vega', 'harmonyos', 'linux'] as const;

export function isManagedFamily(family: string): boolean {
  return (MANAGED_FAMILIES as readonly string[]).includes(family);
}

function managedPackageName(family: string): string {
  return `@agent-device/${family}`;
}

/** The managed macOS leaf package: it holds a leaf of the bundled `apple` family, not a family. */
export function macOsLeafDeclaration(): PlatformPackageDeclaration {
  return {
    dir: 'packages/platform-macos',
    family: 'macos',
    name: '@agent-device/macos',
    managedClaim: { platform: 'apple', appleOs: 'macos', apiVersion: 3 },
    publishedSubpaths: ['./agent-device'],
    private: true,
    exportedSubpaths: ['@agent-device/macos/agent-device'],
  };
}

/** Every platform package declaration, or only the family packages for a test that edits them by index. */
export function declarations(scope: 'all' | 'families' = 'all'): PlatformPackageDeclaration[] {
  return scope === 'families'
    ? familyDeclarations()
    : [...familyDeclarations(), macOsLeafDeclaration()];
}

function familyDeclarations(): PlatformPackageDeclaration[] {
  return CANONICAL_PLATFORM_FAMILIES.map((family) => ({
    dir: `packages/platform-${family}`,
    family,
    name: isManagedFamily(family) ? managedPackageName(family) : `@agent-device/platform-${family}`,
    ...(isManagedFamily(family)
      ? {
          managedClaim: { platform: family, apiVersion: 3 },
          publishedSubpaths: ['./agent-device'],
        }
      : {}),
    private: true,
    exportedSubpaths:
      family === 'apple'
        ? [
            '@agent-device/platform-apple',
            '@agent-device/platform-apple/app-lifecycle',
            '@agent-device/platform-apple/app-resolution',
            '@agent-device/platform-apple/debug-symbols',
            '@agent-device/platform-apple/doctor',
            '@agent-device/platform-apple/install-artifact',
            '@agent-device/platform-apple/macos-desktop',
            '@agent-device/platform-apple/macos-leaf',
            '@agent-device/platform-apple/perf',
            '@agent-device/platform-apple/physical-device',
            '@agent-device/platform-apple/plist',
            '@agent-device/platform-apple/runner/operations',
            '@agent-device/platform-apple/runner-owner',
            '@agent-device/platform-apple/session-observation',
            '@agent-device/platform-apple/simctl',
            '@agent-device/platform-apple/snapshot-source',
            '@agent-device/platform-apple/simulator',
            '@agent-device/platform-apple/simulator-boot',
            '@agent-device/platform-apple/tool-provider',
          ]
        : family === 'android'
          ? [
              '@agent-device/platform-android',
              '@agent-device/platform-android/adb-host',
              '@agent-device/platform-android/device-boot',
              '@agent-device/platform-android/mechanics',
              '@agent-device/platform-android/snapshot-capture-fixtures',
              '@agent-device/platform-android/ui-hierarchy-fixtures',
            ]
          : isManagedFamily(family)
            ? [`${managedPackageName(family)}/agent-device`]
            : [`@agent-device/platform-${family}`],
  }));
}

export function facade(family: (typeof CANONICAL_PLATFORM_FAMILIES)[number]): string {
  return [
    "import type { DeviceInventoryHost, InventoryPlatformModule, PlatformModuleMetadata } from '@agent-device/contracts/platform';",
    'const metadata = Object.freeze({',
    `  family: '${family}',`,
    '} satisfies PlatformModuleMetadata);',
    'export const inventoryModule = Object.freeze({',
    '  ...metadata,',
    '  loadInventory: async (host: DeviceInventoryHost) => {',
    "    const { createInventory } = await import('./inventory.ts');",
    '    return createInventory(host);',
    '  },',
    '} satisfies InventoryPlatformModule);',
  ].join('\n');
}

export function composition(families = CANONICAL_PLATFORM_FAMILIES): string {
  return [
    "import { createPlatformModuleRegistry } from '@agent-device/contracts/platform';",
    ...families.map(
      (family) =>
        `import { inventoryModule as ${inventoryModuleNames[family]} } from '@agent-device/platform-${family}';`,
    ),
    'export const platformModuleRegistry = createPlatformModuleRegistry([',
    ...families.map((family) => `  ${inventoryModuleNames[family]},`),
    ']);',
  ].join('\n');
}

/** The sources a compliant tree of every canonical family produces. */
export function validSources(): Map<string, string> {
  return new Map([
    ['src/platform-runtime.ts', composition()],
    ...CANONICAL_PLATFORM_FAMILIES.map(
      (family) => [`packages/platform-${family}/src/index.ts`, facade(family)] as const,
    ),
  ]);
}

/**
 * Every host-kit source of this checkout, so the exec-reachability rule is derived from the graph that
 * decides it rather than assumed. A managed package's host-kit import is only answerable when the scan
 * can see what host-kit loads.
 */
export function checkoutHostKitSources(): ReadonlyMap<string, string> {
  const root = fileURLToPath(new URL('../../packages/host-kit/src', import.meta.url));
  const all = new Map<string, string>();
  for (const relative of fs.readdirSync(root, { recursive: true })) {
    const name = String(relative);
    if (!name.endsWith('.ts')) continue;
    all.set(
      `packages/host-kit/src/${name.split(path.sep).join('/')}`,
      fs.readFileSync(path.join(root, name), 'utf8'),
    );
  }
  return hostKitSources(all);
}

const HOST_KIT = checkoutHostKitSources();

/** Options that let the reach rule answer: the scan sees the host-kit graph it derives from. */
export function policyOptions(): { hostKitSources: ReadonlyMap<string, string> } {
  return { hostKitSources: HOST_KIT };
}

/** The host-kit findings one managed family's new file earns, as one string to match against. */
export function hostKitFindings(family: string, source: string): string {
  const file = `packages/platform-${family}/src/new-surface.ts`;
  return checkPlatformPackagePolicy(
    new Map([...validSources(), [file, source]]),
    declarations(),
    policyOptions(),
  )
    .map((violation) => violation.message)
    .filter((message) => message.includes('host-kit'))
    .join('\n');
}
