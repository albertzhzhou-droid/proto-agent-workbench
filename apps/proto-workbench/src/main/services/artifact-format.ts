/** Structural checks only. Completion also requires a trusted exporter receipt. */
export interface ArtifactFormat {
  detectedFormat?: "png" | "pdf";
  width?: number;
  height?: number;
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function inspectArtifactFormat(bytes: Buffer): ArtifactFormat {
  if (bytes.subarray(0, 8).equals(pngSignature)) {
    let offset = 8, width = 0, height = 0, hasData = false, chunks = 0;
    while (offset + 12 <= bytes.length && chunks++ < 100_000) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) return {};
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return {};
      if (offset === 8) {
        if (type !== "IHDR" || length !== 13) return {};
        width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
        const depth = bytes[offset + 16], color = bytes[offset + 17];
        const depths: Record<number, number[]> = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
        if (!width || !height || width > 32768 || height > 32768 || width * height > 100_000_000
          || !depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return {};
      } else if (type === "IHDR") return {};
      if (type === "IDAT" && length > 0) hasData = true;
      if (type === "IEND") return length === 0 && hasData && end === bytes.length ? {detectedFormat: "png", width, height} : {};
      offset = end;
    }
    return {};
  }
  if (/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(bytes.subarray(0, 12).toString("ascii"))) {
    const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1");
    const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
    if (match) {
      const offset = Number(match[1]);
      if (Number.isSafeInteger(offset) && offset > 0 && offset < bytes.length) {
        const xref = bytes.subarray(offset, offset + 96).toString("latin1");
        if (/^(?:xref\s|\d+\s+\d+\s+obj\b)/.test(xref)) return {detectedFormat: "pdf"};
      }
    }
  }
  return {};
}
