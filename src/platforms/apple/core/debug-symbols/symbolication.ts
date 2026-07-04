import type { DsymMatch, SymbolicatedAddress, SymbolicationGroup } from './types.ts';
import { addressKey, hex, unique } from './utils.ts';
import { requireExecSuccess, runCmd } from '../../../../utils/exec.ts';
import { AppError } from '../../../../kernel/errors.ts';

export async function symbolicateAddresses(
  addresses: SymbolicatedAddress[],
  matched: Map<string, DsymMatch>,
  atos: string,
): Promise<Map<string, SymbolicatedAddress>> {
  const addressMap = new Map<string, SymbolicatedAddress>();
  for (const group of groupSymbolicationAddresses(addresses, matched).values()) {
    for (const entry of await runAtosForGroup(atos, group)) {
      addressMap.set(addressKey(entry.image, entry.address), entry);
    }
  }
  return addressMap;
}

function groupSymbolicationAddresses(
  addresses: SymbolicatedAddress[],
  matched: Map<string, DsymMatch>,
): Map<string, SymbolicationGroup> {
  const groups = new Map<string, SymbolicationGroup>();
  for (const frame of addresses) {
    const match = matched.get(frame.image.uuid);
    if (!match) continue;
    const key = `${frame.image.uuid}:${match.dsym.binaryPath}`;
    const group = groups.get(key) ?? { ...match, addresses: [] };
    group.addresses.push(frame.address);
    groups.set(key, group);
  }
  return groups;
}

async function runAtosForGroup(
  atos: string,
  group: SymbolicationGroup,
): Promise<SymbolicatedAddress[]> {
  const addresses = unique(group.addresses.map(hex));
  const result = requireExecSuccess(
    await runCmd(atos, atosArgs(group, addresses), {
      timeoutMs: 30_000,
      allowFailure: true,
    }),
    'atos failed while symbolicating crash frames.',
    {
      hint: 'Verify the crash artifact and dSYM were produced from the same build and architecture.',
    },
  );
  return mapAtosOutputToAddresses(group.image, addresses, result.stdout);
}

function atosArgs(group: SymbolicationGroup, addresses: string[]): string[] {
  return [
    '-arch',
    group.image.arch ?? group.dsym.arch ?? 'arm64',
    '-o',
    group.dsym.binaryPath,
    '-l',
    hex(group.image.base),
    ...addresses,
  ];
}

function mapAtosOutputToAddresses(
  image: SymbolicatedAddress['image'],
  addresses: string[],
  output: string,
): SymbolicatedAddress[] {
  const symbols = splitAtosOutput(output);
  return addresses.map((rawAddress, index) => {
    const text = symbols[index]?.trim();
    return {
      image,
      address: BigInt(rawAddress),
      text: isSymbolicatedAtosOutput(text, rawAddress) ? text : undefined,
    };
  });
}

function splitAtosOutput(output: string): string[] {
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function isSymbolicatedAtosOutput(text: string | undefined, rawAddress: string): text is string {
  if (!text) return false;
  const normalized = text.trim().toLowerCase();
  if (!normalized || normalized === '??') return false;
  if (normalized === rawAddress.toLowerCase()) return false;
  return !normalized.startsWith('0x');
}

export async function resolveAppleTools(): Promise<{ dwarfdump: string; atos: string }> {
  return {
    dwarfdump: await resolveAppleTool('dwarfdump'),
    atos: await resolveAppleTool('atos'),
  };
}

async function resolveAppleTool(name: 'dwarfdump' | 'atos'): Promise<string> {
  try {
    const result = await runCmd('xcrun', ['--find', name], {
      timeoutMs: 5_000,
      allowFailure: true,
    });
    const toolPath = result.stdout.trim();
    if (result.exitCode === 0 && toolPath.length > 0) return toolPath;
  } catch {
    // Fall through to the normalized TOOL_MISSING error below.
  }
  throw new AppError('TOOL_MISSING', `Apple symbolication tool not found: ${name}`, {
    hint: 'Install Xcode Command Line Tools and verify xcrun --find dwarfdump and xcrun --find atos succeed.',
  });
}
