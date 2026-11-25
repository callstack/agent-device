// The IPC channel closes even if the agent-device daemon is killed. Keep the
// foreground adb process here so it can always be reaped before removing its sockets.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [adb, directory] = process.argv.slice(2);
if (!process.send || !adb || !directory) throw new Error('Expected an ADC supervisor IPC channel.');

const socket = path.join(directory, 'server');
const child = spawn(
  adb,
  ['-L', 'localfilesystem:' + socket, '--one-device', 'adc-no-usb', 'server', 'nodaemon'],
  {
    stdio: 'ignore',
  },
);
const exited = once(child, 'close');
let closed = false;
function stop() {
  closed = true;
  child.kill('SIGKILL');
}
process.once('disconnect', stop);
if (!process.connected) stop();
async function notifyReady() {
  while (!closed && process.connected) {
    const ready = statSync(socket, { throwIfNoEntry: false });
    if (ready?.isSocket()) {
      process.send?.('ready', (error) => {
        if (error) stop();
      });
      return;
    }
    await delay(20);
  }
}
try {
  void notifyReady().catch(stop);
  await exited;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    stop();
    await exited.catch(() => undefined);
  }
  closed = true;
  await rm(directory, { recursive: true, force: true });
  if (process.connected) process.disconnect();
}
