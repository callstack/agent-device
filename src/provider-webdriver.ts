import { createProviderWebDriver } from '@agent-device/provider-webdriver';
import { runCmd } from '@agent-device/host-kit/command';
import { readVersion } from '@agent-device/host-kit/version';

export const providerWebDriver = createProviderWebDriver({
  clientVersion: readVersion(),
  runHostCommand: async (command, args) => {
    const result = await runCmd(command, [...args], {
      maxBuffer: 10 * 1024 * 1024,
      timeoutMs: 30_000,
    });
    return { stdout: result.stdout };
  },
});
