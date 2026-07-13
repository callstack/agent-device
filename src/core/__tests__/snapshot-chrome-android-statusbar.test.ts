import { test } from 'vitest';
import assert from 'node:assert/strict';
import { attachRefs, type RawSnapshotNode, type SnapshotNode } from '../../kernel/snapshot.ts';
import { collectSettleChromeRefs } from '../snapshot-chrome.ts';

/**
 * Real device capture (checkout-form fixture app, Gboard open, status bar
 * visible) archived at `~/.agent-device-bench/replay-runs/android-ime/raw-ime2.json`
 * (#1251). This is the `--raw` tree: `--raw` keeps every structural wrapper
 * node (`status_bar_container`, `status_bar_contents`, ...) so the OLD
 * prefix-only marker check finds them and drops the whole run.
 *
 * The default (non-raw) walk drops unlabeled/unidentified structural nodes
 * (`shouldIncludeStructuralAndroidNode` in `platforms/android/ui-hierarchy.ts`),
 * re-parenting their children upward — which silently removes every one of
 * those marker-bearing wrappers, leaving only their labeled/identified LEAF
 * children (clock, battery, wifi/mobile icons, ...). `simulateNonRawWalk`
 * below reproduces exactly that drop+reparent so the tree below matches what
 * a real non-raw `snapshot` capture would have produced for the same screen.
 */
