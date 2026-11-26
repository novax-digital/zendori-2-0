// A minimal ZIP writer: files are stored as they are (no compression — the
// archive holds PDFs, which are compressed already) and the archive is produced
// piece by piece, so a route can stream it without holding it in memory.
//
//   const zip = new ZipWriter();
//   send(zip.file('Rechnung-1.pdf', bytes, date));   // once per file
//   send(zip.end());                                  // once, last
//
// Plain ZIP only (no ZIP64): at most 65,535 files and 4 GB — far beyond what an
// export of invoices needs, and checked.
import { crc32 } from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
/** Version 2.0, the baseline every reader understands. */
const VERSION = 20;
/** General purpose bit 11: the file name is UTF-8. */
const UTF8_NAMES = 0x0800;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

interface ZipEntry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/** The date and time of a file in the format ZIP stores (two seconds exact, UTC). */
function dosDateTime(modified: Date): { time: number; date: number } {
  const year = Math.min(Math.max(modified.getUTCFullYear(), 1980), 2107);
  return {
    time:
      (modified.getUTCHours() << 11) |
      (modified.getUTCMinutes() << 5) |
      (modified.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((modified.getUTCMonth() + 1) << 5) | modified.getUTCDate(),
  };
}

/** A name every unpacker accepts: relative, forward slashes, no way out of the folder. */
function isSafeEntryName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.includes('\\') || name.includes('\0')) {
    return false;
  }
  return name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export class ZipWriter {
  private readonly entries: ZipEntry[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private finished = false;

  /** The bytes of one file in the archive (header and content). */
  file(name: string, data: Uint8Array, modified: Date): Uint8Array {
    if (this.finished) throw new Error('zip: archive already finished');
    if (!isSafeEntryName(name)) throw new Error('zip: unsafe file name');
    if (this.names.has(name)) throw new Error('zip: duplicate file name');
    if (this.entries.length >= MAX_ENTRIES) throw new Error('zip: too many files');

    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const { time, date } = dosDateTime(modified);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(UTF8_NAMES, 6);
    header.writeUInt16LE(0, 8); // method: stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.byteLength, 18); // size in the archive
    header.writeUInt32LE(data.byteLength, 22); // size of the file
    header.writeUInt16LE(nameBytes.byteLength, 26);
    header.writeUInt16LE(0, 28); // no extra field

    const part = Buffer.concat([header, nameBytes, data]);
    if (this.offset + part.byteLength > MAX_BYTES) throw new Error('zip: archive too large');
    this.entries.push({
      name: nameBytes,
      crc,
      size: data.byteLength,
      offset: this.offset,
      time,
      date,
    });
    this.names.add(name);
    this.offset += part.byteLength;
    return part;
  }

  /** The table of contents that closes the archive. Call once, after the last file. */
  end(): Uint8Array {
    if (this.finished) throw new Error('zip: archive already finished');
    this.finished = true;

    const records = this.entries.map((entry) => {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(CENTRAL_HEADER, 0);
      record.writeUInt16LE(VERSION, 4); // made by
      record.writeUInt16LE(VERSION, 6); // needed to read
      record.writeUInt16LE(UTF8_NAMES, 8);
      record.writeUInt16LE(0, 10); // method: stored
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.size, 20);
      record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(entry.name.byteLength, 28);
      // extra field, comment, disk number, internal and external attributes: all 0
      record.writeUInt32LE(entry.offset, 42);
      return Buffer.concat([record, entry.name]);
    });
    const directory = Buffer.concat(records);
    if (this.offset + directory.byteLength > MAX_BYTES) throw new Error('zip: archive too large');

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_RECORD, 0);
    end.writeUInt16LE(this.entries.length, 8); // files on this disk
    end.writeUInt16LE(this.entries.length, 10); // files in total
    end.writeUInt32LE(directory.byteLength, 12);
    end.writeUInt32LE(this.offset, 16); // where the table of contents starts
    return Buffer.concat([directory, end]);
  }
}
