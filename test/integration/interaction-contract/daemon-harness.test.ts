import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { withIosContractDaemon } from './daemon-harness.ts';

test('independent contract daemons can use their own fake simulator with the same ID', async () => {
  const inheritedClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = mkdtempForTestSync('shared-contract-claims-');
  try {
    await withIosContractDaemon([], async () => {
      await withIosContractDaemon([], async () => {});
    });
  } finally {
    if (inheritedClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = inheritedClaimsDir;
  }
});
