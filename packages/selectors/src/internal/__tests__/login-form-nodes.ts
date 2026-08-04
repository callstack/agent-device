import type { SnapshotState } from '@agent-device/kernel/snapshot';

/**
 * A login form whose two "Continue" buttons make `label="Continue"` ambiguous
 * and `id=` unique — the smallest tree that exercises alternative fallback,
 * strict-uniqueness refusal, and first-match existence in one shape.
 */
export const loginFormNodes: SnapshotState['nodes'] = [
  {
    ref: 'e1',
    index: 0,
    type: 'XCUIElementTypeTextField',
    label: 'Email',
    value: '',
    identifier: 'login_email',
    rect: { x: 0, y: 0, width: 200, height: 44 },
    enabled: true,
    hittable: true,
  },
  {
    ref: 'e2',
    index: 1,
    type: 'XCUIElementTypeButton',
    label: 'Continue',
    identifier: 'auth_continue',
    rect: { x: 0, y: 80, width: 200, height: 44 },
    enabled: true,
    hittable: true,
  },
  {
    ref: 'e3',
    index: 2,
    type: 'XCUIElementTypeButton',
    label: 'Continue',
    identifier: 'secondary_continue',
    rect: { x: 0, y: 140, width: 200, height: 44 },
    enabled: true,
    hittable: true,
  },
];
