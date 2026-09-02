import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type {
  MapExportMetadata,
  MapExportRequest,
  MapExportVerificationReceipt,
} from "../../shared/contracts.ts";

export const MAX_MAP_EXPORT_BYTES = 16 * 1024 * 1024;
export const MAX_MAP_EXPORT_DIMENSION = 4_096;

export function validatedMapCaptureScale(
  captured: { readonly width: number; readonly height: number },
  expected: { readonly width: number; readonly height: number },
): number {
  if (captured.width === expected.width && captured.height === expected.height) return 1;
  const scaleX = captured.width / expected.width;
  const scaleY = captured.height / expected.height;
  if (
    !Number.isFinite(scaleX)
    || !Number.isFinite(scaleY)
    || scaleX < 1
    || scaleY < 1
    || scaleX > 4
    || scaleY > 4
    || Math.abs(scaleX - scaleY) > 0.01
  ) {
    throw new Error(`Map export decoder reported ${captured.width}x${captured.height}; expected ${expected.width}x${expected.height} logical pixels.`);
  }
  return (scaleX + scaleY) / 2;
}

export interface DecodedMapEvidence {
  readonly decoder: "electron-native-image" | "chromium-isolated-image";
  readonly width: number;
  readonly height: number;
  readonly pixelSha256: string;
  readonly sampledColorCount: number;
}

export type MapImageVerifier = (
  format: MapExportRequest["format"],
  bytes: Buffer,
  expected: { readonly width: number; readonly height: number },
) => Promise<DecodedMapEvidence>;

interface ExportOptions {
  readonly now?: () => Date;
  readonly id?: () => string;
}

export async function exportVerifiedMap(
  workspaceRoot: string,
  request: MapExportRequest,
  verifyImage: MapImageVerifier,
  options: ExportOptions = {},
): Promise<MapExportVerificationReceipt> {
  const bytes = validateMapExportRequest(request);
  const canonicalRoot = await canonicalDirectory(workspaceRoot, workspaceRoot);
  await revalidateSourceArtifact(canonicalRoot, request.metadata);
  const outputDirectory = join(canonicalRoot, "build", "visualization-exports");
  await canonicalDirectory(outputDirectory, canonicalRoot, true);

  const timestamp = (options.now?.() ?? new Date()).toISOString().replace(/[-:.]/g, "");
  const uniqueId = (options.id?.() ?? randomUUID()).replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  const requestedStem = basename(request.filename, `.${request.format}`).slice(0, 120);
  const exportStem = `${requestedStem}-${timestamp}-${uniqueId}`;
  const imageFilename = `${exportStem}.${request.format}`;
  const metadataFilename = `${exportStem}.metadata.json`;
  const verificationFilename = `${exportStem}.verification.json`;
  const imagePath = join(outputDirectory, imageFilename);
  const metadataPath = join(outputDirectory, metadataFilename);
  const verificationPath = join(outputDirectory, verificationFilename);
  const operationId = randomUUID();
  const imageTemporaryPath = join(outputDirectory, `.${exportStem}.${operationId}.image.tmp`);
  const metadataTemporaryPath = join(outputDirectory, `.${exportStem}.${operationId}.metadata.tmp`);
  const verificationTemporaryPath = join(outputDirectory, `.${exportStem}.${operationId}.verification.tmp`);
  const temporaryPaths = [imageTemporaryPath, metadataTemporaryPath, verificationTemporaryPath];
  const publishedPaths: string[] = [];

  try {
    await writeFile(imageTemporaryPath, bytes, { flag: "wx" });
    const reopenedBytes = await readFile(imageTemporaryPath);
    if (!reopenedBytes.equals(bytes)) throw new Error("Map export bytes changed during the independent reopen check.");

    const sha256 = digest(reopenedBytes);
    const evidence = await verifyImage(request.format, reopenedBytes, { width: request.width, height: request.height });
    if (evidence.width !== request.width || evidence.height !== request.height) {
      throw new Error(`Map export reopened at ${evidence.width}x${evidence.height}; expected ${request.width}x${request.height}.`);
    }
    if (evidence.sampledColorCount < 2) throw new Error("Map export reopened as a visually empty image.");

    const metadataPayload = `${JSON.stringify(request.metadata, null, 2)}\n`;
    const metadataBytes = Buffer.from(metadataPayload, "utf8");
    const metadataSha256 = digest(metadataBytes);
    await writeFile(metadataTemporaryPath, metadataBytes, { flag: "wx" });

    const relativePath = workspaceRelative(canonicalRoot, imagePath);
    const metadataRelativePath = workspaceRelative(canonicalRoot, metadataPath);
    const verificationRelativePath = workspaceRelative(canonicalRoot, verificationPath);
    const verifiedAt = (options.now?.() ?? new Date()).toISOString();
    const receipt: MapExportVerificationReceipt = {
      schema: "proto-workbench.map-export-verification.v1",
      status: "passed",
      format: request.format,
      filename: imageFilename,
      relativePath,
      metadataRelativePath,
      verificationRelativePath,
      sha256,
      metadataSha256,
      bytes: reopenedBytes.byteLength,
      width: evidence.width,
      height: evidence.height,
      exportedAt: request.metadata.exportedAt,
      verifiedAt,
      decoder: evidence.decoder,
      pixelSha256: evidence.pixelSha256,
      sampledColorCount: evidence.sampledColorCount,
      externalResourcesBlocked: true,
      renderedMapLayers: request.metadata.renderedMapLayers,
      reviewStatus: "human_review_required",
    };
    const verificationBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await writeFile(verificationTemporaryPath, verificationBytes, { flag: "wx" });

    for (const [temporaryPath, finalPath] of [
      [imageTemporaryPath, imagePath],
      [metadataTemporaryPath, metadataPath],
      [verificationTemporaryPath, verificationPath],
    ] as const) {
      await copyFile(temporaryPath, finalPath, constants.COPYFILE_EXCL);
      publishedPaths.push(finalPath);
    }

    const finalImage = await readFile(imagePath);
    const finalMetadata = await readFile(metadataPath);
    const finalVerification = await readFile(verificationPath);
    if (
      digest(finalImage) !== sha256
      || digest(finalMetadata) !== metadataSha256
      || !finalVerification.equals(verificationBytes)
    ) {
      throw new Error("Published map export failed its final digest reopen check.");
    }
    await revalidateSourceArtifact(canonicalRoot, request.metadata);
    return receipt;
  } catch (error) {
    await Promise.allSettled(publishedPaths.map((path) => rm(path, { force: true })));
    throw error;
  } finally {
    await Promise.allSettled(temporaryPaths.map((path) => rm(path, { force: true })));
  }
}