const ANDROID_IME_CAPTURE_RAW_NODES: RawSnapshotNode[] = [
  { index: 0, type: 'android.widget.FrameLayout', bundleId: 'com.android.systemui' },
  {
    index: 1,
    parentIndex: 0,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/status_bar_launch_animation_container',
  },
  {
    index: 2,
    parentIndex: 0,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/status_bar_container',
  },
  {
    index: 3,
    parentIndex: 2,
    type: 'androidx.compose.ui.platform.ComposeView',
    bundleId: 'com.android.systemui',
  },
  { index: 4, parentIndex: 3, type: 'android.view.View', bundleId: 'com.android.systemui' },
  {
    index: 5,
    parentIndex: 4,
    type: 'androidx.compose.ui.viewinterop.ViewFactoryHolder',
    bundleId: 'com.android.systemui',
  },
  {
    index: 6,
    parentIndex: 5,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/status_bar',
  },
  {
    index: 7,
    parentIndex: 6,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/status_bar_contents',
  },
  {
    index: 8,
    parentIndex: 7,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/status_bar_start_side_container',
  },
  {
    index: 9,
    parentIndex: 8,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/status_bar_start_side_content',
  },
  {
    index: 10,
    parentIndex: 9,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/status_bar_start_side_except_heads_up',
  },
  {
    index: 11,
    parentIndex: 10,
    type: 'android.widget.TextView',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/clock',
    label: '7:03',
  },
  {
    index: 12,
    parentIndex: 10,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/start_side_notif_and_chip_container',
  },
  {
    index: 13,
    parentIndex: 12,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/notification_icon_area',
  },
  {
    index: 14,
    parentIndex: 13,
    type: 'android.view.ViewGroup',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/notificationIcons',
  },
  {
    index: 15,
    parentIndex: 14,
    type: 'android.widget.ImageView',
    bundleId: 'com.android.systemui',
    label: 'Security & privacy notification: ',
  },
  {
    index: 16,
    parentIndex: 7,
    type: 'android.view.View',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/cutout_space_view',
  },
  {
    index: 17,
    parentIndex: 7,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/status_bar_end_side_container',
  },
  {
    index: 18,
    parentIndex: 17,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/status_bar_end_side_content',
  },
  {
    index: 19,
    parentIndex: 18,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/system_icons',
  },
  {
    index: 20,
    parentIndex: 19,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/statusIcons',
  },
  {
    index: 21,
    parentIndex: 20,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/mobile_combo',
    label: 'T-Mobile, signal full.',
  },
  {
    index: 22,
    parentIndex: 21,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/mobile_group',
  },
  {
    index: 23,
    parentIndex: 22,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.android.systemui',
  },
  {
    index: 24,
    parentIndex: 23,
    type: 'android.widget.ImageView',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/mobile_signal',
  },
  {
    index: 25,
    parentIndex: 20,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/wifi_combo',
  },
  {
    index: 26,
    parentIndex: 25,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/wifi_group',
  },
  {
    index: 27,
    parentIndex: 26,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/wifi_combo',
  },
  {
    index: 28,
    parentIndex: 27,
    type: 'android.widget.ImageView',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/wifi_signal',
    label: 'Wifi signal full.',
  },
  {
    index: 29,
    parentIndex: 19,
    type: 'androidx.compose.ui.platform.ComposeView',
    bundleId: 'com.android.systemui',
  },
  { index: 30, parentIndex: 29, type: 'android.view.View', bundleId: 'com.android.systemui' },
  {
    index: 31,
    parentIndex: 30,
    type: 'android.view.View',
    bundleId: 'com.android.systemui',
    identifier: 'com.android.systemui:id/battery',
  },
  {
    index: 32,
    parentIndex: 31,
    type: 'android.view.View',
    bundleId: 'com.android.systemui',
    label: 'Battery 100 percent.',
  },
  {
    index: 33,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 34,
    parentIndex: 33,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 35,
    parentIndex: 34,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'android:id/content',
  },
  {
    index: 36,
    parentIndex: 35,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'android:id/parentPanel',
  },
  {
    index: 37,
    parentIndex: 36,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'android:id/inputArea',
  },
  {
    index: 38,
    parentIndex: 37,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 39,
    parentIndex: 38,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 40,
    parentIndex: 39,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 41,
    parentIndex: 40,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/keyboard_holder',
  },
  {
    index: 42,
    parentIndex: 41,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/keyboard_header_view_holder',
  },
  {
    index: 43,
    parentIndex: 42,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 44,
    parentIndex: 43,
    type: 'android.view.ViewGroup',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 45,
    parentIndex: 44,
    type: 'android.view.View',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 46,
    parentIndex: 44,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/key_pos_header_access_points_menu',
    label: 'Open features menu',
  },
  {
    index: 47,
    parentIndex: 46,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 48,
    parentIndex: 47,
    type: 'android.widget.ImageView',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 49,
    parentIndex: 44,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 50,
    parentIndex: 49,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 51,
    parentIndex: 50,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/softkey_holder_fixed_candidates',
  },
  {
    index: 52,
    parentIndex: 51,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    label: 'name',
  },
  {
    index: 53,
    parentIndex: 52,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 54,
    parentIndex: 53,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 55,
    parentIndex: 54,
    type: 'android.widget.TextView',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
    label: 'name',
  },
  {
    index: 56,
    parentIndex: 53,
    type: 'android.widget.ImageView',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 57,
    parentIndex: 51,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    label: 'names',
  },
  {
    index: 58,
    parentIndex: 57,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 59,
    parentIndex: 58,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 60,
    parentIndex: 59,
    type: 'android.widget.TextView',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
    label: 'names',
  },
  {
    index: 61,
    parentIndex: 58,
    type: 'android.widget.ImageView',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 62,
    parentIndex: 51,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 63,
    parentIndex: 62,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    label: '📛 emoji',
  },
  {
    index: 64,
    parentIndex: 63,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 65,
    parentIndex: 64,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 66,
    parentIndex: 65,
    type: 'android.view.View',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
    label: '📛 emoji',
  },
  {
    index: 67,
    parentIndex: 44,
    type: 'android.speech.SpeechRecognizer.VoiceDictationButton',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/key_pos_header_power_key',
    label: 'Use voice typing',
  },
  {
    index: 68,
    parentIndex: 67,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/host',
  },
  {
    index: 69,
    parentIndex: 68,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 70,
    parentIndex: 69,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 71,
    parentIndex: 69,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 72,
    parentIndex: 69,
    type: 'android.view.View',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 73,
    parentIndex: 69,
    type: 'android.widget.ImageView',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 74,
    parentIndex: 41,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 75,
    parentIndex: 74,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 76,
    parentIndex: 75,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 77,
    parentIndex: 76,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/input_area',
  },
  {
    index: 78,
    parentIndex: 77,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 79,
    parentIndex: 78,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/D01',
    label: 'q',
  },
  {
    index: 80,
    parentIndex: 79,
    type: 'android.widget.TextView',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
    label: 'q',
  },
  {
    index: 81,
    parentIndex: 79,
    type: 'android.widget.TextView',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
    label: '1',
  },
  {
    index: 82,
    parentIndex: 78,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/D02',
    label: 'w',
  },
  {
    index: 109,
    parentIndex: 77,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 110,
    parentIndex: 109,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/C01',
    label: 'a',
  },
  {
    index: 132,
    parentIndex: 77,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 133,
    parentIndex: 132,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/key_pos_shift',
    label: 'Shift',
  },
  {
    index: 149,
    parentIndex: 132,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/key_pos_del',
    label: 'Delete',
  },
  {
    index: 151,
    parentIndex: 76,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated',
  },
  {
    index: 158,
    parentIndex: 151,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/key_pos_space',
    label: 'Space',
  },
  {
    index: 163,
    parentIndex: 151,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'com.google.android.inputmethod.latin:id/key_pos_ime_action',
    label: 'Done',
  },
  {
    index: 169,
    parentIndex: 33,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
  },
  {
    index: 170,
    parentIndex: 169,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'android:id/input_method_navigation_bar_view',
  },
  {
    index: 176,
    parentIndex: 170,
    type: 'android.widget.ImageView',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'android:id/input_method_nav_back',
    label: 'Back',
  },
  {
    index: 178,
    parentIndex: 170,
    type: 'android.widget.ImageView',
    bundleId: 'com.google.android.inputmethod.latin',
    identifier: 'android:id/input_method_nav_ime_switcher',
    label: 'Switch input method',
  },
  { index: 180, type: 'android.widget.FrameLayout', bundleId: 'com.callstack.agentdevicelab' },
  {
    index: 181,
    parentIndex: 180,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 182,
    parentIndex: 181,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 183,
    parentIndex: 182,
    type: 'android.widget.LinearLayout',
    bundleId: 'com.callstack.agentdevicelab',
    identifier: 'com.callstack.agentdevicelab:id/action_bar_root',
  },
  {
    index: 184,
    parentIndex: 183,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.callstack.agentdevicelab',
    identifier: 'android:id/content',
  },
  {
    index: 185,
    parentIndex: 184,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 193,
    parentIndex: 185,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 194,
    parentIndex: 193,
    type: 'android.view.ViewGroup',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 196,
    parentIndex: 193,
    type: 'android.view.ViewGroup',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 197,
    parentIndex: 196,
    type: 'android.view.ViewGroup',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 198,
    parentIndex: 197,
    type: 'android.view.ViewGroup',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 199,
    parentIndex: 198,
    type: 'android.view.ViewGroup',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 200,
    parentIndex: 199,
    type: 'android.widget.ScrollView',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 201,
    parentIndex: 200,
    type: 'android.view.ViewGroup',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 202,
    parentIndex: 201,
    type: 'android.view.ViewGroup',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 203,
    parentIndex: 202,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 204,
    parentIndex: 203,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 205,
    parentIndex: 204,
    type: 'android.widget.FrameLayout',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 206,
    parentIndex: 205,
    type: 'android.view.ViewGroup',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 207,
    parentIndex: 206,
    type: 'android.view.ViewGroup',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 208,
    parentIndex: 207,
    type: 'android.view.ViewGroup',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 210,
    parentIndex: 208,
    type: 'android.widget.ScrollView',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 211,
    parentIndex: 210,
    type: 'android.view.ViewGroup',
    bundleId: 'com.callstack.agentdevicelab',
  },
  {
    index: 212,
    parentIndex: 211,
    type: 'android.view.ViewGroup',
    bundleId: 'com.callstack.agentdevicelab',
    identifier: 'form-title',
  },
  {
    index: 213,
    parentIndex: 211,
    type: 'android.widget.TextView',
    bundleId: 'com.callstack.agentdevicelab',
    label: 'Checkout form',
  },
  {
    index: 220,
    parentIndex: 211,
    type: 'android.widget.TextView',
    bundleId: 'com.callstack.agentdevicelab',
    label: 'Full name',
  },
  {
    index: 221,
    parentIndex: 211,
    type: 'android.widget.EditText',
    bundleId: 'com.callstack.agentdevicelab',
    identifier: 'field-name',
    label: 'review name',
  },
  {
    index: 222,
    parentIndex: 211,
    type: 'android.widget.TextView',
    bundleId: 'com.callstack.agentdevicelab',
    label: 'Email',
  },
  {
    index: 223,
    parentIndex: 211,
    type: 'android.widget.EditText',
    bundleId: 'com.callstack.agentdevicelab',
    identifier: 'field-email',
    label: 'ada@example.com',
  },
  {
    index: 224,
    parentIndex: 211,
    type: 'android.widget.TextView',
    bundleId: 'com.callstack.agentdevicelab',
    label: 'Phone',
  },
  {
    index: 225,
    parentIndex: 211,
    type: 'android.widget.EditText',
    bundleId: 'com.callstack.agentdevicelab',
    identifier: 'field-phone',
    label: '+48 555 010 010',
  },
  {
    index: 226,
    parentIndex: 211,
    type: 'android.view.ViewGroup',
    bundleId: 'com.callstack.agentdevicelab',
    identifier: 'android-ime-capture-fixture',
  },
];

