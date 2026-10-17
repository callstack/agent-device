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

  it('refuses a mix of ranked and unranked candidates rather than preferring the known label', () => {
    // The unranked one's role came from a platform id classifier, so it is a real grant the
    // table cannot order. Letting the one known English label win would press an arbitrary
    // grant of an unordered pair.
    const buttons: Button[] = [
      { label: 'OK', role: 'accept' },
      { label: 'Unrecognized grant', role: 'accept' },
    ];
    expect(selectRankedAlertButtonByRole(buttons, 'accept')).toBeNull();
  });

  it('keeps the declared order over mixed English variants of distinct grants', () => {
    // The closest positive: both candidates are ranked, so this is a preference, not ambiguity.
    const buttons = [button('Allow Once'), button('Allow')];
    expect(selectRankedAlertButtonByRole(buttons, 'accept')?.label).toBe('Allow');
  });

  it('returns null when no button carries the role', () => {
    expect(selectRankedAlertButtonByRole([button('Settings')], 'accept')).toBeNull();
  });

  it('orders candidates the label table cannot read by the backend rank it supplies', () => {
    // The localized-sheet shape at the shared boundary: both labels are outside the vocabulary,
    // and the backend's own fact (here, a grant-id rank) is the only order the pair has. The
    // boundary must use it instead of refusing a pair the owning backend can order.
    type RankedButton = Button & { id: string };
    const idRanks: Record<string, number> = { 'id/fg': 0, 'id/once': 1 };
    const rankById = (button: RankedButton): number | null => idRanks[button.id] ?? null;
    const buttons: RankedButton[] = [
      { label: 'Solo esta vez', role: 'accept', id: 'id/once' },
      { label: 'Mientras la app est\u00e1 en uso', role: 'accept', id: 'id/fg' },
    ];
    expect(selectRankedAlertButtonByRole(buttons, 'accept', rankById)?.id).toBe('id/fg');
  });

  it('still refuses when the backend rank reaches neither of a multi-candidate pair', () => {
    // The closest negative: the ranker exists but names nothing for these buttons, so the
    // label fallback leaves an unranked candidate and the refusal stands.
    type RankedButton = Button & { id: string };
    const buttons: RankedButton[] = [
      { label: 'Mientras la app est\u00e1 en uso', role: 'accept', id: 'vendor/a' },
      { label: 'Solo esta vez', role: 'accept', id: 'vendor/b' },
    ];
    expect(selectRankedAlertButtonByRole(buttons, 'accept', () => null)).toBeNull();
  });
});
