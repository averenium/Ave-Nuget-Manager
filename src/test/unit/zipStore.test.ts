import { createZip, crc32 } from '../../zipStore';
import * as zlib from 'zlib';

describe('createZip', () => {
  it('writes a deflate zip that inflates back', () => {
    const zip = createZip([
      { name: 'README.txt', data: Buffer.from('hello trace', 'utf8') },
      { name: 'nuget-config/00-nearest.xml', data: Buffer.from('<config/>', 'utf8') },
    ]);
    expect(zip.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(crc32(Buffer.from('hello trace'))).toBeGreaterThan(0);

    const nameLen = zip.readUInt16LE(26);
    const dataStart = 30 + nameLen;
    const compSize = zip.readUInt32LE(18);
    const inflated = zlib.inflateRawSync(zip.subarray(dataStart, dataStart + compSize));
    expect(inflated.toString('utf8')).toBe('hello trace');
  });
});
