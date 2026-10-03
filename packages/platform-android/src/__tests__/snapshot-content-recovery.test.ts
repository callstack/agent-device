import { test, expect } from 'vitest';
import {
  classifyAndroidHelperContent,
  type AndroidHelperContentRecoveryDecision,
} from '../snapshot-content-recovery.ts';

// Legacy assertions below check the unusable decision (or its absence); outcome-specific tests
// call classifyAndroidHelperContent directly.
function unusableDecisionFor(
  ...args: Parameters<typeof classifyAndroidHelperContent>
): AndroidHelperContentRecoveryDecision | undefined {
  const result = classifyAndroidHelperContent(...args);
  return result.outcome === 'unusable' ? result.decision : undefined;
}

test('keeps known IME blocking windows instead of falling back to covered app content', () => {
  const decision = unusableDecisionFor(
    helperXml([
      node({
        windowType: 1,
        packageName: 'org.reactnavigation.playground',
        className: 'android.widget.FrameLayout',
      }),
      node({
        windowType: 2,
        packageName: 'com.google.android.inputmethod.latin',
        className: 'android.widget.FrameLayout',
      }),
      node({
        text: 'Try out your stylus',
        packageName: 'com.google.android.inputmethod.latin',
        className: 'android.widget.TextView',
      }),
      node({
        text: 'Cancel',
        resourceId: 'android:id/closeButton',
        packageName: 'com.google.android.inputmethod.latin',
        className: 'android.widget.Button',
      }),
    ]),
    {
      backend: 'android-helper',
      nodeCount: 4,
      rootPresent: true,
      windowCount: 2,
      captureMode: 'interactive-windows',
    },
    { foregroundAppPackage: 'org.reactnavigation.playground' },
  );

  expect(decision).toBeUndefined();
});

test('rejects helper output with only one meaningful IME node', () => {
  const decision = unusableDecisionFor(
    helperXml([
      node({
        windowType: 1,
        packageName: 'org.reactnavigation.playground',
        className: 'android.widget.FrameLayout',
      }),
      node({
        text: 'Try out your stylus',
        packageName: 'com.google.android.inputmethod.latin',
        className: 'android.widget.TextView',
      }),
    ]),
    {
      backend: 'android-helper',
      nodeCount: 2,
      rootPresent: true,
      windowCount: 2,
      captureMode: 'interactive-windows',
    },
    { foregroundAppPackage: 'org.reactnavigation.playground' },
  );

  expect(decision?.reason).toBe('content-poor-app-window');
  expect(decision?.diagnostics.helperInputMethodMeaningfulNodeCount).toBe(1);
});

test('rejects helper output with no foreground app or IME content', () => {
  const decision = unusableDecisionFor(
    helperXml([
      node({
        windowType: 1,
        packageName: 'org.reactnavigation.playground',
        className: 'android.widget.FrameLayout',
      }),
      node({
        text: 'Unrelated overlay',
        packageName: 'com.example.overlay',
        className: 'android.widget.TextView',
      }),
    ]),
    {
      backend: 'android-helper',
      nodeCount: 2,
      rootPresent: true,
      windowCount: 1,
      captureMode: 'interactive-windows',
    },
    { foregroundAppPackage: 'org.reactnavigation.playground' },
  );

  expect(decision?.reason).toBe('content-poor-app-window');
  expect(decision?.diagnostics.helperInputMethodMeaningfulNodeCount).toBe(0);
});

test('keeps a meaningful foreground application surface owned by another package', () => {
  const decision = unusableDecisionFor(
    helperXml([
      node({
        windowType: 1,
        packageName: 'com.google.android.permissioncontroller',
        className: 'android.widget.FrameLayout',
      }),
      node({
        text: 'Allow access to photos?',
        packageName: 'com.google.android.permissioncontroller',
        className: 'android.widget.TextView',
      }),
      node({
        text: 'Allow',
        resourceId: 'com.android.permissioncontroller:id/permission_allow_button',
        packageName: 'com.google.android.permissioncontroller',
        className: 'android.widget.Button',
      }),
    ]),
    {
      backend: 'android-helper',
      nodeCount: 3,
      rootPresent: true,
      windowCount: 1,
      captureMode: 'interactive-windows',
    },
    { foregroundAppPackage: 'org.reactnavigation.playground' },
  );

  expect(decision).toBeUndefined();
});

test('rejects a status-bar-only capture without window metadata', () => {
  const decision = unusableDecisionFor(
    helperXml([
      node({
        text: '7:52',
        resourceId: 'com.android.systemui:id/clock',
        packageName: 'com.android.systemui',
        className: 'android.widget.TextView',
      }),
      node({
        text: 'Battery 100 percent',
        resourceId: 'com.android.systemui:id/battery',
        packageName: 'com.android.systemui',
        className: 'android.widget.LinearLayout',
      }),
    ]),
    {
      backend: 'android-helper',
      nodeCount: 2,
      rootPresent: true,
      windowCount: 1,
      captureMode: 'interactive-windows',
    },
  );

  expect(decision?.reason).toBe('system-window-only');
  expect(decision?.diagnostics.helperWindowRootCount).toBe(0);
  expect(decision?.diagnostics.helperSystemUiNodeCount).toBe(2);
  expect(decision?.diagnostics.helperNonSystemMeaningfulNodeCount).toBe(0);
});

