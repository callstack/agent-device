import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
import { isViewportRootNode } from './snapshot-visibility.ts';

/**
 * `isViewportRootNode` pinned over the vocabulary each backend ACTUALLY emits
 * into `node.type`/`role`/`subrole` — not over fixture strings.
 *
 * Nine hand-rolled spellings of this predicate existed before #1592's method was
 * applied here: three normalizing `type|role|subrole`, five lowercasing or
 * normalizing `type` alone, and one comparing the normalized type for EQUALITY.
 * Measured over the 75 names in the three tables below they agree on 71. All
 * four disagreements are macOS windows, and they split two ways:
 *
 *  - `AXFloatingWindow` / `AXSystemFloatingWindow`: only the `===` spelling
 *    (maestro) misses them, and its platform union is `android | ios`, so it
 *    can never see a macOS node. Inert — the same shape #1592 found for its
 *    own role/subrole arm.
 *  - `AXSystemDialog` / `AXUnknown`: an `AXWindow` whose subrole is emitted AS
 *    the type, so the six type-only spellings cannot see they are windows while
 *    `role` names it exactly. These two are the entire behavioral delta of the
 *    consolidation, and they are windows by role.
 *
 * Grounding this in emitted vocabulary is what made the collapse provable; a
 * fixture-string comparison would have reported divergences no backend can
 * produce (#1592, second commit).
 *
 * Keep these tables honest against their emitters — a predicate that silently
 * stops matching the root is invisible in every other test, because the root
 * node is scenery in all of them. The macOS table asserts its own completeness
 * against the emitter's fixed-output set below; iOS and Android do not, so a
 * new `elementTypeName` case or a new Android container class still has to be
 * added here by hand.
 */

// apple/runner/.../RunnerTests+Snapshot.swift `elementTypeName` — a closed set.
// `Element(N)` is the escape hatch for element types the switch does not name.
const IOS_EMITTED_TYPES = [
  'Application',
  'Window',
  'Button',
  'Cell',
  'StaticText',
  'TextField',
  'TextView',
  'SecureTextField',
  'Switch',
  'Slider',
  'Link',
  'Image',
  'NavigationBar',
  'TabBar',
  'CollectionView',
  'Table',
  'ScrollView',
  'Toolbar',
  'SearchField',
  'SegmentedControl',
  'Stepper',
  'Picker',
  'ActivityIndicator',
  'ProgressIndicator',
  'CheckBox',
  'MenuItem',
  'WebView',
  'Other',
  'Keyboard',
  'Key',
  'Element(72)',
] as const;

// packages/platform-android/src/ui-hierarchy.ts — `type` is the uiautomator `class`
// attribute verbatim, a fully-qualified Java class name.
const ANDROID_EMITTED_TYPES = [
  'android.view.View',
  'android.view.ViewGroup',
  'android.widget.Button',
  'android.widget.EditText',
  'android.widget.FrameLayout',
  'android.widget.HorizontalScrollView',
  'android.widget.ImageButton',
  'android.widget.ImageView',
  'android.widget.LinearLayout',
  'android.widget.ScrollView',
  'android.widget.SeekBar',
  'android.widget.Switch',
  'android.widget.TextView',
  'androidx.compose.ui.platform.ComposeView',
  'androidx.recyclerview.widget.RecyclerView',
  'android.widget.ListView',
  'android.widget.GridView',
  'androidx.core.widget.NestedScrollView',
] as const;

// apple/macos-helper/.../SnapshotTraversal.swift `normalizedSnapshotType`. Three
// output classes, all represented below:
//  1. every one of the 13 roles the switch maps to a fixed short name;
//  2. `AXWindow`, whose output is the SUBROLE unless that subrole is
//     `AXStandardWindow` — so a window's `type` can be any subrole string;
//  3. the `default:` arm, `subrole ?? role`, which emits the raw `AX`-prefixed
//     value for every unmapped role.
// This backend is the only one that populates `role`/`subrole` at all.
const MACOS_EMITTED_NODES = [
  // 1. the complete fixed-output set.
  { type: 'Application', role: 'AXApplication' },
  { type: 'Sheet', role: 'AXSheet' },
  { type: 'Dialog', role: 'AXDialog' },
  { type: 'Button', role: 'AXButton' },
  { type: 'StaticText', role: 'AXStaticText' },
  { type: 'TextField', role: 'AXTextField' },
  { type: 'TextArea', role: 'AXTextArea' },
  { type: 'ScrollArea', role: 'AXScrollArea' },
  { type: 'Group', role: 'AXGroup' },
  { type: 'MenuBar', role: 'AXMenuBar' },
  { type: 'MenuBarItem', role: 'AXMenuBarItem' },
  { type: 'Menu', role: 'AXMenu' },
  { type: 'MenuItem', role: 'AXMenuItem' },
  // 2. AXWindow: standard subrole collapses to "Window", every other subrole
  //    is emitted verbatim as the type.
  { type: 'Window', role: 'AXWindow', subrole: 'AXStandardWindow' },
  { type: 'AXFloatingWindow', role: 'AXWindow', subrole: 'AXFloatingWindow' },
  { type: 'AXSystemFloatingWindow', role: 'AXWindow', subrole: 'AXSystemFloatingWindow' },
  { type: 'AXSystemDialog', role: 'AXWindow', subrole: 'AXSystemDialog' },
  { type: 'AXUnknown', role: 'AXWindow', subrole: 'AXUnknown' },
  // 3. the raw `subrole ?? role` fallback for unmapped roles.
  { type: 'AXWebArea', role: 'AXWebArea' },
  { type: 'AXList', role: 'AXList' },
  { type: 'AXTable', role: 'AXTable' },
  { type: 'AXOutline', role: 'AXOutline' },
  { type: 'AXScrollBar', role: 'AXScrollBar' },
  { type: 'AXSplitGroup', role: 'AXSplitGroup' },
  { type: 'AXToolbar', role: 'AXToolbar' },
  // A subrole on an UNMAPPED role: the default arm returns `subrole ?? role`, so the
  // subrole wins. (`AXTextField` cannot appear here — its own arm always returns
  // `TextField`, whatever the subrole.)
  { type: 'AXSortButton', role: 'AXCell', subrole: 'AXSortButton' },
] as const;

