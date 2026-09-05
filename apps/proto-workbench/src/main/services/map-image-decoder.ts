import { MAX_MAP_EXPORT_BYTES, MAX_MAP_EXPORT_DIMENSION } from "./map-export.ts";

export const MAP_DECODER_CHUNK_BYTES = 256 * 1024;
export const MAP_DECODER_TIMEOUT_MS = 15_000;
const STATE = "__protoMapImageDecoder";
const HTML = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}img{display:block;width:100%;height:100%}</style><img id="map" alt="">`;
// This URL is constant and small; exported image bytes never enter navigation.
export const MAP_DECODER_DOCUMENT_URL = `data:text/html;base64,${Buffer.from(HTML).toString("base64")}`;

export interface MapDecoderSurface {
  loadURL(url: string): Promise<unknown>;
  executeJavaScript(script: string): Promise<any>;
}

export async function decodeSvgForVerification(
  surface: MapDecoderSurface,
  bytes: Buffer,
  expected: { readonly width: number; readonly height: number },
): Promise<{ complete: true; width: number; height: number }> {
  if (bytes.byteLength < 32 || bytes.byteLength > MAX_MAP_EXPORT_BYTES) throw new Error("Map decoder bytes exceed the supported envelope.");
  for (const dimension of [expected.width, expected.height]) {
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > MAX_MAP_EXPORT_DIMENSION) throw new Error("Map decoder dimensions exceed the supported envelope.");
  }
  await surface.loadURL(MAP_DECODER_DOCUMENT_URL);
  const key = JSON.stringify(STATE);
  const ready = await surface.executeJavaScript(`(() => {
    if (globalThis[${key}]) throw new Error("Decoder state already exists.");
    globalThis[${key}] = { bytes: new Uint8Array(${bytes.byteLength}), offset: 0, blobUrl: null };
    return ${bytes.byteLength};
  })()`);
  if (ready !== bytes.byteLength) throw new Error("Map decoder did not accept its bounded byte buffer.");
  for (let offset = 0; offset < bytes.byteLength; offset += MAP_DECODER_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + MAP_DECODER_CHUNK_BYTES);
    const end = offset + chunk.byteLength;
    const received = await surface.executeJavaScript(`(() => {
      const state = globalThis[${key}];
      if (!state || state.offset !== ${offset}) throw new Error("Decoder byte offset changed.");
      const decoded = atob(${JSON.stringify(chunk.toString("base64"))});
      if (decoded.length !== ${chunk.byteLength} || state.offset + decoded.length > state.bytes.length) throw new Error("Decoder chunk length changed.");
      for (let index = 0; index < decoded.length; index++) state.bytes[state.offset + index] = decoded.charCodeAt(index);
      state.offset += decoded.length;
      return state.offset;
    })()`);
    if (received !== end) throw new Error("Map decoder did not acknowledge the exact byte transfer.");
  }
  const decoded = await surface.executeJavaScript(`(async () => {
    const state = globalThis[${key}], image = document.getElementById("map");
    if (!state || !image || state.offset !== ${bytes.byteLength}) throw new Error("Decoder input is incomplete.");
    state.blobUrl = URL.createObjectURL(new Blob([state.bytes], { type: "image/svg+xml" }));
    state.bytes = null;
    image.src = state.blobUrl;
    await image.decode();
    return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight };
  })()`);
  if (decoded?.complete !== true || decoded.width !== expected.width || decoded.height !== expected.height) {
    throw new Error(`Map SVG could not be independently decoded at ${expected.width}x${expected.height}.`);
  }
  return decoded;
}

/** Read the independently decoded image, without relying on a hidden window's compositor. */
export async function rasterizeSvgForVerification(
  surface: MapDecoderSurface,
  bytes: Buffer,
  expected: { readonly width: number; readonly height: number },
): Promise<Buffer> {
  await decodeSvgForVerification(surface, bytes, expected);
  // Bound readback by validated logical pixels plus PNG filtering/encoding overhead.
  const maximumPngBytes = expected.width * expected.height * 4 + 1024 * 1024;
  const key = JSON.stringify(STATE);
  const length = await surface.executeJavaScript(`(async () => {
    const state = globalThis[${key}], image = document.getElementById("map");
    if (!state || !image?.complete) throw new Error("Decoded image is unavailable.");
    const canvas = document.createElement("canvas");
    canvas.width = ${expected.width}; canvas.height = ${expected.height};
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Independent image rasterizer is unavailable.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    const png = await new Promise((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("Independent image rasterization failed.")), "image/png"));
    if (png.type !== "image/png" || png.size < 8 || png.size > ${maximumPngBytes}) throw new Error("Independent raster exceeds its bounded envelope.");
    state.raster = new Uint8Array(await png.arrayBuffer());
    canvas.width = 0; canvas.height = 0;
    return state.raster.length;
  })()`);
  if (!Number.isInteger(length) || length < 8 || length > maximumPngBytes) throw new Error("Independent raster length exceeds its bounded envelope.");
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < length; offset += MAP_DECODER_CHUNK_BYTES) {
    const end = Math.min(length, offset + MAP_DECODER_CHUNK_BYTES);
    const encoded = await surface.executeJavaScript(`(() => {
      const raster = globalThis[${key}]?.raster;
      if (!raster || raster.length !== ${length}) throw new Error("Independent raster changed during readback.");
      let encoded = "";
      for (let index = ${offset}; index < ${end}; index++) encoded += String.fromCharCode(raster[index]);
      return btoa(encoded);
    })()`);
    if (typeof encoded !== "string" || encoded.length !== Math.ceil((end - offset) / 3) * 4) throw new Error("Independent raster chunk length changed.");
    const chunk = Buffer.from(encoded, "base64");
    if (chunk.byteLength !== end - offset || chunk.toString("base64") !== encoded) throw new Error("Independent raster chunk is invalid.");
    chunks.push(chunk);
  }
  await surface.executeJavaScript(`delete globalThis[${key}].raster`);
  const raster = Buffer.concat(chunks, length);
  if (!raster.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("Independent raster is not a PNG image.");
  return raster;
}

export const MAP_DECODER_CLEANUP_SCRIPT = `(() => {
  const state = globalThis[${JSON.stringify(STATE)}];
  if (state?.blobUrl) URL.revokeObjectURL(state.blobUrl);
  delete globalThis[${JSON.stringify(STATE)}];
})()`;

export async function withMapDecoderDeadline<T>(operation: () => Promise<T>, abort: () => void, milliseconds = MAP_DECODER_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try { abort(); } catch { /* The deadline remains authoritative if teardown already completed. */ }
          reject(new Error("Independent map image decoding exceeded its deadline."));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
