import { crc32 } from "node:zlib";
import { localExtensionFiles } from "../../../../../packages/contracts/src/competitor-local-extension.js";

// A small uncompressed ZIP of four UTF-8 files; no filesystem paths or external code.
export function localExtensionZip(origin: string) {
  const chunks: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [filename, source] of Object.entries(
    localExtensionFiles(origin),
  )) {
    const name = Buffer.from(filename),
      data = Buffer.from(source),
      crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(0x21, 12); // 1980-01-01, a valid DOS date for Windows extraction.
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    chunks.push(h, name, data);
    central.push(c, name);
    offset += h.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(4, 8);
  end.writeUInt16LE(4, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