/**
 * The emitter's fixed outputs, READ FROM THE EMITTER — not a second hand-kept
 * list. A hand-kept twin compared against a hand-kept table is circular: both
 * drift together and the comparison stays green (#1613 review). Parsing the
 * Swift switch is what makes "a role added there fails here" a real claim.
 */
function macosFixedOutputsFromEmitter(): string[] {
  const swift = fs.readFileSync(
    path.join(
      REPO_ROOT,
      'apple/macos-helper/Sources/AgentDeviceMacOSHelper/SnapshotTraversal.swift',
    ),
    'utf8',
  );
  const fn = /private func normalizedSnapshotType\([\s\S]*?\n\}/.exec(swift)?.[0];
  if (!fn) throw new Error('normalizedSnapshotType not found — the emitter moved; fix this parser');
  // `case "AXWindow":` returns a subrole expression, not a literal, so it is
  // deliberately absent from the literal-return set the table pins.
  return [...fn.matchAll(/return "([A-Za-z]+)"/g)].map((match) => match[1]!).sort();
}

describe('isViewportRootNode over emitted backend vocabulary', () => {
  test('iOS: exactly Application and Window, out of 31 emitted names', () => {
    const roots = IOS_EMITTED_TYPES.filter((type) => isViewportRootNode({ type }));
    expect(roots).toEqual(['Application', 'Window']);
  });

  test('iOS: substring and equality agree, so the collapse of the `===` spelling was a no-op', () => {
    for (const type of IOS_EMITTED_TYPES) {
      const equality = type === 'Application' || type === 'Window';
      expect({ type, root: isViewportRootNode({ type }) }).toEqual({ type, root: equality });
    }
  });

  // The load-bearing one. Android has no root node, so `resolveViewportRect`'s
  // third fallback (largest containing rect of any node) is the only arm that
  // ever returns on Android — and the resolvers that lack it return null there.
  test('Android: no emitted class name is a viewport root', () => {
    const roots = ANDROID_EMITTED_TYPES.filter((type) => isViewportRootNode({ type }));
    expect(roots).toEqual([]);
  });

  test('macOS: every AXWindow subrole is a root, whatever `type` says', () => {
    const roots = MACOS_EMITTED_NODES.filter(isViewportRootNode).map((node) => node.type);
    expect(roots).toEqual([
      'Application',
      'Window',
      'AXFloatingWindow',
      'AXSystemFloatingWindow',
      'AXSystemDialog',
      'AXUnknown',
    ]);
  });

  // The table's own completeness claim, asserted rather than trusted: every
  // fixed output the emitter's switch can return appears above, so adding a
  // role to that switch without adding it here fails.
  test('macOS: the table covers every fixed output the Swift emitter can return', () => {
    const covered = new Set<string>(MACOS_EMITTED_NODES.map((node) => node.type));
    const emitted = macosFixedOutputsFromEmitter();
    expect(emitted.length).toBeGreaterThan(10);
    expect(emitted.filter((name) => !covered.has(name))).toEqual([]);
  });

  // Why the canonical predicate reads role/subrole and not `type` alone: these
  // two are windows that no type-only spelling could see.
  test('macOS: role rescues the two window subroles `type` alone cannot name', () => {
    const typeOnly = (type: string) => {
      const value = type.toLowerCase();
      return value.includes('application') || value.includes('window');
    };
    const rescued = MACOS_EMITTED_NODES.filter(
      (node) => isViewportRootNode(node) && !typeOnly(node.type),
    ).map((node) => node.type);
    expect(rescued).toEqual(['AXSystemDialog', 'AXUnknown']);
  });
});
