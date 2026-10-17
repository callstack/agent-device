import fs from 'node:fs';
import type { Reporter } from 'vitest/node';

export type TestReport = {
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  failedModules: number;
  unhandledErrors: number;
  failures: {
    kind: 'test' | 'suite' | 'unhandled';
    file?: string;
    test?: string;
    errors: string[];
  }[];
};

export function validationTestReporter(destination: string | undefined): Reporter {
  return {
    onTestRunEnd(modules, unhandledErrors) {
      if (!destination) return;
      const report: TestReport = {
        passed: 0,
        failed: 0,
        skipped: 0,
        pending: 0,
        failedModules: modules.filter((module) => !module.ok()).length,
        unhandledErrors: unhandledErrors.length,
        failures: [],
      };
      const messages = (errors: readonly { stack?: string; message?: string }[]) =>
        errors.map((error) => error.stack || error.message || String(error));
      for (const module of modules) {
        for (const suite of [module, ...module.children.allSuites()]) {
          const errors = suite.errors();
          if (errors.length)
            report.failures.push({
              kind: 'suite',
              file: module.moduleId,
              errors: messages(errors),
            });
        }
        for (const test of module.children.allTests()) {
          const result = test.result();
          report[result.state]++;
          if (result.state === 'failed')
            report.failures.push({
              kind: 'test',
              file: module.moduleId,
              test: test.fullName,
              errors: messages(result.errors),
            });
        }
      }
      for (const error of unhandledErrors)
        report.failures.push({ kind: 'unhandled', errors: messages([error]) });
      fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
    },
  };
}
