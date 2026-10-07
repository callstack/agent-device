import type { CloudWebDriverRuntimeOptions } from '@agent-device/provider-webdriver/plugin';

export type WebDriverPluginOptions = Omit<CloudWebDriverRuntimeOptions, 'clientVersion'>;
