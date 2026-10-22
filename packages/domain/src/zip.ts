/** One file in a zip archive; `read` inflates it only when asked, so a large archive is read a file at a time. */
export type ZipEntry = { name: string; read(): Promise<Uint8Array<ArrayBuffer>> };

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/**
 * The files in a zip archive, in the order its central directory lists them, or null when `bytes`
 * is not a zip. Stored and deflated entries only, without zip64, which is what Paprika writes.
 */
export function readZip(bytes: Uint8Array<ArrayBuffer>): ZipEntry[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(view);
  if (end === null) return null;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > view.byteLength || view.getUint32(at, true) !== CENTRAL_FILE_HEADER) return null;
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localHeader = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.push({ name, read: () => readEntry(bytes, view, localHeader, method, compressedSize) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Where the end-of-central-directory record starts: it is last, followed only by a comment. */
function findEnd(view: DataView): number | null {
  for (let at = view.byteLength - 22; at >= Math.max(0, view.byteLength - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  return null;
}

async function readEntry(
  bytes: Uint8Array<ArrayBuffer>,
  view: DataView,
  localHeader: number,
  method: number,
  compressedSize: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (localHeader + 30 > view.byteLength || view.getUint32(localHeader, true) !== LOCAL_FILE_HEADER) {
    throw new Error("Damaged zip entry");
  }
  const start = localHeader + 30 + view.getUint16(localHeader + 26, true) + view.getUint16(localHeader + 28, true);
  const data = bytes.subarray(start, start + compressedSize);
  if (method === 0) return data;
  if (method === 8) return decompress(data, "deflate-raw");
  throw new Error(`Unsupported zip compression method ${method}`);
}

/** Inflates `data`; rejects when it is not in `format`. */
export async function decompress(
  data: Uint8Array<ArrayBuffer>,
  format: "gzip" | "deflate-raw",
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
