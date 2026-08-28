import assert from 'node:assert/strict';
import type { Server } from 'node:net';
import { afterEach, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createUsbmuxRunnerTransport } from '../runner-usbmux.ts';
import {
  buildPacket,
  cleanupUsbmuxFixtures,
  createFakeUsbmuxd,
  createSocketPath,
  readHttpRequestBody,
  readPacket,
} from './runner-usbmux-fixtures.ts';

const DEVICE_UDID = '00008020-001C2D2234567890';
const RUNNER_PORT = 51_234;
const openServers: Server[] = [];
const socketDirectories: string[] = [];

afterEach(async () => {
  await cleanupUsbmuxFixtures(openServers, socketDirectories);
});

test('usbmux read timeout is bounded at the packet seam', async () => {
  const socketPath = await createSocketPath(socketDirectories);
  await createFakeUsbmuxd(openServers, socketPath, async (socket) => {
    await readPacket(socket);
    await waitForClose(socket);
  });

  const error = await post(socketPath, 60).catch((error: unknown) => error);
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.match(error.message, /Timed out reading usbmuxd response/);
});

test('usbmux cancellation interrupts an in-flight packet read', async () => {
  const socketPath = await createSocketPath(socketDirectories);
  let markRequestReceived: () => void = () => {};
  const requestReceived = new Promise<void>((resolve) => {
    markRequestReceived = resolve;
  });
  await createFakeUsbmuxd(openServers, socketPath, async (socket) => {
    await readPacket(socket);
    markRequestReceived();
    await waitForClose(socket);
  });

  const controller = new AbortController();
  const request = post(socketPath, 1_000, controller.signal);
  await requestReceived;
  controller.abort();

  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(error.message, 'request canceled');
    assert.equal(error.details?.reason, 'request_canceled');
    return true;
  });
});

test('usbmux partial packets fail as a closed response, not as a successful device lookup', async () => {
  const socketPath = await createSocketPath(socketDirectories);
  await createFakeUsbmuxd(openServers, socketPath, async (socket) => {
    await readPacket(socket);
    const header = Buffer.alloc(16);
    header.writeUInt32LE(32, 0);
    socket.end(header);
  });

  const error = await post(socketPath, 1_000).catch((error: unknown) => error);
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.message, 'usbmuxd closed the connection unexpectedly');
});

test('usbmux malformed packet lengths stay typed at the protocol seam', async () => {
  const socketPath = await createSocketPath(socketDirectories);
  await createFakeUsbmuxd(openServers, socketPath, async (socket) => {
    await readPacket(socket);
    const header = Buffer.alloc(16);
    header.writeUInt32LE(8, 0);
    socket.end(header);
  });

  const error = await post(socketPath, 1_000).catch((error: unknown) => error);
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.message, 'Invalid usbmuxd response length');
});

test('usbmux process death after runner request is never replayed', async () => {
  const socketPath = await createSocketPath(socketDirectories);
  let runnerRequests = 0;
  const { done } = await createFakeUsbmuxd(openServers, socketPath, async (socket, index) => {
    if (index === 0) {
      await readPacket(socket);
      socket.end(
        buildPacket(
          '<plist><dict><key>DeviceList</key><array><dict><key>DeviceID</key><integer>42</integer><key>Properties</key><dict><key>SerialNumber</key><string>00008020-001C2D2234567890</string></dict></dict></array></dict></plist>',
        ),
      );
      return;
    }
    await readPacket(socket);
    socket.write(
      buildPacket(
        '<plist><dict><key>MessageType</key><string>Result</string><key>Number</key><integer>0</integer></dict></plist>',
      ),
    );
    await readHttpRequestBody(socket);
    runnerRequests += 1;
    socket.destroy();
  });

  await assert.rejects(post(socketPath, 1_000));
  await done;
  assert.equal(runnerRequests, 1);
});

async function post(
  socketPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  return await createUsbmuxRunnerTransport(socketPath).postCommand(
    DEVICE_UDID,
    RUNNER_PORT,
    { command: 'uptime' },
    timeoutMs,
    signal,
  );
}

async function waitForClose(socket: { once: (event: 'close', listener: () => void) => void }) {
  await new Promise<void>((resolve) => socket.once('close', resolve));
}
