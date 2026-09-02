import process from "node:process";
import sharp from "sharp";

const [referencePath, prototypePath, outputPath] = process.argv.slice(2);
if (!referencePath || !prototypePath || !outputPath) {
  console.error("Usage: node scripts/compare-visual-references.mjs <reference.png> <prototype.png> <output.png>");
  process.exitCode = 1;
} else {
  const width = 1280;
  const height = 720;
  const background = "#f5f7f6";
  const [reference, prototype] = await Promise.all([
    sharp(referencePath).resize(width, height, { fit: "contain", background }).png().toBuffer(),
    sharp(prototypePath).resize(width, height, { fit: "contain", background }).png().toBuffer(),
  ]);

  await sharp({
    create: { width: width * 2, height, channels: 4, background },
  }).composite([
    { input: reference, left: 0, top: 0 },
    { input: prototype, left: width, top: 0 },
  ]).png().toFile(outputPath);

  console.log(outputPath);
}
