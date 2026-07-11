import fs from 'node:fs';
import { expect, test } from 'vitest';
import { getFlagDefinitions } from '../../../commands/cli-grammar/flag-registry.ts';
import {
  MAESTRO_COMPAT_SUPPORTED_CAPABILITIES,
  MAESTRO_COMPAT_TRACKER_URL,
  formatMaestroCapabilityList,
} from '../support-matrix.ts';

test('Maestro CLI help uses the shared compatibility support matrix', () => {
  const flag = getFlagDefinitions().find((definition) => definition.key === 'replayMaestro');
  expect(flag?.usageDescription).toContain(
    `Supported subset: ${formatMaestroCapabilityList(MAESTRO_COMPAT_SUPPORTED_CAPABILITIES)}.`,
  );
  expect(flag?.usageDescription).toContain(MAESTRO_COMPAT_TRACKER_URL);
});

test('Maestro replay docs stay in sync with the compatibility support matrix', () => {
  const docs = fs.readFileSync('website/docs/docs/replay-e2e.md', 'utf8');
  const plainDocs = docs.replace(/`/g, '');
  for (const capability of MAESTRO_COMPAT_SUPPORTED_CAPABILITIES) {
    expect(plainDocs).toContain(capability);
  }
});
