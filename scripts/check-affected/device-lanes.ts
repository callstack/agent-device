// Device-lane ownership: which live device lanes a changed path can break (#1781 A9-2).
//
// The live lanes (`replay-ios`, `replay-ios-device`, `replay-macos`, `replay-android`,
// `replay-linux`, `web-smoke`) drive the CLI and daemon against a real simulator, emulator,
// desktop, or browser. Before this rule the selector could reach them only through a full
// fail-open, so a TypeScript-only Apple change (`src/platforms/apple/**`) produced a plan
// with no iOS check in it at all, and nothing could route `ios.yml` on the plan.
//
// What enumerates the surface. The import graph cannot: the daemon value-imports every
// platform module (`src/platform-runtime.ts` composes all six families; `src/core/interactors/*`
// import each family's actions; `src/daemon/session-teardown.ts` calls Android cleanup on every
// session close), so reachability from `src/bin.ts` is the whole tree, and the layering graph
// does not resolve relative imports inside `packages/`. The repo's *enforced* platform partition
// can: `CANONICAL_PLATFORM_FAMILIES` names the families, layering R13 pins each family's runtime
// to `packages/platform-<family>/` and `src/platforms/<family>/`, and the remaining family-owned
// trees are named by a family or Apple-leaf directory segment (`android/`, `linux/`,
// `test/integration/replays/<leaf>/`, `src/daemon/snapshot-presentation/ios/`) or, under
// `test/integration/`, by the lane prefix of the smoke file. A path tagged with exactly one
// family owns that family's lanes; a path tagged with none — or with two — is shared runtime
// surface and owns every lane. Unit tests (`*.test.ts`, `__tests__/`) under `src/` and
// `packages/` own no lane: no device lane runs Vitest, and the build excludes them.
//
// What this deliberately does not claim: that a family-tagged file is never executed by
// another family's lane. Cross-family lifecycle calls exist (see session-teardown above); the
// unit and provider suites are the backstop for those, `push` to main runs every lane
// unconditionally, and the routing decision on `ios.yml` was taken against a 90-day
// retrospective replay of merged PRs (issue #1781), not against this rule alone.

import { CANONICAL_PLATFORM_FAMILIES } from '../layering/platform-package-policy.ts';
import type { CheckId, SelectionReason } from './model.ts';

export type PlatformFamily = (typeof CANONICAL_PLATFORM_FAMILIES)[number];

// A family, an Apple leaf that owns a subset of the family's lanes, or the fixture app.
export type Leaf = PlatformFamily | 'ios' | 'macos' | 'fixture-app';

// The one place a family (or Apple leaf) is mapped to the lanes that exercise it. Families
// with no CI lane (HarmonyOS and Vega; see the hardware policy in
// docs/agents/testing.md) own nothing here and fall through to static gates only.
const LEAF_LANES: Readonly<Record<Leaf, readonly CheckId[]>> = {
  ios: ['replay-ios', 'replay-ios-device'],
  macos: ['replay-macos'],
  apple: ['replay-ios', 'replay-ios-device', 'replay-macos'],
  android: ['replay-android'],
  linux: ['replay-linux'],
  web: ['web-smoke'],
  harmonyos: [],
  vega: [],
  // Not a family: the Expo fixture app (`examples/test-app/`) that the mobile smokes install.
  'fixture-app': ['replay-ios', 'replay-ios-device', 'replay-android'],
};

// Directory segments that tag a path with a family. Apple's leaves are separate tags so a
// macOS-only tree does not own the iOS lane; a tree tagged `apple` (or `tvos`/`visionos`/
// `xcuitest`, whose only lanes today are the Apple family's) owns every Apple lane.
const APPLE_LEAF_TAGS: Readonly<Record<string, 'ios' | 'macos' | 'apple'>> = {
  ios: 'ios',
  macos: 'macos',
  apple: 'apple',
  tvos: 'apple',
  visionos: 'apple',
  xcuitest: 'apple',
};

const OTHER_FAMILIES: readonly PlatformFamily[] = CANONICAL_PLATFORM_FAMILIES.filter(
  (family) => family !== 'apple',
);

const ALL_DEVICE_LANES: readonly CheckId[] = [...new Set(Object.values(LEAF_LANES).flat())];

function leafOfSegment(segment: string): Leaf | null {
  const tag = /^platform-([^/]+)$/.exec(segment)?.[1] ?? segment;
  if (tag in APPLE_LEAF_TAGS) return APPLE_LEAF_TAGS[tag]!;
  return OTHER_FAMILIES.find((family) => family === tag) ?? null;
}