test('rejects framework-owned content without window metadata', () => {
  const decision = unusableDecisionFor(
    helperXml([
      node({
        text: 'System dialog',
        resourceId: 'android:id/message',
        packageName: 'android',
        className: 'android.widget.TextView',
      }),
    ]),
    {
      backend: 'android-helper',
      nodeCount: 1,
      rootPresent: true,
      windowCount: 1,
      captureMode: 'interactive-windows',
    },
  );

  expect(decision?.reason).toBe('system-window-only');
  expect(decision?.diagnostics.helperSystemUiNodeCount).toBe(1);
  expect(decision?.diagnostics.helperNonSystemMeaningfulNodeCount).toBe(0);
});

test('keeps a recognized system dialog without window metadata', () => {
  const decision = unusableDecisionFor(
    helperXml([
      node({
        text: "Demo isn't responding",
        resourceId: 'android:id/alertTitle',
        packageName: 'com.android.systemui',
        className: 'android.widget.TextView',
      }),
      node({
        text: 'Do you want to close it?',
        resourceId: 'android:id/message',
        packageName: 'com.android.systemui',
        className: 'android.widget.TextView',
      }),
      node({
        text: 'Close app',
        resourceId: 'android:id/button2',
        packageName: 'com.android.systemui',
        className: 'android.widget.Button',
      }),
      node({
        text: 'Wait',
        resourceId: 'android:id/button1',
        packageName: 'com.android.systemui',
        className: 'android.widget.Button',
      }),
    ]),
    {
      backend: 'android-helper',
      nodeCount: 4,
      rootPresent: true,
      windowCount: 1,
      captureMode: 'interactive-windows',
    },
    { foregroundAppPackage: 'com.pagerviewexample' },
  );

  expect(decision).toBeUndefined();
});

test('rejects system chrome inherited under an empty application window', () => {
  const decision = unusableDecisionFor(
    helperXml([
      node({
        windowType: 1,
        packageName: 'com.pagerviewexample',
        className: 'android.widget.FrameLayout',
      }),
      node({
        text: '5:25',
        packageName: 'com.android.systemui',
        className: 'android.widget.TextView',
      }),
      node({
        text: 'Battery 100 percent',
        packageName: 'com.android.systemui',
        className: 'android.widget.ImageView',
      }),
    ]),
    {
      backend: 'android-helper',
      nodeCount: 3,
      rootPresent: true,
      windowCount: 2,
      captureMode: 'interactive-windows',
    },
    { foregroundAppPackage: 'com.pagerviewexample' },
  );

  expect(decision?.reason).toBe('content-poor-app-window');
  expect(decision?.diagnostics.helperApplicationMeaningfulNodeCount).toBe(0);
  expect(decision?.diagnostics.helperNonSystemMeaningfulNodeCount).toBe(0);
});

test('returns a meaningful active system surface (notification shade) faithfully', () => {
  const result = classifyAndroidHelperContent(
    helperXml([
      node({
        windowType: 3,
        windowActive: true,
        packageName: 'com.android.systemui',
        className: 'android.widget.FrameLayout',
      }),
      node({
        text: 'Wed, Jul 16',
        packageName: 'com.android.systemui',
        className: 'android.widget.TextView',
      }),
      node({
        text: 'Internet',
        resourceId: 'com.android.systemui:id/qs_tile_internet',
        packageName: 'com.android.systemui',
        className: 'android.widget.Switch',
      }),
      node({
        text: 'Manage',
        resourceId: 'com.android.systemui:id/manage_settings',
        packageName: 'com.android.systemui',
        className: 'android.widget.Button',
      }),
    ]),
    {
      backend: 'android-helper',
      nodeCount: 4,
      rootPresent: true,
      windowCount: 1,
      captureMode: 'interactive-windows',
    },
    { foregroundAppPackage: 'com.android.settings' },
  );

  expect(result.outcome).toBe('system-surface-only');
});