const ANDROID_STATUS_NAV_BAR_WRAPPER_IDENTIFIER_PREFIXES = [
  'com.android.systemui:id/status_bar',
  'com.android.systemui:id/navigation_bar',
];

/**
 * Mirrors `walkUiHierarchyNode`'s non-raw drop+reparent (`currentIndex =
 * include ? appendAndroidSnapshotNode(...) : parentIndex`) for the ONE node
 * shape at the center of #1251: unlabeled/unidentified-meaningfully
 * `status_bar*`/`navigation_bar*` structural wrapper nodes. The real
 * `shouldIncludeStructuralAndroidNode` also drops other anonymous structural
 * nodes (Compose plumbing with no id at all, etc.) for unrelated reasons —
 * this simulation only removes the marker-bearing wrappers the root cause
 * names, which is the detail this regression is actually about: every other
 * dropped/kept decision is irrelevant to whether the systemui run is still
 * recognized as chrome.
 */
function simulateNonRawWalk(rawNodes: RawSnapshotNode[]): RawSnapshotNode[] {
  const byIndex = new Map(rawNodes.map((node) => [node.index, node]));
  const isDroppedStatusNavBarWrapper = (node: RawSnapshotNode): boolean => {
    const identifier = node.identifier ?? '';
    return ANDROID_STATUS_NAV_BAR_WRAPPER_IDENTIFIER_PREFIXES.some((prefix) =>
      identifier.startsWith(prefix),
    );
  };
  const dropped = new Set(rawNodes.filter(isDroppedStatusNavBarWrapper).map((node) => node.index));
  const nearestKeptAncestor = (index: number): number | undefined => {
    let current = byIndex.get(index)?.parentIndex;
    while (current !== undefined && dropped.has(current)) {
      current = byIndex.get(current)?.parentIndex;
    }
    return current;
  };
  return rawNodes
    .filter((node) => !dropped.has(node.index))
    .map((node) => ({ ...node, parentIndex: nearestKeptAncestor(node.index) }));
}

