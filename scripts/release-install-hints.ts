import { firstPartyPluginPackages } from '@agent-device/contracts/plugin-installation';

process.stdout.write(`${[...new Set(firstPartyPluginPackages())].sort().join('\n')}\n`);
