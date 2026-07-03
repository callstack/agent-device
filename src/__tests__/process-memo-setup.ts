import { afterEach } from 'vitest';

import { resetAllProcessMemosForTests } from '../utils/ttl-memo.ts';

afterEach(() => {
  resetAllProcessMemosForTests();
});
