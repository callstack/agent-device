// Type surface for the Stryker reporter plugin module (Stryker loads it as plain JavaScript).
// Keep it in step with the exports of `./coverage-reporter.mjs`.
import type { PluginKind, ValuePlugin } from '@stryker-mutator/api/plugin';

export const COVERAGE_CAPTURE_ENV: 'AGENT_DEVICE_MUTATION_COVERAGE_CAPTURE';

export const strykerPlugins: readonly ValuePlugin<PluginKind.Reporter>[];
