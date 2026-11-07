export const PROVIDER = 'tizen';

export type TizenOptions = Readonly<{
  /** Path to `sdb` when it is not found in the Tizen SDK named by $TIZEN_SDK or ~/.tizen.path.config. */
  sdbPath?: string;
  /** TV to drive when the lease names none: an sdb serial or an IP; defaults to the only connected TV. */
  device?: string;
}>;
