import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ProteinStructureAttachment, ProteinStructureCandidate, ProteinStructureData, ProteinStructureImageRequest,
  ProteinStructureTarget, ProteinStructureSavedView, ProteinStructureViewState, StructureProvider } from "../../shared/protein-structures.ts";
import { PROTEIN_STRUCTURE_LIMITS as LIMITS } from "../../shared/protein-structures.ts";
import { validateProteinViewState } from "../../shared/protein-view-state.ts";
import { parseDesignIr } from "../../renderer/design-visualization.ts";
import type { ProteinViewModel } from "../../renderer/design-visualization.ts";
import { mapProteinStructure } from "../../renderer/protein-structure-mapping.ts";
import { proteinLandscapeRows, renderProteinLandscapeSvg } from "../../shared/protein-landscape.ts";
import type { PreparedProteinTracks, ProteinTrackExportReceipt, ProteinTrackExportRequest, ProteinTrackMetadata, ProteinTrackRequest } from "../../shared/protein-track-export.ts";
import type { MapImageVerifier } from "./map-export.ts";

export interface ProteinStructureServiceOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  now?: () => Date;
  verifyPng?: (bytes: Buffer, expected: { width: number; height: number }) => Promise<void>;
  verifyTracksImage?: MapImageVerifier;
}

