const ATOM_HEADER_BYTES = 8;
const EXTENDED_SIZE_BYTES = 8;
const MOVIE_HEADER_V0_PAYLOAD_BYTES = 100;
const MOVIE_HEADER_V1_PAYLOAD_BYTES = 112;

export function mp4Atom(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(ATOM_HEADER_BYTES);
  header.writeUInt32BE(ATOM_HEADER_BYTES + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

export function mp4AtomWithExtendedSize(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(ATOM_HEADER_BYTES + EXTENDED_SIZE_BYTES);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 'latin1');
  header.writeBigUInt64BE(BigInt(header.length + payload.length), ATOM_HEADER_BYTES);
  return Buffer.concat([header, payload]);
}

export function mp4MovieHeader(params: {
  version: 0 | 1;
  timescale: number;
  duration: number;
}): Buffer {
  const versioned = params.version === 1;
  const payload = Buffer.alloc(
    versioned ? MOVIE_HEADER_V1_PAYLOAD_BYTES : MOVIE_HEADER_V0_PAYLOAD_BYTES,
  );
  payload.writeUInt8(params.version, 0);
  if (versioned) {
    payload.writeUInt32BE(params.timescale, 20);
    payload.writeBigUInt64BE(BigInt(params.duration), 24);
  } else {
    payload.writeUInt32BE(params.timescale, 12);
    payload.writeUInt32BE(params.duration, 16);
  }
  return payload;
}
