import { test, expect } from 'vitest';
import { classifyAndroidHelperContentRecovery } from '../snapshot-content-recovery.ts';

test('keeps known IME blocking windows instead of falling back to covered app content', () => {
  const decision = classifyAndroidHelperContentRecovery(
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
  const decision = classifyAndroidHelperContentRecovery(
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
  const decision = classifyAndroidHelperContentRecovery(
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
  const decision = classifyAndroidHelperContentRecovery(
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
  const decision = classifyAndroidHelperContentRecovery(
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
  const decision = classifyAndroidHelperContentRecovery(
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
  const decision = classifyAndroidHelperContentRecovery(
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
  const decision = classifyAndroidHelperContentRecovery(
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

function helperXml(nodes: string[]): string {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy>${nodes.join('')}</hierarchy>`;
}

function node(options: {
  text?: string;
  resourceId?: string;
  packageName: string;
  className: string;
  windowType?: number;
}): string {
  return `<node index="0"${options.windowType === undefined ? '' : ` window-type="${options.windowType}"`} text="${options.text ?? ''}" resource-id="${options.resourceId ?? ''}" class="${options.className}" package="${options.packageName}" visible-to-user="true" enabled="true" bounds="[0,0][100,100]" />`;
}
