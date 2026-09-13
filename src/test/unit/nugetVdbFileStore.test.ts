import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { vdbFileStore } from '../../nugetVdbFileStore';

const BASE = 'https://feed.example/v3/vulnerabilities/2026.09.09.23.26.42/vulnerability.base.json';

let dir: string;

beforeEach(async () => {
  dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'ave-vdb-')), 'pages');
});

afterEach(async () => {
  await fs.rm(path.dirname(dir), { recursive: true, force: true });
});

describe('vdbFileStore', () => {
  it('reads back what it wrote, creating the directory on the way', async () => {
    const store = vdbFileStore(dir);

    await store.write(BASE, '{"newtonsoft.json":[]}');

    expect(await store.read(BASE)).toBe('{"newtonsoft.json":[]}');
  });

  it('keeps documents of different addresses apart', async () => {
    const store = vdbFileStore(dir);
    const other = BASE.replace('base', 'update');

    await store.write(BASE, 'first');
    await store.write(other, 'second');

    expect(await store.read(BASE)).toBe('first');
    expect(await store.read(other)).toBe('second');
  });

  it('answers nothing for an address it never held', async () => {
    expect(await vdbFileStore(dir).read(BASE)).toBeUndefined();
  });

  it('leaves no half-written file behind a write', async () => {
    const store = vdbFileStore(dir);

    await store.write(BASE, '{"a":[]}');

    const names = await fs.readdir(dir);
    expect(names.every((n) => n.endsWith('.json'))).toBe(true);
    expect(names).toHaveLength(1);
  });

  it('keeps only the newest few, since old addresses are never read again', async () => {
    const store = vdbFileStore(dir);

    for (let i = 0; i < 10; i++) {
      await store.write(`${BASE}?generation=${i}`, `page-${i}`);
      // Distinguish modification times on file systems with coarse timestamps.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(await fs.readdir(dir)).toHaveLength(6);
    expect(await store.read(`${BASE}?generation=9`)).toBe('page-9');
    expect(await store.read(`${BASE}?generation=0`)).toBeUndefined();
  });

  it('survives a directory it cannot use instead of failing the scan', async () => {
    // The store sits on a best-effort path: a cache that cannot be written is
    // not a reason for the vulnerability scan to fail.
    const file = path.join(path.dirname(dir), 'a-file');
    await fs.writeFile(file, 'not a directory', 'utf8');
    const store = vdbFileStore(path.join(file, 'pages'));

    await expect(store.write(BASE, '{}')).rejects.toBeDefined();
    expect(await store.read(BASE)).toBeUndefined();
  });
});
