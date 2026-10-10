import yauzl from 'yauzl';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Thrown for anything wrong with the archive itself (client error, not server error). */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ExtractOptions {
  /** Reject archives with more entries than this (default 20 000). */
  maxEntries?: number;
  /** Reject archives whose declared uncompressed size exceeds this (default 512 MiB). */
  maxTotalBytes?: number;
}

export interface ExtractResult {
  files: number;
  dirs: number;
  bytes: number;
  skipped: number;
}

export const DEFAULT_MAX_ENTRIES = 20_000;
export const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/** An entry name is safe when it is relative, uses forward slashes and never climbs upward. */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.length > 4096) return false;
  if (name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  for (const segment of name.split('/')) {
    if (segment === '..') return false;
  }
  return true;
}

/** Unix mode lives in the high 16 bits of externalFileAttributes; S_IFLNK is 0o120000. */
export function isSymlinkEntry(entry: { externalFileAttributes: number }): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err) reject(new ZipError(`Not a valid zip file: ${err.message}`));
      else resolve(zipfile);
    });
  });
}

function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

/**
 * Extracts `zipPath` into `destDir` (which must already exist and be empty),
 * refusing path traversal, absolute paths, symlinks, oversized archives and
 * archives with too many entries. Only Node built-ins plus yauzl are used.
 */
export async function extractZip(zipPath: string, destDir: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const root = path.resolve(destDir);
  const result: ExtractResult = { files: 0, dirs: 0, bytes: 0, skipped: 0 };

  const zipfile = await openZip(zipPath);
  if (zipfile.entryCount > maxEntries) {
    zipfile.close();
    throw new ZipError(`Archive has ${zipfile.entryCount} entries; the limit is ${maxEntries}`);
  }

  let seen = 0;
  let declaredTotal = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.on('error', (err: Error) => reject(new ZipError(`Corrupt zip: ${err.message}`)));
      zipfile.on('end', resolve);
      zipfile.on('entry', (entry: yauzl.Entry) => {
        handleEntry(entry).then(() => zipfile.readEntry(), reject);
      });
      zipfile.readEntry();
    });
  } finally {
    zipfile.close();
  }
  return result;

  async function handleEntry(entry: yauzl.Entry): Promise<void> {
    const name = entry.fileName;
    if (++seen > maxEntries) throw new ZipError(`Archive has more than ${maxEntries} entries`);
    if (!isSafeEntryName(name)) throw new ZipError(`Unsafe path in archive: ${JSON.stringify(name)}`);
    if (isSymlinkEntry(entry)) throw new ZipError(`Symbolic links are not allowed in uploads: ${name}`);

    // Finder's resource-fork sidecars are noise for a scan.
    if (name === '__MACOSX' || name.startsWith('__MACOSX/')) {
      result.skipped++;
      return;
    }

    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new ZipError(`Unsafe path in archive: ${JSON.stringify(name)}`);
    }

    if (name.endsWith('/')) {
      await mkdir(target, { recursive: true });
      result.dirs++;
      return;
    }

    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > maxTotalBytes) {
      throw new ZipError(`Archive expands to more than ${Math.round(maxTotalBytes / 1024 / 1024)} MB`);
    }

    await mkdir(path.dirname(target), { recursive: true });
    const source = await openEntryStream(zipfile, entry);
    let written = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (result.bytes + written > maxTotalBytes) {
          cb(new ZipError('Archive expands beyond the allowed size'));
          return;
        }
        cb(null, chunk);
      },
    });
    await pipeline(source, guard, createWriteStream(target, { mode: 0o644 }));
    result.bytes += written;
    result.files++;
  }
}
