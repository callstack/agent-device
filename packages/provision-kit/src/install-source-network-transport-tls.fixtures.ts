import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { mkdtempForTest } from './tmp-dir.fixtures.ts';

/**
 * Runs the transport's TLS scenarios in a fresh process.
 *
 * TLS trust is fixed while a process starts, so a test worker cannot make itself trust the loopback
 * fixture certificate; the caller passes `NODE_EXTRA_CA_CERTS` at spawn time. The child is written
 * to a temporary file and owns no listeners, so the parent's loopback origin stays the single place
 * where SNI names and CONNECT authorities are observed.
 */
export async function runTlsScenarios(params: {
  /** Absolute path of the transport module the child imports. */
  subjectPath: string;
  tlsOriginPort: number;
  proxyPort: number;
  scenarios: TlsScenario[];
  /** Trusts the loopback fixture certificate when true; the child rejects it when false. */
  trustFixtureCertificate: boolean;
  fixtureCertificatePath: string;
}): Promise<TlsScenarioResult[]> {
  return await runTransportChild<TlsScenarioResult>(
    tlsChildSource(),
    [
      params.subjectPath,
      String(params.tlsOriginPort),
      String(params.proxyPort),
      ...params.scenarios,
    ],
    params.trustFixtureCertificate ? params.fixtureCertificatePath : '',
    Math.max(1, params.scenarios.length) * 6_000,
  );
}

export type TlsScenario =
  | 'direct'
  | 'proxied'
  | 'proxied-literal-ip'
  | 'direct-altname-mismatch'
  | 'direct-literal-ip';

type TlsScenarioResult = {
  scenario: TlsScenario;
  outcome: 'response' | 'rejection';
  statusCode?: number;
  body?: string;
  /** The name the TLS origin saw at the handshake, echoed back by it. `'false'` means no SNI. */
  sniHeader?: string;
  error?: { name?: string; code?: string | number; message?: string };
};

export function transportModulePath(dir: string): string {
  return path.join(dir, 'install-source-network-transport.ts');
}

/**
 * The child's source. It is plain ESM so the child needs no loader: it imports the transport module
 * by absolute path, which Node strips of types for a `.ts` target.
 *
 * The URL hostnames come from the caller's arguments: `argv[2]` is the transport module, then the
 * TLS origin port, the proxy port, and the scenarios to run.
 */
function tlsChildSource(): string {
  return `
import { pathToFileURL } from 'node:url';

const [subjectPath, tlsOriginPort, proxyPort, ...scenarios] = process.argv.slice(2);
const { requestApprovedUrl } = await import(pathToFileURL(subjectPath).href);
const APPROVED_ADDRESS = '127.0.0.1';

const shape = (error) => ({ name: error?.name, code: error?.code, message: error?.message });

for (const scenario of scenarios) {
  const proxied = scenario.startsWith('proxied');
  const literalIp = scenario.endsWith('literal-ip');
  const hostname = literalIp
    ? APPROVED_ADDRESS
    : scenario.includes('altname-mismatch')
      ? 'elsewhere.invalid'
      : 'localhost';
  const url = new URL('https://' + hostname + ':' + tlsOriginPort + '/artifact.bin');
  const environment = proxied
    ? { HTTPS_PROXY: 'http://' + APPROVED_ADDRESS + ':' + proxyPort }
    : { NO_PROXY: '*' };
  try {
    const response = await requestApprovedUrl({
      url,
      approvedAddress: APPROVED_ADDRESS,
      family: 4,
      headers: proxied ? { host: 'bad.example.test:' + tlsOriginPort } : {},
      signal: AbortSignal.timeout(4000),
      environment,
    });
    let body = '';
    for await (const chunk of response.body) body += Buffer.from(chunk).toString('utf8');
    const sni = response.headers['x-sni'];
    console.log(JSON.stringify({
      scenario,
      outcome: 'response',
      statusCode: response.statusCode,
      body,
      sniHeader: Array.isArray(sni) ? sni[0] : sni,
    }));
    await response.close();
  } catch (error) {
    console.log(JSON.stringify({ scenario, outcome: 'rejection', error: shape(error) }));
  }
}
process.exit(0);
`;
}

const execFileAsync = promisify(execFile);

export async function runTransportChild<T>(
  source: string,
  args: string[],
  certificatePath: string,
  timeout: number,
): Promise<T[]> {
  const dir = await mkdtempForTest('install-source-tls-child-');
  const childPath = path.join(dir, 'child.mjs');
  try {
    await fs.writeFile(childPath, source, 'utf8');
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', childPath, ...args],
      { env: { ...process.env, NODE_EXTRA_CA_CERTS: certificatePath }, timeout },
    );
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as T);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
