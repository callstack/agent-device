import type { HumanControlHold, HumanControlHoldScope } from '@agent-device/contracts/client';

export const HUMAN_CONTROL_SCOPE: HumanControlHoldScope = {
  backend: 'ios-instance',
  leaseProvider: 'proxy',
  deviceKey: 'ios:mobile:sim-1',
};

export const HUMAN_CONTROL_HOLD: HumanControlHold = {
  id: 'operator-1',
  scope: HUMAN_CONTROL_SCOPE,
  state: 'active',
  reason: 'Manual inspection',
  createdAt: 1_000,
  updatedAt: 1_000,
  expiresAt: 16_000,
};