/** Main-process-only I/O. No user-supplied URL is accepted by a network method. */
export class ProteinStructureService {
  private readonly workspaceRoot: string;
  private readonly options: ProteinStructureServiceOptions;
  constructor(workspaceRoot: string, options: ProteinStructureServiceOptions = {}) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.options = options;
  }

  async list(target: ProteinStructureTarget): Promise<ProteinStructureAttachment[]> {
    await this.verifyTarget(target);
    let directory: string;
    try { directory = await this.directory(target.sequenceSha256, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const files = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
    if (files.length > LIMITS.maxAttachments) throw new Error("Structure attachment inventory exceeds the supported bound.");
    const attachments: ProteinStructureAttachment[] = [];
    for (const filename of files) {
      const metadata = JSON.parse((await readRegularFile(join(directory, filename), 32_768, directory)).toString("utf8"));
      if (metadata?.proteinId !== target.proteinId) continue;
      const item = await this.read({ target, attachmentId: filename.slice(0, -5) });
      if (item.attachment.proteinId === target.proteinId) attachments.push(item.attachment);
    }
    return attachments;
  }

  async search(input: { provider: StructureProvider; query: string }): Promise<ProteinStructureCandidate[]> {
    if (!input || !["pdb", "alphafold"].includes(input.provider) || typeof input.query !== "string") throw new Error("Invalid structure search.");
    const query = input.query.trim();
    if (!query || query.length > 160 || /[\x00-\x1f]/.test(query)) throw new Error("Enter a bounded PDB query or UniProt accession.");
    if (input.provider === "alphafold") {
      const accession = validateAccession("alphafold", query);
      const entries = await this.alphaFoldEntries(accession);
      return entries.slice(0, 1).map((entry) => ({ provider: "alphafold", accession,
        title: boundedText(entry.proteinDescription, 200) || `AlphaFold prediction for ${accession}`,
        sourceUrl: `https://alphafold.ebi.ac.uk/entry/${accession}` }));
    }
    if (/^[0-9][A-Za-z0-9]{3}$/.test(query)) {
      const accession = validateAccession("pdb", query);
      const entry = await this.json(`https://data.rcsb.org/rest/v1/core/entry/${accession}`);
      return [{ provider: "pdb", accession, title: boundedText((entry as Record<string, Record<string, unknown>>).struct?.title, 200) || accession,
        sourceUrl: `https://www.rcsb.org/structure/${accession}` }];
    }
    const payload = await this.json("https://search.rcsb.org/rcsbsearch/v2/query", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: { type: "terminal", service: "full_text", parameters: { value: query } },
        return_type: "entry", request_options: { paginate: { start: 0, rows: LIMITS.maxSearchResults } } }),
    });
    const rows = (payload as { result_set?: unknown[] }).result_set;
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, LIMITS.maxSearchResults).flatMap((row) => {
      const id = (row as { identifier?: unknown })?.identifier;
      if (typeof id !== "string" || !/^[0-9][A-Z0-9]{3}$/.test(id)) return [];
      return [{ provider: "pdb" as const, accession: id, title: `PDB ${id}`, sourceUrl: `https://www.rcsb.org/structure/${id}` }];
    });
  }

  async fetch(input: { target: ProteinStructureTarget; provider: StructureProvider; accession: string }): Promise<ProteinStructureData> {
    await this.verifyTarget(input.target);
    const accession = validateAccession(input.provider, input.accession);
    let url = `https://files.rcsb.org/download/${accession}.cif`;
    if (input.provider === "alphafold") {
      const entries = await this.alphaFoldEntries(accession);
      if (entries.length !== 1) throw new Error("No unique canonical AlphaFold entry was found for this accession.");
      url = validateAlphaFoldDownload(entries[0].cifUrl, accession);
    }
    const bytes = await this.request(url, LIMITS.maxBytes);
    await this.verifyTarget(input.target);
    return this.store(input.target, bytes, "mmcif", `${input.provider === "pdb" ? "PDB" : "AlphaFold"} ${accession}`, {
      provider: input.provider, accession, url, retrievedAt: this.now(),
      classification: input.provider === "pdb" ? "experimental" : "predicted",
      license: input.provider === "pdb" ? "CC0-1.0" : "CC-BY-4.0",
      attribution: input.provider === "pdb" ? "wwPDB / RCSB PDB; original depositors" : "AlphaFold DB, Google DeepMind and EMBL-EBI",
    });
  }

  /** Call only with the exact path returned by Electron's native file dialog. */
  async importLocal(target: ProteinStructureTarget, selectedPath: string): Promise<ProteinStructureData> {
    await this.verifyTarget(target);
    const extension = extname(selectedPath).toLowerCase();
    if (![".cif", ".mmcif", ".pdb", ".ent"].includes(extension)) throw new Error("Choose a local mmCIF or PDB coordinate file.");
    const bytes = await readRegularFile(selectedPath, LIMITS.maxBytes);
    await this.verifyTarget(target);
    return this.store(target, bytes, extension === ".pdb" || extension === ".ent" ? "pdb" : "mmcif", basename(selectedPath), {
      provider: "local", accession: basename(selectedPath), url: null, retrievedAt: this.now(), classification: "unknown",
      license: "NOASSERTION", attribution: "User-supplied coordinate file; source and rights require review",
    });
  }

  /** Harness imports are root-contained and bound to an independently read digest. */
  async importWorkspace(target: ProteinStructureTarget, inputPath: string, expectedSha256: string): Promise<ProteinStructureData> {
    await this.verifyTarget(target);
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("A current workspace coordinate digest is required.");
    const root = await realpath(this.workspaceRoot), path = resolve(root, inputPath);
    assertContained(root, path);
    const extension = extname(path).toLowerCase();
    if (![".cif", ".mmcif", ".pdb", ".ent"].includes(extension)) throw new Error("Choose a workspace mmCIF or PDB coordinate file.");
    const bytes = await readRegularFile(path, LIMITS.maxBytes, root);
    if (digest(bytes) !== expectedSha256) throw new Error("Workspace coordinates changed after the model's bound read.");
    await this.verifyTarget(target);
    return this.store(target, bytes, extension === ".pdb" || extension === ".ent" ? "pdb" : "mmcif", basename(path), {
      provider: "local", accession: basename(path), url: null, retrievedAt: this.now(), classification: "unknown",
      license: "NOASSERTION", attribution: "Workspace coordinate file; source and rights require review",
    });
  }

  async read(input: { target: ProteinStructureTarget; attachmentId: string }): Promise<ProteinStructureData> {
    await this.verifyTarget(input.target);
    if (!/^[a-f0-9]{64}$/.test(input.attachmentId)) throw new Error("Invalid structure attachment ID.");
    const directory = await this.directory(input.target.sequenceSha256, false);
    const attachment: ProteinStructureAttachment = JSON.parse((await readRegularFile(join(directory, `${input.attachmentId}.json`), 32_768, directory)).toString("utf8"));
    validateAttachment(attachment, input.target, input.attachmentId);
    const bytes = await readRegularFile(join(directory, `${input.attachmentId}.${attachment.format === "pdb" ? "pdb" : "cif"}`), LIMITS.maxBytes, directory);
    if (bytes.length !== attachment.bytes || digest(bytes) !== attachment.contentSha256) throw new Error("Structure attachment content digest mismatch.");
    const text = validateStructureText(bytes, attachment.format);
    return { attachment, text };
  }

  async exportImage(input: ProteinStructureImageRequest): Promise<{ relativePath: string; metadataRelativePath: string }> {
    const data = await this.read({ target: input.target, attachmentId: input.attachmentId });
    const png = Buffer.from(input.png);
    if (png.length < 24 || png.length > 16 * 1024 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1
      || input.width > 4096 || input.height > 4096 || png.readUInt32BE(16) !== input.width || png.readUInt32BE(20) !== input.height) {
      throw new Error("Invalid or oversized structure PNG capture.");
    }
    if (!this.options.verifyPng) throw new Error("Independent desktop PNG verification is unavailable.");
    if (!input.view || !["cartoon", "ball-and-stick", "molecular-surface"].includes(input.view.representation)
      || !["chain", "residue", "confidence"].includes(input.view.color) || JSON.stringify(input.view).length > 16_384
      || typeof input.view.chainId !== "string" || input.view.chainId.length > 256
      || !["exact", "explicit-partial", "unmapped"].includes(input.view.mappingStatus)
      || (input.view.color === "confidence" && data.attachment.source.provider !== "alphafold")) throw new Error("Invalid structure view metadata.");
    const range = input.view.selectedRange;
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > 1_000_000)) throw new Error("Invalid structure selection range.");
    await this.options.verifyPng(png, { width: input.width, height: input.height });
    await this.verifyTarget(input.target);
    const directory = await this.directory("exports");
    const stem = `protein-structure-${randomUUID()}`;
    const imagePath = join(directory, `${stem}.png`);
    const metadataPath = join(directory, `${stem}.json`);
    const metadata = { schema: "proto-workbench.protein-figure.v1", artifactSha256: input.target.artifactSha256,
      proteinId: input.target.proteinId, sequenceSha256: input.target.sequenceSha256, structure: data.attachment,
      width: input.width, height: input.height, view: input.view, pngSha256: digest(png), exportedAt: this.now(),
      coordinates: "protein positions: 0-based half-open; deposited structure identifiers retained", reviewStatus: "human_review_required" };
    await writeFile(imagePath, png, { flag: "wx" });
    const reopened = await readRegularFile(imagePath, 16 * 1024 * 1024, directory);
    if (digest(reopened) !== digest(png)) throw new Error("Export changed during independent reopen.");
    await this.verifyTarget(input.target);
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
    return { relativePath: relative(this.workspaceRoot, imagePath), metadataRelativePath: relative(this.workspaceRoot, metadataPath) };
  }

  async prepareTracks(input: ProteinTrackRequest): Promise<PreparedProteinTracks> {
    const protein = await this.readTargetProtein(input.target);
    const range = input.selectedRange;
    if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > protein.length)) throw new Error("Invalid landscape selection range.");
    let structure: ProteinTrackMetadata["structure"] = null;
    let mapping: ReturnType<typeof mapProteinStructure> | undefined;
    if (input.structure) {
      const context = input.structure;
      if (!Number.isSafeInteger(context.modelIndex) || context.modelIndex < 0 || context.modelIndex > 63 || typeof context.chainId !== "string" || context.chainId.length > 128
        || (context.explicitStartOneBased !== null && (!Number.isSafeInteger(context.explicitStartOneBased) || context.explicitStartOneBased < 1 || context.explicitStartOneBased > protein.length))) throw new Error("Invalid landscape structure mapping context.");
      const data = await this.read({ target: input.target, attachmentId: context.attachmentId });
      const { readProteinCoordinateChains } = await import("./protein-coordinate-mapping.ts");
      const chains = await readProteinCoordinateChains(data, context.modelIndex);
      const chain = chains.find((item) => item.id === context.chainId);
      if (context.chainId && !chain) throw new Error("The selected chain is absent from the bound coordinate file.");
      mapping = chain ? mapProteinStructure(protein.sequence, chain, context.explicitStartOneBased ?? undefined) : undefined;
      structure = { attachment: data.attachment, context, mappingStatus: mapping?.status ?? "unmapped", mappingReason: mapping?.reason ?? "Choose one deposited chain before linking residues.", observedResidues: mapping?.positions.length ?? 0 };
    }
    const metadata: ProteinTrackMetadata = { schema: "proto-workbench.protein-landscape.v1", artifactSha256: input.target.artifactSha256,
      proteinId: protein.id, proteinName: protein.name ?? protein.id, sequenceSha256: protein.sequenceSha256, length: protein.length, selectedRange: range ?? null,
      coordinates: "0-based half-open metadata; 1-based inclusive figure labels", algorithm: "proto.protein-landscape.v1",
      ...proteinLandscapeRows(protein.sequence, mapping), structure, reviewStatus: "human_review_required" };
    const figure = renderProteinLandscapeSvg(metadata);
    await this.verifyTarget(input.target);
    return { ...figure, svgSha256: digest(Buffer.from(figure.svg)), metadata };
  }

  async exportTracks(input: ProteinTrackExportRequest): Promise<ProteinTrackExportReceipt> {
    if (!input || !["svg", "png"].includes(input.format) || !/^[a-f0-9]{64}$/.test(input.svgSha256)) throw new Error("Invalid sequence landscape export request.");
    if (!this.options.verifyTracksImage) throw new Error("Independent landscape image verification is unavailable.");
    const prepared = await this.prepareTracks(input.request);
    if (prepared.svgSha256 !== input.svgSha256) throw new Error("Sequence landscape inputs changed after preparation.");
    const bytes = input.format === "svg" ? Buffer.from(prepared.svg) : Buffer.from(input.png ?? []);
    if (!bytes.length || bytes.length > 16 * 1024 * 1024 || (input.format === "png" && (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes.length < 24 || bytes.readUInt32BE(16) !== prepared.width || bytes.readUInt32BE(20) !== prepared.height))) throw new Error("Invalid landscape image bytes or dimensions.");
    const directory = await this.directory("exports");
    const stem = `protein-landscape-${randomUUID()}`;
    const imagePath = join(directory, `${stem}.${input.format}`), metadataPath = join(directory, `${stem}.metadata.json`), verificationPath = join(directory, `${stem}.verification.json`);
    const created: string[] = [];
    try {
      await writeFile(imagePath, bytes, { flag: "wx" }); created.push(imagePath);
      const reopened = await readRegularFile(imagePath, 16 * 1024 * 1024, directory);
      if (!reopened.equals(bytes)) throw new Error("Landscape image changed during independent reopen.");
      const decoded = await this.options.verifyTracksImage(input.format, reopened, { width: prepared.width, height: prepared.height });
      if (decoded.width !== prepared.width || decoded.height !== prepared.height || decoded.sampledColorCount < 2) throw new Error("Landscape image decoded with incorrect dimensions or empty content.");
      await this.verifyTarget(input.request.target);
      if (input.request.structure) await this.read({ target: input.request.target, attachmentId: input.request.structure.attachmentId });
      await writeFile(metadataPath, `${JSON.stringify(prepared.metadata, null, 2)}\n`, { flag: "wx" }); created.push(metadataPath);
      const metadataBytes = await readRegularFile(metadataPath, 256 * 1024, directory);
      if (JSON.stringify(JSON.parse(metadataBytes.toString("utf8"))) !== JSON.stringify(prepared.metadata)) throw new Error("Landscape metadata changed during reopen.");
      const receipt: ProteinTrackExportReceipt = { schema: "proto-workbench.protein-landscape-verification.v1", status: "passed", format: input.format,
        relativePath: relative(this.workspaceRoot, imagePath), metadataRelativePath: relative(this.workspaceRoot, metadataPath), verificationRelativePath: relative(this.workspaceRoot, verificationPath),
        sha256: digest(reopened), svgSha256: prepared.svgSha256, artifactSha256: input.request.target.artifactSha256, sequenceSha256: input.request.target.sequenceSha256,
        width: prepared.width, height: prepared.height, bytes: reopened.length, decoder: decoded.decoder, pixelSha256: decoded.pixelSha256, sampledColorCount: decoded.sampledColorCount, verifiedAt: this.now() };
      await writeFile(verificationPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" }); created.push(verificationPath);
      await this.verifyTarget(input.request.target);
      return receipt;
    } catch (error) { for (const path of created) await unlink(path).catch(() => undefined); throw error; }
  }

  async saveView(input: { target: ProteinStructureTarget; attachmentId: string; view: ProteinStructureViewState }): Promise<ProteinStructureSavedView> {
    const data = await this.read(input);
    const sequenceLength = await this.verifyTarget(input.target);
    const view = validateProteinViewState(input.view, sequenceLength, data.attachment.source.provider === "alphafold");
    const saved: ProteinStructureSavedView = { schema: "proto-workbench.protein-view.v1", artifactSha256: input.target.artifactSha256,
      attachmentId: input.attachmentId, contentSha256: data.attachment.contentSha256, sequenceSha256: input.target.sequenceSha256,
      proteinId: input.target.proteinId, savedAt: this.now(), view };
    const directory = await this.directory("views");
    const path = join(directory, `${this.viewKey(input.target, input.attachmentId)}.json`);
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { flag: "wx" });
      await this.read(input);
      await rename(temporary, path);
      const reopened = await this.readView(input);
      if (!reopened || JSON.stringify(reopened) !== JSON.stringify(saved)) throw new Error("Saved protein view changed during reopen.");
      return reopened;
    } finally { await unlink(temporary).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }

  async readView(input: { target: ProteinStructureTarget; attachmentId: string }): Promise<ProteinStructureSavedView | null> {
    const data = await this.read(input);
    const sequenceLength = await this.verifyTarget(input.target);
    let bytes: Buffer;
    try { const path = join(await this.directory("views", false), `${this.viewKey(input.target, input.attachmentId)}.json`); bytes = await readRegularFile(path, 32_768, this.workspaceRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const saved = JSON.parse(bytes.toString("utf8")) as ProteinStructureSavedView;
    if (saved.schema !== "proto-workbench.protein-view.v1" || saved.artifactSha256 !== input.target.artifactSha256
      || saved.attachmentId !== input.attachmentId || saved.contentSha256 !== data.attachment.contentSha256
      || saved.sequenceSha256 !== input.target.sequenceSha256 || saved.proteinId !== input.target.proteinId
      || typeof saved.savedAt !== "string" || !Number.isFinite(Date.parse(saved.savedAt))) throw new Error("Saved protein view does not match the current artifact and structure.");
    return { ...saved, view: validateProteinViewState(saved.view, sequenceLength, data.attachment.source.provider === "alphafold") };
  }

  private viewKey(target: ProteinStructureTarget, attachmentId: string): string {
    return digest(Buffer.from(JSON.stringify([target.artifactSha256, target.proteinId, target.sequenceSha256, attachmentId])));
  }

  private async store(target: ProteinStructureTarget, bytes: Buffer, format: "mmcif" | "pdb", label: string,
    source: ProteinStructureAttachment["source"]): Promise<ProteinStructureData> {
    this.options.signal?.throwIfAborted();
    validateStructureText(bytes, format);
    const contentSha256 = digest(bytes);
    const id = digest(Buffer.from(JSON.stringify([target.proteinId, target.sequenceSha256, contentSha256, source.provider, source.accession])));
    const directory = await this.directory(target.sequenceSha256);
    const existing = await readdir(directory);
    if (existing.includes(`${id}.json`)) return this.read({ target, attachmentId: id });
    if (existing.filter((name) => name.endsWith(".json")).length >= LIMITS.maxAttachments) throw new Error("Maximum structure attachment count reached.");
    const attachment: ProteinStructureAttachment = { schema: "proto-workbench.protein-structure.v1", id, proteinId: target.proteinId,
      sequenceSha256: target.sequenceSha256, contentSha256, format, bytes: bytes.length, label: boundedText(label, 160), source, reviewStatus: "human_review_required" };
    const coordinatePath = join(directory, `${id}.${format === "pdb" ? "pdb" : "cif"}`);
    try { await writeFile(coordinatePath, bytes, { flag: "wx" }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (digest(await readRegularFile(coordinatePath, LIMITS.maxBytes, directory)) !== contentSha256) throw new Error("Existing structure bytes disagree with the content address.");
    }
    try { await writeFile(join(directory, `${id}.json`), `${JSON.stringify(attachment, null, 2)}\n`, { flag: "wx" }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return this.read({ target, attachmentId: id });
  }

  private async verifyTarget(target: ProteinStructureTarget): Promise<number> {
    return (await this.readTargetProtein(target)).length;
  }

  private async readTargetProtein(target: ProteinStructureTarget): Promise<ProteinViewModel> {
    this.options.signal?.throwIfAborted();
    if (!target || !/^[a-f0-9]{64}$/.test(target.artifactSha256) || !/^[a-f0-9]{64}$/.test(target.sequenceSha256)
      || typeof target.proteinId !== "string" || target.proteinId.length > 256 || typeof target.artifactPath !== "string") throw new Error("Invalid protein artifact binding.");
    const root = await realpath(this.workspaceRoot);
    const path = resolve(root, target.artifactPath);
    assertContained(root, path);
    const bytes = await readRegularFile(path, 8 * 1024 * 1024, root);
    if (digest(bytes) !== target.artifactSha256) throw new Error("Protein artifact changed; refresh before attaching a structure.");
    const result = parseDesignIr(bytes.toString("utf8"));
    if (!result.ok || result.design?.domain !== "protein" || !result.design.proteins.some((protein) => protein.id === target.proteinId && protein.sequenceSha256 === target.sequenceSha256)) {
      throw new Error("Structure target is not an integrity-checked protein in the selected artifact.");
    }
    return result.design.proteins.find((protein) => protein.id === target.proteinId)!;
  }

  private async directory(leaf: string, create = true): Promise<string> {
    if (leaf !== "exports" && leaf !== "views" && !/^[a-f0-9]{64}$/.test(leaf)) throw new Error("Invalid structure store key.");
    const root = await realpath(this.workspaceRoot);
    let current = root;
    for (const component of ["build", "protein-structures", leaf]) {
      current = join(current, component);
      if (create) { try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Structure storage cannot traverse links or non-directories.");
      assertContained(root, await realpath(current));
    }
    return current;
  }

  private async alphaFoldEntries(accession: string): Promise<Record<string, unknown>[]> {
    const payload = await this.json(`https://alphafold.ebi.ac.uk/api/prediction/${accession}`);
    if (!Array.isArray(payload) || payload.length > 100) throw new Error("Invalid AlphaFold metadata response.");
    return payload.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object"
      && entry.uniprotAccession === accession && typeof entry.cifUrl === "string"
      && (entry.entryId === `AF-${accession}-F1` || entry.entryId === `AF-${accession}-F1-model_v${String(entry.latestVersion)}`));
  }

  private async json(url: string, init?: RequestInit): Promise<unknown> {
    const bytes = await this.request(url, 1024 * 1024, init);
    return bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
  }

  private async request(url: string, maxBytes: number, init?: RequestInit): Promise<Buffer> {
    validateOfficialStructureUrl(url);
    const deadline = AbortSignal.timeout(LIMITS.networkTimeoutMs);
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, deadline]) : deadline;
    signal.throwIfAborted();
    const response = await (this.options.fetch ?? globalThis.fetch)(url, { ...init, redirect: "error", signal });
    if (!response.ok) throw new Error(`Official structure source returned HTTP ${response.status}.`);
    if (response.redirected) throw new Error("Structure-source redirects are not permitted.");
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) throw new Error("Structure response exceeds the download bound.");
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > maxBytes) throw new Error("Structure response exceeds the download bound.");
        chunks.push(result.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(chunks);
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
}

export function validateAccession(provider: StructureProvider, value: string): string {
  if (typeof value !== "string") throw new Error("Invalid structure accession.");
  const id = value.trim().toUpperCase();
  if (provider === "pdb" && /^[0-9][A-Z0-9]{3}$/.test(id)) return id;
  if (provider === "alphafold" && /^[A-Z0-9]{6,10}(?:-[0-9]{1,3})?$/.test(id)) return id;
  throw new Error("Use a PDB entry ID or a UniProt accession for the chosen source.");
}

export function validateOfficialStructureUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.search) throw new Error("Invalid official structure URL.");
  const valid = (url.hostname === "files.rcsb.org" && /^\/download\/[0-9][A-Z0-9]{3}\.cif$/.test(url.pathname))
    || (url.hostname === "data.rcsb.org" && /^\/rest\/v1\/core\/entry\/[0-9][A-Z0-9]{3}$/.test(url.pathname))
    || (url.hostname === "search.rcsb.org" && url.pathname === "/rcsbsearch/v2/query")
    || (url.hostname === "alphafold.ebi.ac.uk" && (/^\/api\/prediction\/[A-Z0-9]{6,10}(?:-[0-9]{1,3})?$/.test(url.pathname)
      || /^\/files\/AF-[A-Z0-9-]+-F1-model_v[0-9]+\.cif$/.test(url.pathname)));
  if (!valid) throw new Error("Only bounded official PDB and AlphaFold endpoints are allowed.");
  return url.href;
}

