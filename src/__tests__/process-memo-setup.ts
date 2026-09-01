import { afterEach } from 'vitest';

import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';

afterEach(() => {
  resetAllProcessMemosForTests();
});
