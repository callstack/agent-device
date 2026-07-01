import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isApplePlatform, PLATFORMS, type Platform } from '../../../kernel/device.ts';
import type { CommandCapability } from '../../capabilities.ts';
import { deriveApplePlatforms, deriveCapabilityForPlatform } from '../derive.ts';
import { platformDescriptors } from '../registry.ts';
import type { CapabilityBucket } from '../types.ts';

// Independent VERBATIM copy of the hand-authored `selectCapabilityForPlatform`
// switch (src/core/capabilities.ts, before this slice deleted it). The derive
// fold is proven byte-for-byte equal to THIS reference — not to the production
// function — so the assertion stays meaningful after the flip wires
// `selectCapabilityForPlatform` onto the derive (which would make a
// derived-vs-production comparison a tautology).
function selectCapabilityByHandSwitch(
  capability: CommandCapability,
  platform: Platform,
): CommandCapability[CapabilityBucket] {
  switch (platform) {
    case 'apple':
      return capability.apple;
    case 'android':
      return capability.android;
    case 'linux':
      return capability.linux;
    case 'web':
      return capability.web;
    default: {
      const exhaustive: never = platform;
      return exhaustive;
    }
  }
}

// Distinct object identities per bucket so a wrong-bucket selection fails the
// `===` (reference) check below, plus a sparse capability to prove `undefined`
// propagation when a family is absent.
const DENSE_CAPABILITY: CommandCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  linux: { device: true },
  web: { device: true },
};
const SPARSE_CAPABILITY: CommandCapability = {
  apple: { simulator: true },
};

test('derived bucket selection is value-identical to the hand switch for every platform', () => {
  for (const capability of [DENSE_CAPABILITY, SPARSE_CAPABILITY]) {
    for (const platform of PLATFORMS) {
      assert.equal(
        deriveCapabilityForPlatform(platformDescriptors, capability, platform),
        selectCapabilityByHandSwitch(capability, platform),
        `bucket selection for ${platform}`,
      );
    }
  }
});

test('descriptor Apple rows equal the leaf platforms where isApplePlatform is true', () => {
  const fromDescriptors = deriveApplePlatforms(platformDescriptors);
  const fromPredicate = PLATFORMS.filter((platform) => isApplePlatform(platform));

  assert.deepEqual(
    [...fromDescriptors].sort(),
    [...fromPredicate].sort(),
    'apple leaf platform set',
  );

  // The descriptor filter and the standalone fold agree.
  assert.deepEqual(
    fromDescriptors,
    platformDescriptors
      .filter((descriptor) => descriptor.isApple)
      .map((descriptor) => descriptor.platform),
  );

  // isApple is exactly the `apple` capability bucket for every row — no third state.
  for (const descriptor of platformDescriptors) {
    assert.equal(
      descriptor.isApple,
      descriptor.capabilityBucket === 'apple',
      `${descriptor.platform} isApple matches apple bucket`,
    );
  }
});

test('registry covers every leaf platform in PLATFORMS order (totality)', () => {
  assert.deepEqual(
    platformDescriptors.map((descriptor) => descriptor.platform),
    [...PLATFORMS],
    'descriptor platforms equal PLATFORMS in order',
  );
});