// Under test/integration/ the smoke files carry their lane in the leading tokens of the first
// segment (`smoke-android-emulator.test.ts`, `ios-simulator-e2e/`, `android-emulator-e2e/`).
// Elsewhere only directory segments tag: `src/daemon/android-system-dialog.ts` is a naming
// convention in a shared directory, not an enforced boundary, so it stays shared.
function tagSegments(file: string): string[] {
  const segments = file.split('/');
  const directories = segments.slice(0, -1);
  const rest = file.startsWith('test/integration/') ? segments.slice(2, 3) : [];
  return [
    ...directories,
    ...rest.flatMap((segment) =>
      segment
        .replace(/^smoke-/, '')
        .split(/[-.]/)
        .slice(0, 1),
    ),
  ];
}

// The family root of `file`, `'shared'` when it is untagged or tagged by more than one leaf
// (a mixed tree is not provably any single family's).
export function deviceLaneLeaf(file: string): Leaf | 'shared' {
  // The Expo fixture app is consumed by exactly the mobile lanes, whichever subtree changes.
  if (file.startsWith('examples/test-app/')) return 'fixture-app';
  const leaves = new Set(
    tagSegments(file)
      .map(leafOfSegment)
      .filter((leaf): leaf is Leaf => leaf !== null),
  );
  if (leaves.size === 0) return 'shared';
  if (leaves.size === 1) return [...leaves][0]!;
  // Two Apple leaves (ios + macos) still resolve to the Apple family; two families are shared.
  return [...leaves].every((leaf) => leaf in APPLE_LEAF_TAGS) ? 'apple' : 'shared';
}

export function deviceLanesFor(file: string): { leaf: Leaf | 'shared'; lanes: readonly CheckId[] } {
  const leaf = deviceLaneLeaf(file);
  return { leaf, lanes: leaf === 'shared' ? ALL_DEVICE_LANES : LEAF_LANES[leaf] };
}

// The runtime surface a device lane can observe. Listed by root AND extension class so this
// rule never turns a file the selector could not otherwise place (a `.json` under `src/`, a
// screenshot under `test/integration/`) into a narrow plan: those keep failing open through
// the ambiguous-path guard in model.ts, exactly as before.
const RUNTIME_SURFACE: ReadonlyArray<{ root: string; owns: (file: string) => boolean }> = [
  // Production TypeScript; unit tests own no lane (no device lane runs Vitest, the build
  // excludes them).
  { root: 'src/', owns: (file) => isProductionTs(file) },
  {
    root: 'packages/',
    owns: (file) => /^packages\/[^/]+\/src\//.test(file) && isProductionTs(file),
  },
  // Integration tests, their support modules, and the replay scripts the lanes execute.
  { root: 'test/integration/', owns: (file) => file.endsWith('.ts') || file.endsWith('.ad') },
  // The Expo fixture app the iOS/Android smoke drives (same extension class as own:test-app).
  { root: 'examples/test-app/', owns: (file) => /\.(?:[cm]?[jt]sx?|json)$/.test(file) },
  // Native runner and helper sources — build inputs of the lanes that boot them.
  { root: 'apple/', owns: () => true },
  { root: 'android/', owns: () => true },
  { root: 'linux/', owns: () => true },
  // TS/Swift golden tables (own:golden-table in model.ts): the parity XCTest runs on the lane.
  { root: 'contracts/fixtures/', owns: () => true },
];

// Unit tests under src/ and packages/*/src/ — Vitest's, which no device lane runs and the
// build excludes. TypeScript only: a `.json` capture under `__tests__/` is a fixture the
// selector cannot place, and it fails open like any other unowned file. (`test/integration/**`
// tests are the lanes' own smoke files and stay on the surface.)
export function isUnitTest(file: string): boolean {
  return (
    /^(?:src|packages\/[^/]+\/src)\//.test(file) &&
    file.endsWith('.ts') &&
    (/\.test\.ts$/.test(file) || /(?:^|\/)__tests__\//.test(file))
  );
}

function isProductionTs(file: string): boolean {
  return file.endsWith('.ts') && !file.endsWith('.d.ts') && !isUnitTest(file);
}

export function isDeviceLaneSurface(file: string): boolean {
  return RUNTIME_SURFACE.some((entry) => file.startsWith(entry.root) && entry.owns(file));
}

export function deviceLaneOwnership(file: string): SelectionReason[] {
  if (!isDeviceLaneSurface(file)) return [];
  const { leaf, lanes } = deviceLanesFor(file);
  const detail =
    leaf === 'shared'
      ? 'shared runtime surface: every device lane drives the CLI and daemon through it'
      : `${leaf}-owned tree: only the ${leaf} device lanes execute it`;
  return lanes.map((check) => ({ check, path: file, rule: `own:device-lane:${leaf}`, detail }));
}
