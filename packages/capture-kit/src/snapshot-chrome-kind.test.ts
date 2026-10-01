import { describe, expect, it } from 'vitest';
import { isViewportChromeNode, VIEWPORT_CHROME_KIND_FRAGMENTS } from './snapshot-chrome-kind.ts';

describe('isViewportChromeNode', () => {
  it.each(VIEWPORT_CHROME_KIND_FRAGMENTS)(
    'reads the %s kind from each published field',
    (fragment) => {
      const className = `UI${fragment}`;
      expect(isViewportChromeNode({ type: 'Other', role: className, subrole: undefined })).toBe(
        true,
      );
      expect(isViewportChromeNode({ type: className, role: undefined, subrole: undefined })).toBe(
        true,
      );
      expect(isViewportChromeNode({ type: 'Other', role: undefined, subrole: className })).toBe(
        true,
      );
    },
  );

  it.each([
    { type: 'Dialog', role: 'UIAlertControllerView' },
    { type: 'Sheet' },
    { type: 'Other', role: 'RCTRootContentView' },
    { type: 'Other', role: 'BottomBackgroundView' },
  ])('leaves non-chrome presentation out: $type/$role', (node) => {
    expect(isViewportChromeNode({ ...node, subrole: undefined })).toBe(false);
  });

  it('never joins separate fields into a chrome fragment', () => {
    // `type: 'Tab'` + `role: 'Bar'` normalizes to `tab bar`, which must not satisfy `tabbar`.
    expect(isViewportChromeNode({ type: 'Tab', role: 'Bar', subrole: undefined })).toBe(false);
  });

  it('tolerates missing fields', () => {
    expect(isViewportChromeNode({ type: undefined, role: 'UIToolbar', subrole: undefined })).toBe(
      true,
    );
    expect(isViewportChromeNode({ type: undefined, role: undefined, subrole: undefined })).toBe(
      false,
    );
  });
});
