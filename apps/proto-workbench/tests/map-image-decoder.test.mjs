import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import sharp from "sharp";
import {
  decodeSvgForVerification,
  rasterizeSvgForVerification,
  MAP_DECODER_CHUNK_BYTES,
  MAP_DECODER_CLEANUP_SCRIPT,
  MAP_DECODER_DOCUMENT_URL,
  withMapDecoderDeadline,
} from "../src/main/services/map-image-decoder.ts";
import { MAX_MAP_EXPORT_BYTES } from "../src/main/services/map-export.ts";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const svg = metadata => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><metadata>${metadata}</metadata><rect width="320" height="240" fill="#fff"/><path d="M10 10L310 230" stroke="#e11d48" stroke-width="12"/></svg>`);

// Execute the actual transport scripts in a separate realm and decode the
// received Blob bytes with libvips/librsvg. Native Chromium is a separate QA gate.
function decoderSurface() {
  const blobs = new Map();
  const observations = { urls: [], scripts: [], decodedDigest: null, decodedPixelBytes: 0, rasterized: false };
  const image = {
    src: "", complete: false, naturalWidth: 0, naturalHeight: 0,
    async decode() {
      const blob = blobs.get(this.src);
      assert.ok(blob, "image must reference the privately created Blob");
      assert.equal(blob.type, "image/svg+xml");
      const bytes = Buffer.from(await blob.arrayBuffer());
      observations.decodedDigest = digest(bytes);
      const result = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
      this.naturalWidth = result.info.width;
      this.naturalHeight = result.info.height;
      this.complete = true;
      observations.decodedPixelBytes = result.data.byteLength;
    },
  };
  const context = createContext({
    Blob, atob, btoa,
    URL: {
      createObjectURL(blob) { const url = `blob:private-decoder/${blobs.size}`; blobs.set(url, blob); return url; },
      revokeObjectURL(url) { blobs.delete(url); },
    },
    document: {
      getElementById(id) { return id === "map" ? image : null; },
      createElement(name) {
        assert.equal(name, "canvas");
        let drawn = false;
        return {
          width: 0, height: 0,
          getContext(kind, options) {
            assert.equal(kind, "2d"); assert.equal(options.alpha, false);
            return {
              fillStyle: "", fillRect() {},
              drawImage(source, x, y) { assert.equal(source, image); assert.equal(image.complete, true); assert.equal(x, 0); assert.equal(y, 0); drawn = true; },
            };
          },
          async toBlob(callback, type) {
            assert.equal(drawn, true); assert.equal(type, "image/png");
            const source = Buffer.from(await blobs.get(image.src).arrayBuffer());
            const png = await sharp(source).resize(this.width, this.height).flatten({ background: "#fff" }).png().toBuffer();
            observations.rasterized = true;
            callback(new Blob([png], { type }));
          },
        };
      },
    },
  });
  return {
    blobs, observations, context,
    async loadURL(url) { observations.urls.push(url); },
    async executeJavaScript(script) { observations.scripts.push(script); return await runInContext(script, context, { timeout: 2_000 }); },
  };
}

test("4 MiB SVG transports exact bytes in bounded chunks and independently decodes pixels without a large navigation URL", async () => {
  const bytes = svg("software transport fixture. ".repeat(160_000));
  assert.ok(bytes.length > 4 * 1024 * 1024);
  const surface = decoderSurface();
  const result = await decodeSvgForVerification(surface, bytes, { width: 320, height: 240 });
  assert.equal(result.complete, true);
  assert.equal(result.width, 320);
  assert.equal(result.height, 240);
  assert.equal(surface.observations.decodedDigest, digest(bytes));
  assert.ok(surface.observations.decodedPixelBytes >= 320 * 240 * 3);
  assert.deepEqual(surface.observations.urls, [MAP_DECODER_DOCUMENT_URL]);
  assert.ok(MAP_DECODER_DOCUMENT_URL.length < 2_048);
  assert.ok(Math.max(...surface.observations.scripts.map(script => script.length)) < Math.ceil(MAP_DECODER_CHUNK_BYTES / 3) * 4 + 2_048);
  assert.equal(surface.blobs.size, 1);
  await surface.executeJavaScript(MAP_DECODER_CLEANUP_SCRIPT);
  assert.equal(surface.blobs.size, 0);
  assert.equal(surface.context.__protoMapImageDecoder, undefined);
});

test("independent raster reads decoded pixels at exact logical dimensions without compositor frames", async () => {
  const surface = decoderSurface();
  const png = await rasterizeSvgForVerification(surface, svg("canvas software fixture"), { width: 320, height: 240 });
  const pixels = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(pixels.info.width, 320); assert.equal(pixels.info.height, 240);
  assert.equal(surface.observations.rasterized, true);
  assert.equal(surface.context.__protoMapImageDecoder.raster, undefined);
  const colors = new Set();
  for (let index = 0; index < pixels.data.length; index += pixels.info.channels) colors.add(pixels.data.subarray(index, index + pixels.info.channels).toString("hex"));
  assert.ok(colors.size > 2);
});

test("dense software SVG preserves a PNG readback spanning multiple bounded chunks", async () => {
  let seed = 0x12345678;
  const rectangles = [];
  for (let row = 0; row < 384; row++) {
    for (let column = 0; column < 384; column++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const color = (seed >>> 8).toString(16).padStart(6, "0");
      rectangles.push(`<rect x="${column * 3}" y="${row * 3}" width="3" height="3" fill="#${color}"/>`);
    }
  }
  const bytes = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1152" height="1152">${rectangles.join("")}</svg>`);
  const surface = decoderSurface();
  const png = await rasterizeSvgForVerification(surface, bytes, { width: 1152, height: 1152 });
  assert.ok(png.length > MAP_DECODER_CHUNK_BYTES, "fixture must exercise more than one raster readback chunk");
  assert.equal(surface.observations.decodedDigest, digest(bytes));
  const reference = await sharp(bytes).flatten({ background: "#fff" }).png().toBuffer();
  assert.equal(digest(png), digest(reference));
  assert.equal(surface.observations.scripts.filter(script => script.includes("return btoa(encoded)")).length, Math.ceil(png.length / MAP_DECODER_CHUNK_BYTES));
});

