import { AppError } from '../kernel/errors.ts';

export type LocationCoordinateLabel = 'latitude' | 'longitude';

export type LocationCoordinates = {
  latitude: number;
  longitude: number;
};

type LocationCoordinateInput = Partial<LocationCoordinates> | undefined;

export function readLocationCoordinate(
  value: string | undefined,
  label: LocationCoordinateLabel,
): number {
  if (value === undefined || value.trim() === '') {
    throw new AppError('INVALID_ARGS', `settings location set requires ${label}`);
  }
  return validateLocationCoordinate(Number(value), label);
}

export function requireLocationCoordinates(options: LocationCoordinateInput): LocationCoordinates {
  return {
    latitude: validateLocationCoordinate(options?.latitude, 'latitude'),
    longitude: validateLocationCoordinate(options?.longitude, 'longitude'),
  };
}

function validateLocationCoordinate(value: unknown, label: LocationCoordinateLabel): number {
  const min = label === 'latitude' ? -90 : -180;
  const max = label === 'latitude' ? 90 : 180;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new AppError('INVALID_ARGS', `${label} must be a number from ${min} to ${max}`);
  }
  return value;
}
