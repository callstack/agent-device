import { readUpdateCheckWorkerArgs, runUpdateCheckWorker } from './update-check.ts';

const workerArgs = readUpdateCheckWorkerArgs(process.argv.slice(2));
if (workerArgs) {
  void runUpdateCheckWorker(workerArgs).catch(() => {
    process.exitCode = 0;
  });
}