test("independent raster rejects excess length and corrupted readback instead of crediting pixels", async () => {
  for (const mode of ["oversize", "corrupt"]) {
    const surface = decoderSurface();
    const execute = surface.executeJavaScript.bind(surface);
    surface.executeJavaScript = async script => {
      const value = await execute(script);
      if (mode === "oversize" && script.includes("return state.raster.length")) return 320 * 240 * 4 + 1024 * 1024 + 1;
      if (mode === "corrupt" && script.includes("return btoa(encoded)")) return "";
      return value;
    };
    await assert.rejects(rasterizeSvgForVerification(surface, svg("bounded readback"), { width: 320, height: 240 }), /raster (length|chunk length)/);
  }
});

test("decoder document only permits Blob images and carries no executable or network content", () => {
  const html = Buffer.from(MAP_DECODER_DOCUMENT_URL.split(",")[1], "base64").toString();
  assert.match(html, /default-src 'none'; img-src blob:/);
  assert.match(html, /base-uri 'none'; form-action 'none'/);
  assert.doesNotMatch(html, /<script|https?:|file:|data:image/i);
});

test("decoder rejects unsupported bytes and dimensions before creating its surface", async () => {
  const surface = decoderSurface();
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_MAP_EXPORT_BYTES + 1)]) {
    await assert.rejects(decodeSvgForVerification(surface, bytes, { width: 320, height: 240 }), /bytes exceed/);
  }
  for (const width of [0, 0.5, 4_097, NaN]) {
    await assert.rejects(decodeSvgForVerification(surface, svg("bounded"), { width, height: 240 }), /dimensions exceed/);
  }
  assert.equal(surface.observations.urls.length, 0);
});

test("partial transport acknowledgement fails before an image is decoded", async () => {
  const surface = decoderSurface();
  const execute = surface.executeJavaScript.bind(surface);
  surface.executeJavaScript = async script => {
    const result = await execute(script);
    return script.includes("const decoded = atob(") ? result - 1 : result;
  };
  await assert.rejects(decodeSvgForVerification(surface, svg("bounded"), { width: 320, height: 240 }), /exact byte transfer/);
  assert.equal(surface.observations.decodedDigest, null);
  assert.equal(surface.blobs.size, 0);
});

test("invalid SVG bytes and independently decoded dimension mismatch both fail closed", async () => {
  await assert.rejects(decodeSvgForVerification(decoderSurface(), Buffer.from("invalid svg".repeat(100)), { width: 320, height: 240 }));
  await assert.rejects(decodeSvgForVerification(decoderSurface(), svg("bounded"), { width: 321, height: 240 }), /independently decoded at 321x240/);
});

test("deadline aborts once and handles teardown errors and a late decoder rejection", async () => {
  let rejectOperation;
  let aborts = 0;
  const operation = new Promise((_resolve, reject) => { rejectOperation = reject; });
  await assert.rejects(withMapDecoderDeadline(() => operation, () => { aborts += 1; throw new Error("already destroyed"); }, 10), /exceeded its deadline/);
  assert.equal(aborts, 1);
  rejectOperation(new Error("decoder destroyed"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await withMapDecoderDeadline(async () => "decoded", () => { aborts += 1; }, 10), "decoded");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(aborts, 1);
});
