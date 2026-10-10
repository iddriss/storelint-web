import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ReportRow, Store } from './db.js';
import type { Scanner } from './scanner.js';
import { withTimeout } from './scanner.js';
import type { Report } from './types.js';
import { ZipError, extractZip } from './zip.js';

/** A problem with the uploaded archive; surfaces as HTTP 400. */
export class ScanInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanInputError';
  }
}

export interface ScanOutcome {
  row: ReportRow;
  report: Report;
}

export interface ScanDeps {
  store: Store;
  scanner: Scanner;
  scanTimeoutMs: number;
}

/**
 * Writes the uploaded zip to a fresh temp dir, extracts it safely, runs the scanner on
 * the project root, stores the report, and always removes the temp dir afterwards.
 */
export async function scanUploadedZip(zip: Buffer, deps: ScanDeps): Promise<ScanOutcome> {
  if (zip.length < 22 || zip.readUInt32LE(0) !== 0x04034b50) {
    // Local file header signature "PK\x03\x04". Empty archives start with the EOCD instead.
    throw new ScanInputError('That file does not look like a zip archive.');
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'storelint-'));
  try {
    const zipPath = path.join(tmp, 'upload.zip');
    const projectDir = path.join(tmp, 'project');
    await writeFile(zipPath, zip, { mode: 0o600 });
    await mkdir(projectDir);

    let extracted;
    try {
      extracted = await extractZip(zipPath, projectDir);
    } catch (err) {
      if (err instanceof ZipError) throw new ScanInputError(err.message);
      throw err;
    }
    if (extracted.files === 0) throw new ScanInputError('The archive contains no files.');

    const root = await pickProjectRoot(projectDir);
    const report = await withTimeout(deps.scanner.scan(root), deps.scanTimeoutMs, 'scan');
    const row = deps.store.insertReport(JSON.stringify(report));
    return { row, report };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** `zip -r app.zip my_app/` yields a single top-level folder; scan inside it in that case. */
async function pickProjectRoot(dir: string): Promise<string> {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
  if (entries.length === 1 && entries[0]?.isDirectory()) {
    return path.join(dir, entries[0].name);
  }
  return dir;
}
