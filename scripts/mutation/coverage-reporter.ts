import fs from 'node:fs';
import { declareValuePlugin, PluginKind } from '@stryker-mutator/api/plugin';
import type { Reporter } from '@stryker-mutator/api/report';

export const COVERAGE_CAPTURE_ENV = 'AGENT_DEVICE_MUTATION_COVERAGE_CAPTURE';

const reporter: Reporter = {
  onDryRunCompleted(event) {
    const target = process.env[COVERAGE_CAPTURE_ENV];
    if (!target) throw new Error('Mutation coverage capture path is missing');
    fs.writeFileSync(target, JSON.stringify(event));
  },
};

export const strykerPlugins = [declareValuePlugin(PluginKind.Reporter, 'scope-coverage', reporter)];
