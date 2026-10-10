import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_MAX_ENTRIES, ZipError, extractZip, isSafeEntryName, isSymlinkEntry } from '../src/zip.js';
import { buildZip, sampleProjectZip } from './zip-helper.js';

describe('zip extraction', () => {
  let tmp: string;
  let dest: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'storelint-test-'));
    dest = path.join(tmp, 'out');
    await mkdir(dest);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function write(name: string, zip: Buffer): Promise<string> {
    const p = path.join(tmp, name);
    await writeFile(p, zip);
    return p;
  }

  it('extracts a normal archive and skips __MACOSX', async () => {
    const result = await extractZip(await write('ok.zip', sampleProjectZip()), dest);
    assert.equal(result.files, 2);
    assert.equal(result.skipped, 1);
    assert.deepEqual((await readdir(dest)).sort(), ['my_app']);
    assert.equal((await stat(path.join(dest, 'my_app/lib/main.dart'))).size, 15);
  });

  it('rejects path traversal and writes nothing outside the destination', async () => {
    const zip = buildZip([{ name: '../evil.txt', data: 'pwned' }]);
    await assert.rejects(extractZip(await write('bad.zip', zip), dest), ZipError);
    await assert.rejects(stat(path.join(tmp, 'evil.txt')));
    assert.deepEqual(await readdir(dest), []);
  });

  it('rejects nested traversal, absolute and backslash paths', async () => {
    for (const name of ['a/b/../../../x', '/etc/passwd', 'c:\\windows\\x', 'ok/..\\..\\x']) {
      const zip = buildZip([{ name, data: 'x' }]);
      await assert.rejects(extractZip(await write('bad2.zip', zip), dest), ZipError, name);
    }
    assert.deepEqual(await readdir(dest), []);
  });

  it('rejects symlink entries', async () => {
    const zip = buildZip([{ name: 'link', data: '/etc/passwd', mode: 0o120777 }]);
    await assert.rejects(extractZip(await write('link.zip', zip), dest), /Symbolic links/);
    assert.deepEqual(await readdir(dest), []);
  });

  it('rejects archives with too many entries', async () => {
    const zip = buildZip([
      { name: 'a', data: '1' },
      { name: 'b', data: '2' },
      { name: 'c', data: '3' },
    ]);
    await assert.rejects(extractZip(await write('many.zip', zip), dest, { maxEntries: 2 }), /entries/);
    assert.equal(DEFAULT_MAX_ENTRIES, 20_000);
  });

  it('rejects archives that expand beyond the size budget', async () => {
    const zip = buildZip([{ name: 'big', data: Buffer.alloc(2048, 1) }]);
    await assert.rejects(extractZip(await write('big.zip', zip), dest, { maxTotalBytes: 1024 }), /expands/);
  });

  it('rejects garbage', async () => {
    await assert.rejects(extractZip(await write('garbage.zip', Buffer.from('not a zip')), dest), ZipError);
  });

  it('isSafeEntryName', () => {
    assert.equal(isSafeEntryName('lib/main.dart'), true);
    assert.equal(isSafeEntryName('..'), false);
    assert.equal(isSafeEntryName('a/../b'), false);
    assert.equal(isSafeEntryName('/abs'), false);
    assert.equal(isSafeEntryName('C:/x'), false);
    assert.equal(isSafeEntryName('a\\b'), false);
    assert.equal(isSafeEntryName('a\0b'), false);
    assert.equal(isSafeEntryName(''), false);
    assert.equal(isSafeEntryName('..foo/bar'), true);
  });

  it('isSymlinkEntry reads the unix mode bits', () => {
    assert.equal(isSymlinkEntry({ externalFileAttributes: (0o120777 << 16) >>> 0 }), true);
    assert.equal(isSymlinkEntry({ externalFileAttributes: (0o100644 << 16) >>> 0 }), false);
    assert.equal(isSymlinkEntry({ externalFileAttributes: 0 }), false);
  });
});
