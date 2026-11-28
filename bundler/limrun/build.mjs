import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';
import { providerPluginWithBundledDependencies } from '@agent-device/build-config';
import { bundledLicenseNotices } from '../../scripts/lib/bundled-license-notices.ts';

await build({
  config: false,
  cwd: fileURLToPath(new URL('../../packages/provider-limrun', import.meta.url)),
  ...providerPluginWithBundledDependencies(
    ['@limrun/api'],
    bundledLicenseNotices(fileURLToPath(new URL('../..', import.meta.url))),
  ),
  dts: true,
  tsconfig: '../../tsconfig.lib.json',
});
