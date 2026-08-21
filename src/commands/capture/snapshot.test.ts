import { expect, test } from 'vitest';

import { snapshotCommandFacet } from './snapshot.ts';

test('snapshot help classifies iOS hittable as shared geometric actionability', () => {
  const detail = snapshotCommandFacet.text.cliDetail ?? '';

  for (const backend of ['tree', 'queries', 'private-ax']) {
    expect(detail).toContain(`${backend}: hittable=geometric-actionability`);
  }
  expect(detail).not.toMatch(/hittable=(?:hit-tested|approximated)/);
});
