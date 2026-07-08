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

test('falls back when helper output has only one meaningful IME node', () => {
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

test('falls back when helper output has no foreground app or IME content', () => {
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
