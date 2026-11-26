import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';
import { providerPluginWithBundledDependencies } from '@agent-device/build-config';
import { bundledLicenseNotices } from '../../scripts/lib/bundled-license-notices.ts';

export default defineConfig({
  cwd: fileURLToPath(new URL('../../packages/provider-limrun', import.meta.url)),
  ...providerPluginWithBundledDependencies(
    ['@limrun/api'],
    bundledLicenseNotices(fileURLToPath(new URL('../..', import.meta.url))),
  ),
  dts: true,
  tsconfig: '../../tsconfig.lib.json',
});
