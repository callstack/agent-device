import { chmodSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { isProcessAlive, waitForProcessExit } from '@agent-device/host-kit/process';
import { closeLoopbackServer, listenOnLoopback } from './loopback.ts';

export function writeFakeMetroNpx(binDir: string, reloadPath = '/reload'): void {
  const filePath = path.join(binDir, 'npx');
  writeFileSync(
    filePath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const http = require("node:http")
const args = process.argv.slice(2)
if (process.env.AGENT_DEVICE_TEST_NPX_ARGS_FILE) {
  fs.writeFileSync(process.env.AGENT_DEVICE_TEST_NPX_ARGS_FILE, JSON.stringify(args))
}
const portIndex = args.indexOf("--port")
const hostIndex = args.indexOf("--host")
const port = portIndex === -1 ? 8081 : Number(args[portIndex + 1] || "8081")
// "expo start" takes a connectivity mode ("lan", "tunnel", "localhost") for --host, not a bind
// address; every other caller (react-native/rspack/webpack start) passes a real bind address.
const rawHost = hostIndex === -1 ? "0.0.0.0" : String(args[hostIndex + 1] || "0.0.0.0")
const host = rawHost === "lan" || rawHost === "tunnel" ? "0.0.0.0" : rawHost
const reloadPath = ${JSON.stringify(reloadPath)}
const server = http.createServer((req, res) => {
  if (req.url === "/status") {
    res.statusCode = 200
    res.end("packager-status:running")
    return
  }
  if (req.url && (req.url.startsWith("/index.bundle") || req.url.includes(".virtual-metro-entry.bundle"))) {
    res.statusCode = 200
    res.setHeader("content-type", "application/javascript")
    res.end("console.log('metro-runtime-test')")
    return
  }
  if (req.url === reloadPath) {
    res.statusCode = 200
    res.end("RELOADED")
    return
  }
  res.statusCode = 404
  res.end("not found")
})
server.listen(port, host)
setInterval(() => {}, 1000)
`,
  );
  chmodSync(filePath, 0o755);
}

export async function findFreeMetroPort(): Promise<number> {
  const server = net.createServer();
  const port = await listenOnLoopback(server);
  await closeLoopbackServer(server);
  return port;
}

export async function stopTestMetroProcess(pid: number): Promise<void> {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  if (await waitForProcessExit(pid, 1_500)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
  await waitForProcessExit(pid, 1_500);
}
