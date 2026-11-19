// fallow-ignore-file unused-file
import { fileURLToPath } from 'node:url';

export const provider = 'vphone';
export const args = ['--platform', 'ios', '--device', 'machine-a'];

export function environment() {
  return {
    VPHONE_CLI: fileURLToPath(new URL('./fixtures/vphone-cli.mjs', import.meta.url)),
  };
}
