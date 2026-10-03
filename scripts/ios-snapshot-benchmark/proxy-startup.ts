import { asRecord, readString } from './result-values.ts';

export type ProxyStartup = {
  proxyBaseUrl: string;
  agentDeviceBaseUrl: string;
  token: string;
  stateDir: string;
};

export function findProxyStartup(output: string): ProxyStartup | undefined {
  const wholeOutput = parseProxyStartup(output);
  if (wholeOutput) return wholeOutput;
  for (const line of output.split('\n')) {
    const startup = parseProxyStartup(line);
    if (startup) return startup;
  }
  return undefined;
}

function parseProxyStartup(value: string): ProxyStartup | undefined {
  const record = asRecord(asRecord(parseJson(value))?.data);
  if (!record) return undefined;
  const values = ['proxyBaseUrl', 'agentDeviceBaseUrl', 'token', 'stateDir'].map((key) =>
    readString(record[key]),
  );
  if (values.some((value) => value === undefined)) return undefined;
  return {
    proxyBaseUrl: values[0]!,
    agentDeviceBaseUrl: values[1]!,
    token: values[2]!,
    stateDir: values[3]!,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value.trim());
  } catch {
    return undefined;
  }
}