function refForIdentifier(nodes: SnapshotNode[], identifier: string): string {
  const node = nodes.find((candidate) => candidate.identifier === identifier);
  assert.ok(node?.ref, `expected a node identified "${identifier}" with a ref`);
  return node.ref;
}

const STATUS_BAR_LEAF_IDENTIFIERS = [
  'com.android.systemui:id/clock',
  'com.android.systemui:id/start_side_notif_and_chip_container',
  'com.android.systemui:id/notification_icon_area',
  'com.android.systemui:id/notificationIcons',
  'com.android.systemui:id/cutout_space_view',
  'com.android.systemui:id/system_icons',
  'com.android.systemui:id/statusIcons',
  'com.android.systemui:id/mobile_combo',
  'com.android.systemui:id/mobile_group',
  'com.android.systemui:id/mobile_signal',
  'com.android.systemui:id/wifi_combo',
  'com.android.systemui:id/wifi_group',
  'com.android.systemui:id/wifi_signal',
  'com.android.systemui:id/battery',
];

test('Android non-raw capture: status-bar leaves are recognized as chrome once their status_bar*/navigation_bar* marker wrapper is dropped by the walk (#1251)', () => {
  const simulatedNonRawNodes = simulateNonRawWalk(ANDROID_IME_CAPTURE_RAW_NODES);
  const nodes = attachRefs(simulatedNonRawNodes);
  const chromeRefs = collectSettleChromeRefs(nodes, 'com.callstack.agentdevicelab');

  for (const identifier of STATUS_BAR_LEAF_IDENTIFIERS) {
    assert.equal(
      chromeRefs.has(refForIdentifier(nodes, identifier)),
      true,
      `expected ${identifier} to be classified as systemui chrome`,
    );
  }

  // The whole systemui run drops together, including the anonymous Compose
  // plumbing nodes above/around the leaves that carry no identifier at all.
  const systemUiRefs = nodes
    .filter((node) => node.bundleId === 'com.android.systemui')
    .map((node) => node.ref);
  assert.equal(systemUiRefs.length > 0, true);
  for (const ref of systemUiRefs) {
    assert.equal(chromeRefs.has(ref), true, 'expected every systemui-owned node to be chrome');
  }

  // App fields and the IME keyboard, both real nodes from the same capture,
  // are handled exactly as before: the checkout form stays fully visible and
  // the IME keyboard is still classified as chrome in full.
  assert.equal(chromeRefs.has(refForIdentifier(nodes, 'field-name')), false);
  assert.equal(chromeRefs.has(refForIdentifier(nodes, 'field-email')), false);
  assert.equal(chromeRefs.has(refForIdentifier(nodes, 'field-phone')), false);
  const imeRefs = nodes
    .filter((node) => node.bundleId === 'com.google.android.inputmethod.latin')
    .map((node) => node.ref);
  assert.equal(imeRefs.length > 0, true);
  for (const ref of imeRefs) {
    assert.equal(chromeRefs.has(ref), true, 'expected every IME-owned node to be chrome');
  }
});

