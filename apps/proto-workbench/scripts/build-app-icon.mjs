import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dna } from "lucide-react";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = join(appRoot, "build");
await mkdir(buildDirectory, { recursive: true });

const iconMarkup = renderToStaticMarkup(
  createElement(
    "svg",
    { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 1024 1024", width: 1024, height: 1024 },
    createElement("rect", { width: 1024, height: 1024, rx: 196, fill: "#087f78" }),
    createElement(Dna, {
      x: 188,
      y: 188,
      width: 648,
      height: 648,
      color: "#f7fffd",
      strokeWidth: 1.75,
      absoluteStrokeWidth: false,
    }),
  ),
);
const svg = Buffer.from(iconMarkup);
const pngPath = join(buildDirectory, "icon.png");
await sharp(svg).resize(1024, 1024).png({ compressionLevel: 9 }).toFile(pngPath);

const icoImages = await Promise.all(
  [16, 24, 32, 48, 64, 128, 256].map((size) =>
    sharp(svg).resize(size, size).png({ compressionLevel: 9 }).toBuffer(),
  ),
);
await writeFile(join(buildDirectory, "icon.ico"), await pngToIco(icoImages));
console.log(`Proto Workbench icons generated in ${buildDirectory}`);
