import type { ArtifactAdapter } from '../io.ts';
import { AppError } from '../kernel/errors.ts';

export function createUnsupportedArtifactAdapter(
  label: string,
  options: { plural?: boolean } = {},
): ArtifactAdapter {
  const verb = options.plural === true ? 'do' : 'does';
  return {
    resolveInput: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', `${label} ${verb} not resolve input artifacts`);
    },
    reserveOutput: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', `${label} ${verb} not reserve output artifacts`);
    },
    createTempFile: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', `${label} ${verb} not create temporary files`);
    },
  };
}