export function validateAlphaFoldDownload(value: unknown, accession: string): string {
  if (typeof value !== "string") throw new Error("AlphaFold metadata did not include a coordinate file.");
  validateOfficialStructureUrl(value);
  const url = new URL(value);
  if (url.hostname !== "alphafold.ebi.ac.uk" || !url.pathname.startsWith(`/files/AF-${accession}-F1-model_v`)) throw new Error("AlphaFold coordinate URL does not match the requested accession.");
  return url.href;
}

export function validateStructureText(bytes: Buffer, format: "mmcif" | "pdb"): string {
  if (!bytes.length || bytes.length > LIMITS.maxBytes) throw new Error("Structure file is empty or oversized.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("Binary data is not a supported coordinate file.");
  if (format === "mmcif") {
    if (!/^data_\S+/m.test(text) || !/_atom_site\./.test(text)) throw new Error("mmCIF atom-site data was not found.");
  } else if (format === "pdb") {
    const atoms = text.match(/^(?:ATOM  |HETATM)/gm)?.length ?? 0;
    if (!atoms || atoms > LIMITS.maxAtoms) throw new Error("PDB atom count is empty or outside the supported bound.");
  } else throw new Error("Unsupported coordinate format.");
  return text;
}

function validateAttachment(item: ProteinStructureAttachment, target: ProteinStructureTarget, id: string): void {
  if (!item || item.schema !== "proto-workbench.protein-structure.v1" || item.id !== id || item.sequenceSha256 !== target.sequenceSha256
    || item.proteinId !== target.proteinId || !/^[a-f0-9]{64}$/.test(item.contentSha256) || !["pdb", "mmcif"].includes(item.format)
    || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > LIMITS.maxBytes || item.reviewStatus !== "human_review_required"
    || typeof item.label !== "string" || item.label.length > 160 || !item.source || !["pdb", "alphafold", "local"].includes(item.source.provider)) throw new Error("Invalid or mismatched structure metadata.");
  const source = item.source;
  if (typeof source.accession !== "string" || source.accession.length > 160 || typeof source.attribution !== "string" || source.attribution.length > 512
    || typeof source.retrievedAt !== "string" || source.retrievedAt.length > 64 || !Number.isFinite(Date.parse(source.retrievedAt))) throw new Error("Invalid structure provenance metadata.");
  if (source.provider !== "local") {
    validateOfficialStructureUrl(source.url ?? "");
    const accession = validateAccession(source.provider, source.accession);
    if (source.provider === "alphafold") validateAlphaFoldDownload(source.url, accession);
    else if (source.url !== `https://files.rcsb.org/download/${accession}.cif`) throw new Error("PDB metadata URL mismatch.");
    if (source.classification !== (source.provider === "pdb" ? "experimental" : "predicted")
      || source.license !== (source.provider === "pdb" ? "CC0-1.0" : "CC-BY-4.0")) throw new Error("Structure source classification mismatch.");
  } else if (source.url !== null || source.classification !== "unknown" || source.license !== "NOASSERTION") throw new Error("Local files cannot assert public-source provenance.");
  const expectedId = digest(Buffer.from(JSON.stringify([item.proteinId, item.sequenceSha256, item.contentSha256, source.provider, source.accession])));
  if (expectedId !== id) throw new Error("Structure metadata content address mismatch.");
}

async function readRegularFile(path: string, maximum: number, root?: string): Promise<Buffer> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > maximum) throw new Error("Only bounded, single-link regular files may be read.");
  const canonical = await realpath(path);
  if (root) assertContained(await realpath(root), canonical);
  const handle = await open(path, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum || before.ino !== info.ino || before.dev !== info.dev) throw new Error("Structure file changed before read.");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("Structure file ended during read.");
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || (await realpath(path)) !== canonical) throw new Error("Structure file changed during read.");
    return bytes;
  } finally { await handle.close(); }
}

function assertContained(root: string, path: string): void {
  const result = relative(root, path);
  if (result.startsWith("..") || isAbsolute(result)) throw new Error("Path is outside the selected workspace.");
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function boundedText(value: unknown, limit: number): string { return typeof value === "string" ? value.replace(/[\x00-\x1f]/g, " ").slice(0, limit) : ""; }