test('Android actionable systemui overlay (volume dialog) still survives with the status-bar leak fix (#1251)', () => {
  // Extend the real, reparented capture with a disjoint systemui run whose
  // leaf ids look like an actionable overlay (volume dialog): no real capture
  // of that surface was available, but the point of this test is exactly
  // that the new leaf-id set must NOT broaden to "any systemui id".
  const nodes = attachRefs([
    ...simulateNonRawWalk(ANDROID_IME_CAPTURE_RAW_NODES),
    {
      index: 9000,
      type: 'android.widget.FrameLayout',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/volume_dialog_container',
    },
    {
      index: 9001,
      parentIndex: 9000,
      type: 'android.widget.ImageButton',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/volume_dialog_slider',
      label: 'Media volume',
      hittable: true,
    },
  ]);
  const chromeRefs = collectSettleChromeRefs(nodes, 'com.callstack.agentdevicelab');

  assert.equal(
    chromeRefs.has(refForIdentifier(nodes, 'com.android.systemui:id/volume_dialog_container')),
    false,
  );
  assert.equal(
    chromeRefs.has(refForIdentifier(nodes, 'com.android.systemui:id/volume_dialog_slider')),
    false,
  );
  // The status-bar leak fix stays active in the very same tree.
  assert.equal(chromeRefs.has(refForIdentifier(nodes, 'com.android.systemui:id/clock')), true);
});

test('Android nav-bar leaves are recognized as chrome once their navigation_bar* marker wrapper is dropped (synthetic: the real capture has no nav bar, gesture-nav device) (#1251)', () => {
  const rawNavBarNodes: RawSnapshotNode[] = [
    { index: 0, type: 'android.widget.FrameLayout', bundleId: 'com.android.systemui' },
    {
      index: 1,
      parentIndex: 0,
      type: 'android.widget.FrameLayout',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/navigation_bar_frame',
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'android.widget.LinearLayout',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/nav_buttons',
    },
    {
      index: 3,
      parentIndex: 2,
      type: 'android.widget.ImageView',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/back',
      label: 'Back',
    },
    {
      index: 4,
      parentIndex: 2,
      type: 'android.widget.ImageView',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/home',
      label: 'Home',
    },
    {
      index: 5,
      parentIndex: 2,
      type: 'android.widget.ImageView',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/recent_apps',
      label: 'Overview',
    },
    {
      index: 6,
      parentIndex: 1,
      type: 'android.view.View',
      bundleId: 'com.android.systemui',
      identifier: 'com.android.systemui:id/home_handle',
    },
  ];
  const nodes = attachRefs(simulateNonRawWalk(rawNavBarNodes));
  const chromeRefs = collectSettleChromeRefs(nodes, 'com.example.app');

  for (const identifier of [
    'com.android.systemui:id/back',
    'com.android.systemui:id/home',
    'com.android.systemui:id/recent_apps',
    'com.android.systemui:id/home_handle',
  ]) {
    assert.equal(chromeRefs.has(refForIdentifier(nodes, identifier)), true, identifier);
  }
});
