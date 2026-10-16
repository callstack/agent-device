import { expect, test } from 'vitest';
import type { ProviderProfileField } from '@agent-device/contracts/provider-profile-fields';
import {
  PROVIDER_PROFILE_FIELD_FLAG_ALIASES,
  PROVIDER_PROFILE_FIELD_FLAGS,
} from '@agent-device/contracts/remote';
import { getFlagDefinitionsForKey } from '../flag-registry.ts';

// Refusals and BrowserStack feature errors name flags from this map, so each must be the CLI's
// canonical spelling of that field.
test('every provider profile field flag is the canonical CLI flag for its field', () => {
  for (const [field, flag] of Object.entries(PROVIDER_PROFILE_FIELD_FLAGS) as Array<
    [ProviderProfileField, string]
  >) {
    expect(getFlagDefinitionsForKey(field)[0]?.names[0], field).toBe(flag);
  }
});

// Contracts cannot depend on the command registry, so refusals carry their own copy of each field's
// accepted aliases; it must match the aliases the CLI parses.
test('every provider profile field lists the aliases the CLI accepts for it', () => {
  for (const field of Object.keys(PROVIDER_PROFILE_FIELD_FLAGS) as ProviderProfileField[]) {
    expect(PROVIDER_PROFILE_FIELD_FLAG_ALIASES[field] ?? [], field).toEqual(
      getFlagDefinitionsForKey(field)[0]?.names.slice(1),
    );
  }
});
