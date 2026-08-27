import { afterEach } from 'vitest';

import { resetAllProcessMemosForTests } from '@agent-device/host-kit/values';

afterEach(() => {
  resetAllProcessMemosForTests();
});