export function validateMapExportRequest(request: MapExportRequest): Buffer {
  if (!request || typeof request !== "object") throw new Error("Map export request is missing.");
  if (request.format !== "svg" && request.format !== "png") throw new Error("Map export format is unsupported.");
  if (!new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\\.${request.format}$`).test(request.filename)) {
    throw new Error("Map export filename is invalid.");
  }
  if (!(request.bytes instanceof Uint8Array)) throw new Error("Map export payload must be binary data.");
  if (request.bytes.byteLength < 32 || request.bytes.byteLength > MAX_MAP_EXPORT_BYTES) {
    throw new Error("Map export payload is outside the supported size envelope.");
  }
  if (!validDimension(request.width) || !validDimension(request.height)) {
    throw new Error("Map export dimensions are outside the supported range.");
  }
  validateMetadata(request.metadata, request.format);

  const bytes = Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength);
  if (request.format === "png") validatePng(bytes, request.width, request.height);
  else validateSvg(bytes, request.width, request.height, request.metadata);
  return Buffer.from(bytes);
}

function validatePng(bytes: Buffer, expectedWidth: number, expectedHeight: number): void {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.byteLength < 33 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Map PNG export has an invalid signature or IHDR block.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(`Map PNG declares ${width}x${height}; expected ${expectedWidth}x${expectedHeight}.`);
  }
}

function validateSvg(bytes: Buffer, expectedWidth: number, expectedHeight: number, metadata: MapExportMetadata): void {
  let svg: string;
  try {
    svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Map SVG export is not valid UTF-8.");
  }
  const root = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!root) throw new Error("Map SVG export has no SVG root element.");
  const width = svgDimension(root, "width");
  const height = svgDimension(root, "height");
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(`Map SVG declares ${width ?? "unknown"}x${height ?? "unknown"}; expected ${expectedWidth}x${expectedHeight}.`);
  }
  if (/<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|<iframe\b|<object\b|<embed\b|<audio\b|<video\b/i.test(svg)) {
    throw new Error("Map SVG contains an executable or externally loadable element.");
  }
  if (/\son[a-z][\w:.-]*\s*=/i.test(svg) || /@import\b/i.test(svg)) {
    throw new Error("Map SVG contains an executable event or stylesheet import.");
  }
  for (const match of svg.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi)) {
    if (!match[2].startsWith("#")) throw new Error("Map SVG contains a non-fragment resource reference.");
  }
  for (const match of svg.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    if (!match[2].startsWith("#")) throw new Error("Map SVG contains a non-fragment CSS resource reference.");
  }
  const embedded = svg.match(/<metadata\b[^>]*\bid=["']proto-workbench-map-export["'][^>]*>([\s\S]*?)<\/metadata>/i)?.[1];
  if (!embedded) throw new Error("Map SVG is missing embedded review metadata.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unescapeXmlText(embedded));
  } catch {
    throw new Error("Map SVG contains invalid embedded review metadata.");
  }
  if (JSON.stringify(parsed) !== JSON.stringify(metadata)) {
    throw new Error("Map SVG embedded metadata does not match the export request.");
  }
}

function validateMetadata(metadata: MapExportMetadata, format: MapExportRequest["format"]): void {
  if (!metadata || metadata.schema !== "proto-workbench.map-export.v1" || metadata.format !== format) {
    throw new Error("Map export metadata does not match the requested format.");
  }
  if (metadata.reviewStatus !== "human_review_required" || metadata.renderer?.name !== "CGView.js") {
    throw new Error("Map export metadata is missing its renderer or review boundary.");
  }
  if (typeof metadata.renderedMapLayers?.primerBindings !== "boolean") {
    throw new Error("Map export metadata is missing the primer-binding display state.");
  }
  if (
    typeof metadata.artifactPath !== "string"
    || !metadata.artifactPath.trim()
    || !/^[a-f0-9]{64}$/.test(metadata.artifactSha256)
    || !Number.isSafeInteger(metadata.artifactSizeBytes)
    || metadata.artifactSizeBytes < 1
    || metadata.artifactSizeBytes > 16 * 1024 * 1024
  ) {
    throw new Error("Map export metadata is missing its bounded source-artifact binding.");
  }
  if (metadata.digestStatus === "mismatch") {
    throw new Error("Map export is blocked for an artifact with a mismatched provenance digest.");
  }
  if (
    metadata.governance?.status !== "verified"
    || metadata.governance.unverifiedPartCount !== 0
    || !Array.isArray(metadata.governance.gaps)
    || metadata.governance.gaps.length !== 0
  ) {
    throw new Error("Map export is blocked until every rendered DNA part has complete governance metadata.");
  }
  const serialized = JSON.stringify(metadata);
  if (serialized.length > 64 * 1024) throw new Error("Map export metadata exceeds the supported size envelope.");
}

async function revalidateSourceArtifact(workspaceRoot: string, metadata: MapExportMetadata): Promise<void> {
  const normalized = metadata.artifactPath.replaceAll("\\", "/");
  if (
    !normalized.toLocaleLowerCase().startsWith("build/")
    || normalized.includes("\0")
    || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    || !normalized.toLocaleLowerCase().endsWith(".json")
  ) {
    throw new Error("Map export source artifact must be a canonical JSON file under build/.");
  }
  const requested = resolve(workspaceRoot, normalized);
  const relativePath = relative(workspaceRoot, requested);
  if (!relativePath || relativePath.startsWith("..") || resolve(workspaceRoot, relativePath) !== requested) {
    throw new Error("Map export source artifact escaped the active workspace.");
  }
  const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Map export source artifact must be a canonical regular file.");
  const canonical = await realpath(requested);
  if (!samePath(requested, canonical)) throw new Error("Map export source artifact cannot traverse a linked path.");
  const sourceBytes = await readFile(canonical);
  if (sourceBytes.byteLength !== metadata.artifactSizeBytes || digest(sourceBytes) !== metadata.artifactSha256) {
    throw new Error("Map export source artifact changed after visualization; refresh the artifact inventory and retry.");
  }
}

function validDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 64 && value <= MAX_MAP_EXPORT_DIMENSION;
}

function svgDimension(root: string, name: "width" | "height"): number | undefined {
  const match = root.match(new RegExp(`\\b${name}\\s*=\\s*["']([0-9]+(?:\\.[0-9]+)?)(?:px)?["']`, "i"));
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function unescapeXmlText(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function canonicalDirectory(path: string, workspaceRoot: string, create = false): Promise<string> {
  const requested = resolve(path);
  if (create) await mkdir(requested, { recursive: true });
  const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Map export requires a canonical directory.");
  const canonical = await realpath(requested);
  if (!samePath(requested, canonical)) throw new Error("Map export cannot traverse a linked directory.");
  const root = resolve(workspaceRoot);
  const relativePath = relative(root, canonical);
  if (relativePath.startsWith("..") || resolve(root, relativePath) !== resolve(canonical)) {
    throw new Error("Map export directory is outside the active workspace.");
  }
  return canonical;
}

function workspaceRelative(workspaceRoot: string, path: string): string {
  const value = relative(workspaceRoot, path).replaceAll("\\", "/");
  if (!value || value.startsWith("..")) throw new Error("Map export path escaped the active workspace.");
  return value;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase()
    : resolve(left) === resolve(right);
}
