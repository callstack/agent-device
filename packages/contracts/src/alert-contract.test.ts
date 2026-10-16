import { describe, expect, it } from 'vitest';
import { classifyAlertButtonRole, selectRankedAlertButtonByRole } from './alert-contract.ts';

type Button = { label: string; role: ReturnType<typeof classifyAlertButtonRole> };
const button = (label: string): Button => ({ label, role: classifyAlertButtonRole(label) });

describe('selectRankedAlertButtonByRole', () => {
  it('resolves distinct grants by the declared preference order', () => {
    const buttons = [button("Don't Allow"), button('Allow Once'), button('Allow While Using App')];
    expect(selectRankedAlertButtonByRole(buttons, 'accept')?.label).toBe('Allow While Using App');
    expect(selectRankedAlertButtonByRole(buttons, 'dismiss')?.label).toBe("Don't Allow");
  });

  it('resolves the Android grant pair by the same table', () => {
    const buttons = [button('While using the app'), button('Only this time'), button('Deny')];
    expect(selectRankedAlertButtonByRole(buttons, 'accept')?.label).toBe('While using the app');
  });

  it('refuses on equal-rank duplicates: the capture names no single physical button', () => {
    const buttons = [button('OK'), button('OK'), button('Cancel')];
    expect(selectRankedAlertButtonByRole(buttons, 'accept')).toBeNull();
  });

  it('refuses when multiple candidates share a role the vocabulary cannot rank', () => {
    // Roles can arrive from a platform id classifier; labels outside the vocabulary then tie.
    const buttons: Button[] = [
      { label: 'While on the go', role: 'accept' },
      { label: 'Just this run', role: 'accept' },
    ];
    expect(selectRankedAlertButtonByRole(buttons, 'accept')).toBeNull();
  });

  it('returns null when no button carries the role', () => {
    expect(selectRankedAlertButtonByRole([button('Settings')], 'accept')).toBeNull();
  });
});
