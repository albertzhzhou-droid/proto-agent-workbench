import type { MapExportMetadata } from "../shared/contracts.ts";

export type { MapExportMetadata } from "../shared/contracts.ts";

/** Add provenance as escaped SVG metadata without introducing an HTML/XML sink. */
export function embedSvgMetadata(svg: string, metadata: MapExportMetadata): string | undefined {
  const openingTag = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!openingTag) return undefined;
  const payload = escapeXmlText(JSON.stringify(metadata));
  return svg.replace(openingTag, `${openingTag}<metadata id="proto-workbench-map-export">${payload}</metadata>`);
}

export function metadataSidecarFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/u, "") + ".metadata.json";
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