test('rejects an active navigation-bar window with three-button chrome', () => {
  // Back + Home + Recents are 3 meaningful nodes, but they are status/nav chrome: an active
  // nav-bar window is missing-app-content residue, never a usable shade/quick-settings surface.
  const result = classifyAndroidHelperContent(
    helperXml([
      node({
        windowType: 3,
        windowActive: true,
        packageName: 'com.android.systemui',
        className: 'android.widget.FrameLayout',
        // Chrome identity lives on the container, as on a device: the leaves
        // below carry no marker of their own.
        resourceId: 'com.android.systemui:id/navigation_bar_frame',
        children: [
          node({
            text: 'Back',
            resourceId: 'com.android.systemui:id/back',
            packageName: 'com.android.systemui',
            className: 'android.widget.ImageView',
          }),
          node({
            text: 'Home',
            resourceId: 'com.android.systemui:id/home',
            packageName: 'com.android.systemui',
            className: 'android.widget.ImageView',
          }),
          node({
            text: 'Overview',
            resourceId: 'com.android.systemui:id/recent_apps',
            packageName: 'com.android.systemui',
            className: 'android.widget.ImageView',
          }),
        ],
      }),
    ]),
    {
      backend: 'android-helper',
      nodeCount: 4,
      rootPresent: true,
      windowCount: 1,
      captureMode: 'interactive-windows',
    },
    { foregroundAppPackage: 'com.android.settings' },
  );

  expect(result.outcome).toBe('unusable');
});

test('rejects an active status-chrome window with clock, battery, and signal icons', () => {
  const result = classifyAndroidHelperContent(
    helperXml([
      node({
        windowType: 3,
        windowActive: true,
        packageName: 'com.android.systemui',
        className: 'android.widget.FrameLayout',
        resourceId: 'com.android.systemui:id/status_bar_container',
        children: [
          node({
            text: '7:52',
            resourceId: 'com.android.systemui:id/clock',
            packageName: 'com.android.systemui',
            className: 'android.widget.TextView',
          }),
          node({
            text: 'Battery 100 percent',
            resourceId: 'com.android.systemui:id/battery',
            packageName: 'com.android.systemui',
            className: 'android.widget.LinearLayout',
          }),
          node({
            text: 'Wifi signal full',
            resourceId: 'com.android.systemui:id/wifi_signal',
            packageName: 'com.android.systemui',
            className: 'android.widget.ImageView',
          }),
        ],
      }),
    ]),
    {
      backend: 'android-helper',
      nodeCount: 4,
      rootPresent: true,
      windowCount: 1,
      captureMode: 'interactive-windows',
    },
    { foregroundAppPackage: 'com.android.settings' },
  );

  expect(result.outcome).toBe('unusable');
});

test('rejects a sparse active system surface below the meaningful-content floor', () => {
  const result = classifyAndroidHelperContent(
    helperXml([
      node({
        windowType: 3,
        windowActive: true,
        packageName: 'com.android.systemui',
        className: 'android.widget.FrameLayout',
      }),
      node({
        text: '7:52',
        resourceId: 'com.android.systemui:id/clock',
        packageName: 'com.android.systemui',
        className: 'android.widget.TextView',
      }),
    ]),
    {
      backend: 'android-helper',
      nodeCount: 2,
      rootPresent: true,
      windowCount: 1,
      captureMode: 'interactive-windows',
    },
    { foregroundAppPackage: 'com.android.settings' },
  );

  expect(result.outcome).toBe('unusable');
});

test('rejects a content-rich system window that is neither active nor focused', () => {
  const result = classifyAndroidHelperContent(
    helperXml([
      node({
        windowType: 3,
        packageName: 'com.android.systemui',
        className: 'android.widget.FrameLayout',
      }),
      node({
        text: 'Wed, Jul 16',
        packageName: 'com.android.systemui',
        className: 'android.widget.TextView',
      }),
      node({
        text: 'Internet',
        resourceId: 'com.android.systemui:id/qs_tile_internet',
        packageName: 'com.android.systemui',
        className: 'android.widget.Switch',
      }),
      node({
        text: 'Manage',
        resourceId: 'com.android.systemui:id/manage_settings',
        packageName: 'com.android.systemui',
        className: 'android.widget.Button',
      }),
    ]),
    {
      backend: 'android-helper',
      nodeCount: 4,
      rootPresent: true,
      windowCount: 1,
      captureMode: 'interactive-windows',
    },
    { foregroundAppPackage: 'com.android.settings' },
  );

  expect(result.outcome).toBe('unusable');
});

function helperXml(nodes: string[]): string {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy>${nodes.join('')}</hierarchy>`;
}

function node(options: {
  text?: string;
  resourceId?: string;
  packageName: string;
  className: string;
  windowType?: number;
  windowActive?: boolean;
  /** Nested children, so chrome leaves can sit inside their status/nav-bar container as on a device. */
  children?: string[];
}): string {
  const windowAttrs =
    (options.windowType === undefined ? '' : ` window-type="${options.windowType}"`) +
    (options.windowActive === undefined ? '' : ` window-active="${options.windowActive}"`);
  const open = `<node index="0"${windowAttrs} text="${options.text ?? ''}" resource-id="${options.resourceId ?? ''}" class="${options.className}" package="${options.packageName}" visible-to-user="true" enabled="true" bounds="[0,0][100,100]"`;
  return options.children === undefined
    ? `${open} />`
    : `${open}>${options.children.join('')}</node>`;
}
