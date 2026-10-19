import { expect, test } from 'vitest';
import { verifyAndroidFilledTextInHierarchy } from './fill-verification.ts';
import type { AndroidFillVerificationNode } from './fill-diagnostics.ts';
import type { AndroidSnapshotBackendMetadata } from './snapshot-types.ts';
const metadata: AndroidSnapshotBackendMetadata = {
  backend: 'android-helper',
  rootPresent: true,
  cacheInvalidated: true,
  helperTruncated: false,
  systemSurfaceOnly: false,
  missingRootWindowTypes: [],
};
const target: AndroidFillVerificationNode = {
  text: 'G',
  className: 'android.widget.EditText',
  resourceId: 'app:id/target',
  packageName: 'app',
  rect: { x: 0, y: 0, width: 100, height: 40 },
  focused: true,
  password: false,
  inputMethodOwned: false,
  area: 4000,
  hintShowing: false,
  placeholder: null,
};
function field(id: string, text: string, x: number, focused: boolean, pkg = 'app') {
  return `<node class="android.widget.EditText" resource-id="${id}" package="${pkg}" text="${text}" focused="${focused}" bounds="[${x},0][${x + 100},40]"/>`;
}
function verify(
  nodes: string,
  before: AndroidFillVerificationNode = target,
  captureMetadata: AndroidSnapshotBackendMetadata | undefined = metadata,
) {
  return verifyAndroidFilledTextInHierarchy(
    `<hierarchy>${nodes}</hierarchy>`,
    50,
    20,
    '',
    { captureMetadata },
    { targetInput: before, uniqueIdentity: true },
  );
}
test('does not accept a different empty focused field instead of the requested target', () => {
  expect(
    verify(field('app:id/target', 'G', 0, false) + field('app:id/other', '', 200, true)).ok,
  ).toBe(false);
});
test('does not recover an empty target with a duplicated identity', () => {
  expect(
    verify(
      field('app:id/decoy', 'D', 0, false) +
        field('app:id/target', '', 200, true) +
        field('app:id/target', '', 350, false),
    ).ok,
  ).toBe(false);
});
test('does not recover an empty target from another package', () => {
  expect(
    verify(field('app:id/decoy', 'D', 0, false) + field('app:id/target', '', 200, true, 'other'))
      .ok,
  ).toBe(false);
});
test('does not recover an empty field that no longer has focus', () => {
  expect(
    verify(field('app:id/decoy', 'D', 0, false) + field('app:id/target', '', 200, false)).ok,
  ).toBe(false);
});

test('does not recover an empty field with the same ID but a different class', () => {
  expect(
    verify(
      field('app:id/decoy', 'D', 0, false) +
        field('app:id/target', '', 200, true).replace('android.widget.EditText', 'custom.EditText'),
    ).ok,
  ).toBe(false);
});
test('does not accept whitespace as a cleared value', () => {
  expect(
    verify(field('app:id/decoy', 'D', 0, false) + field('app:id/target', ' ', 200, true)).ok,
  ).toBe(false);
});
test.each(['composing', ''])('does not override a competing focused IME input (%s)', (imeText) => {
  expect(
    verify(
      field('app:id/decoy', 'D', 0, false) +
        field('app:id/target', '', 200, true) +
        field('keyboard:id/input', imeText, 350, true, 'com.google.android.inputmethod.latin'),
    ).ok,
  ).toBe(false);
});
test('requires the captured target identity before confirming a moved empty field', () => {
  const xml =
    '<hierarchy>' +
    field('app:id/decoy', 'D', 0, false) +
    field('app:id/target', '', 200, true) +
    '</hierarchy>';
  expect(verifyAndroidFilledTextInHierarchy(xml, 50, 20, '').ok).toBe(false);
});

test('does not confirm a moved empty field without an identified pre-action target', () => {
  const nodes = field('app:id/decoy', 'D', 0, false) + field('app:id/target', '', 200, true);
  expect(verify(nodes, { ...target, resourceId: null }).ok).toBe(false);
});
test('retains masked-field verification instead of corroborating an empty password field by identity', () => {
  const nodes = field('app:id/decoy', 'D', 0, false) + field('app:id/target', '', 200, true);
  expect(verify(nodes, { ...target, password: true }).ok).toBe(false);
});

test.each([
  ['unknown capture', {}],
  ['truncated tree', { helperTruncated: true }],
  ['unknown truncation', { helperTruncated: undefined }],
  ['uninvalidated cache', { cacheInvalidated: false }],
  ['unknown cache state', { cacheInvalidated: undefined }],
  ['missing root', { rootPresent: false }],
  ['system-only capture', { systemSurfaceOnly: true }],
  ['missing window root', { missingRootWindowTypes: [2] }],
  ['unknown window completeness', { missingRootWindowTypes: undefined }],
] satisfies [string, Partial<AndroidSnapshotBackendMetadata>][])(
  'does not confirm a moved empty field from %s',
  (name, patch) => {
    const nodes = field('app:id/decoy', 'D', 0, false) + field('app:id/target', '', 200, true);
    const captureMetadata =
      name === 'unknown capture'
        ? { backend: 'android-helper' as const }
        : { ...metadata, ...patch };
    expect(verify(nodes, target, captureMetadata).ok).toBe(false);
  },
);

test('does not corroborate a moved empty field without a unique pre-action identity', () => {
  const xml =
    '<hierarchy>' +
    field('app:id/decoy', 'D', 0, false) +
    field('app:id/target', '', 200, true) +
    '</hierarchy>';
  expect(
    verifyAndroidFilledTextInHierarchy(
      xml,
      50,
      20,
      '',
      { captureMetadata: metadata },
      { targetInput: target, uniqueIdentity: false },
    ).ok,
  ).toBe(false);
});
