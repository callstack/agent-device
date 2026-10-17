import { formatRole } from '@agent-device/kernel/snapshot';
import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';

/**
 * The scroll-container chain of the Android 16 Settings home screen (Pixel 7, API 36), trimmed from
 * live `snapshot --json` captures for #3737. `main_content_scrollable_container` and the
 * `recycler_view` nested inside it share one rect. The RecyclerView offers ACTION_SCROLL_BACKWARD
 * even at the top, so it reports `hiddenContentAbove` in both states; only the outer ScrollView's
 * hint tracks where the content actually is.
 */
export type SettingsHomeState = 'at-top' | 'scrolled-down';

const SCREEN: Rect = { x: 0, y: 0, width: 1440, height: 3120 };
const LIST_FRAME: Rect = { x: 0, y: 480, width: 1440, height: 2556 };
const ROW_TOPS: Record<SettingsHomeState, readonly number[]> = {
  'at-top': [480, 807, 1078, 1405],
  'scrolled-down': [493, 764, 1035, 1362],
};
const ROW_LABELS: Record<SettingsHomeState, readonly string[]> = {
  'at-top': ['Google', 'Network & internet', 'Connected devices', 'Apps'],
  'scrolled-down': ['Network & internet', 'Connected devices', 'Apps', 'Notifications'],
};
const RECYCLER_VIEW_INDEX = 23;

function node(
  index: number,
  type: string,
  rect: Rect,
  overrides: Partial<SnapshotNode> = {},
): SnapshotNode {
  return { ref: `e${index + 1}`, index, type, kind: formatRole(type), rect, ...overrides };
}

export function settingsHomeTree(state: SettingsHomeState): SnapshotNode[] {
  const rows = ROW_TOPS[state].map((y, row) =>
    node(
      RECYCLER_VIEW_INDEX + 1 + row,
      'android.widget.LinearLayout',
      { x: 0, y, width: 1440, height: 271 },
      { parentIndex: RECYCLER_VIEW_INDEX, label: ROW_LABELS[state][row] },
    ),
  );
  return [
    node(8, 'android.widget.FrameLayout', SCREEN),
    node(10, 'android.widget.FrameLayout', SCREEN, {
      parentIndex: 8,
      identifier: 'android:id/content',
    }),
    node(
      11,
      'android.widget.ScrollView',
      { x: 0, y: 0, width: 1440, height: 3036 },
      {
        parentIndex: 10,
        identifier: 'com.android.settings:id/settings_homepage_container',
      },
    ),
    node(
      12,
      'android.widget.TextView',
      { x: 252, y: 251, width: 518, height: 93 },
      {
        parentIndex: 11,
        identifier: 'com.android.settings:id/search_bar_title',
        label: 'Search Settings',
      },
    ),
    node(18, 'android.widget.ScrollView', LIST_FRAME, {
      parentIndex: 11,
      identifier: 'com.android.settings:id/main_content_scrollable_container',
      hiddenContentBelow: true,
      ...(state === 'scrolled-down' ? { hiddenContentAbove: true } : {}),
    }),
    node(22, 'android.widget.FrameLayout', LIST_FRAME, {
      parentIndex: 18,
      identifier: 'android:id/list_container',
    }),
    node(RECYCLER_VIEW_INDEX, 'androidx.recyclerview.widget.RecyclerView', LIST_FRAME, {
      parentIndex: 22,
      identifier: 'com.android.settings:id/recycler_view',
      hiddenContentAbove: true,
    }),
    ...rows,
  ];
}
