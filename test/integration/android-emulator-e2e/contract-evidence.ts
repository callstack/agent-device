import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';

export type AndroidContractCommand = (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS];

export type AndroidContractEvidence = {
  commands: readonly AndroidContractCommand[];
  owner: string;
  testName: string;
};

export function defineAndroidContractEvidence(
  owner: string,
  commands: readonly AndroidContractCommand[],
  testName: string,
): AndroidContractEvidence {
  if (commands.length === 0) throw new Error(`${owner} must declare at least one command`);
  if (new Set(commands).size !== commands.length) {
    throw new Error(`${owner} declares duplicate Android contract commands`);
  }
  if (testName.trim().length === 0) throw new Error(`${owner} must name its executable test`);
  return Object.freeze({ commands: Object.freeze([...commands]), owner, testName });
}
