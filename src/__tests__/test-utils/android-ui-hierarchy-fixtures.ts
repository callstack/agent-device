import fs from 'node:fs';
import {
  buildUiHierarchySnapshot,
  type AndroidUiHierarchy,
} from '../../platforms/android/ui-hierarchy.ts';
import type { RawSnapshotNode } from '../../kernel/snapshot.ts';

/**
 * Capture fixtures are real archived device trees, so they live in `.json`
 * beside this module rather than as inline literals: they are DATA to be
 * regenerated from a device, not code to be edited by hand, and inlining a few
 * hundred nodes buries the helpers that walk them. Read via `fs` + `import.meta.url`
 * (the `test/output-economy` baseline pattern) so no `resolveJsonModule` /
 * import-attributes support is needed to typecheck them.
 */
function readCaptureFixture(file: string): RawSnapshotNode[] {
  return JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8')) as RawSnapshotNode[];
}

/**
 * Reconstructs the `AndroidUiHierarchy` tree `buildUiHierarchySnapshot` expects
 * (see `platforms/android/ui-hierarchy.ts`) from a flat `RawSnapshotNode[]`
 * fixture that carries `index`/`parentIndex` (the shape Android capture
 * fixtures already use throughout the test suite). Only the fields the walker
 * actually reads for its inclusion decisions
 * (`shouldIncludeAndroidNode`/`shouldIncludeStructuralAndroidNode`) are
 * threaded through: `type`, `identifier`, `label`, `value`, `hittable`,
 * `visibleToUser`, `rect`, plus `bundleId` -> `packageName` (echoed back onto
 * the walked output as `bundleId`, which the chrome/divergence classifiers key
 * on). `depth`/`parentIndex` on the tree node itself are vestigial (the walker
 * tracks depth and parent via its own recursion, never `node.depth`), so they
 * are not populated here.
 */
export function rawFixtureToAndroidTree(rawNodes: RawSnapshotNode[]): AndroidUiHierarchy {
  const root: AndroidUiHierarchy = {
    type: null,
    label: null,
    value: null,
    identifier: null,
    packageName: null,
    depth: -1,
    children: [],
  };
  const byIndex = new Map<number, AndroidUiHierarchy>();
  for (const raw of rawNodes) {
    byIndex.set(raw.index, {
      type: raw.type ?? null,
      label: raw.label ?? null,
      value: raw.value ?? null,
      identifier: raw.identifier ?? null,
      packageName: raw.bundleId ?? null,
      rect: raw.rect,
      hittable: raw.hittable,
      visibleToUser: raw.visibleToUser,
      depth: 0,
      children: [],
    });
  }
  for (const raw of rawNodes) {
    const node = byIndex.get(raw.index);
    if (!node) continue;
    const parent = raw.parentIndex !== undefined ? byIndex.get(raw.parentIndex) : undefined;
    (parent ?? root).children.push(node);
  }
  return root;
}

/**
 * Runs a `RawSnapshotNode[]` fixture through the REAL non-raw Android walk
 * (`buildUiHierarchySnapshot(..., { raw: false })`), the same drop+reparent
 * pass a device `snapshot` capture applies before nodes ever reach
 * `collectSettleChromeRefs` / the replay divergence screen builder. Unlabeled,
 * non-hittable, generic-id structural nodes (`shouldIncludeStructuralAndroidNode`)
 * are dropped and their children re-parented upward — so fixtures built this
 * way reproduce production's inclusion decisions exactly, instead of hand-
 * simulating only the `status_bar*`/`navigation_bar*` wrapper removal.
 */
export function walkNonRawAndroidFixture(rawNodes: RawSnapshotNode[]): RawSnapshotNode[] {
  const tree = rawFixtureToAndroidTree(rawNodes);
  return buildUiHierarchySnapshot(tree, undefined, { raw: false }).nodes;
}

/**
 * Real device capture (checkout-form fixture app, Gboard open, status bar
 * visible) archived at `~/.agent-device-bench/replay-runs/android-ime/raw-ime2.json`
 * (#1251). This is the `--raw` tree: `--raw` keeps every structural wrapper
 * node (`status_bar_container`, `status_bar_contents`, ...), unlike a default
 * capture. Shared across the chrome-classification tests
 * (`core/__tests__/snapshot-chrome-android-statusbar.test.ts`) and the replay
 * divergence route test (`daemon/handlers/__tests__/session-replay-divergence.test.ts`)
 * so both exercise the exact same real screen through `walkNonRawAndroidFixture`.
 */
export const ANDROID_IME_CAPTURE_RAW_NODES: RawSnapshotNode[] = readCaptureFixture(
  './android-ime-capture.raw.json',
);

/**
 * Real device capture (emulator-5556, Pixel 9 Pro XL API 37, deskclock in the
 * foreground, `adb shell cmd statusbar expand-settings`) archived at
 * `~/.agent-device-bench/wave3/validation/captures/legE-qsshade-raw-tree.json`
 * (wave-3 leg E). A FULLY expanded quick-settings shade: every node belongs to
 * `com.android.systemui` and the whole surface hangs off one `legacy_window_root`
 * — a SINGLE chrome run — with the status-bar icons (`clock`, `mobile_signal`,
 * `wifi_signal`) sitting inside that same window alongside the 23 hittable
 * `qs_tile_*` targets. That co-tenancy is what makes the run-level chrome rule
 * condemn the tiles, so the shape must come from a real capture rather than
 * hand-written ids. `--raw` keeps the structural wrappers a default capture drops.
 */
export const ANDROID_QS_SHADE_CAPTURE_RAW_NODES: RawSnapshotNode[] = readCaptureFixture(
  './android-qs-shade-capture.raw.json',
);
