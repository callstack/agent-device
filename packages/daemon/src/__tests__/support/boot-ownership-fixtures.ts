import type { CloseBootOwnership } from '@agent-device/contracts/device-boot';

/**
 * The boot ownership an `open` records when it proved nothing about the device's boot: it owns no
 * stop, and it disproved nothing. Suites that are not about boot ownership pass this instead of
 * inventing one of their own, so a new answer of the pair cannot be quietly defaulted away.
 */
export const NO_BOOT_PROOF: CloseBootOwnership = 'none';
