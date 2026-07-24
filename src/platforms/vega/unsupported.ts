import { AppError } from '../../kernel/errors.ts';

export async function unsupportedVegaOperation(operation: string): Promise<never> {
  throw new AppError('UNSUPPORTED_OPERATION', `${operation} is not supported on Vega OS`);
}
