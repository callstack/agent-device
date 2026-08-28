import type { CloudProviderSessionResult } from '@agent-device/contracts/observability';

export function providerSessionResult(response: {
  provider?: CloudProviderSessionResult;
}): CloudProviderSessionResult | undefined {
  return response.provider;
}
