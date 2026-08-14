import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const releaseConfig = JSON.parse(await readFile(resolve(root, "release.json"), "utf8"));
const version = releaseConfig.version;

if (!/^\d{8}-\d+$/.test(version)) {
  throw new Error("release.jsonのversionはYYYYMMDD-N形式で指定してください。");
}

const releaseDirectory = resolve(root, "releases", version);
await mkdir(releaseDirectory, { recursive: true });

const releaseFiles = [
  ["styles.css", "styles.css"],
  ["js/pwa-bootstrap.js", "pwa-bootstrap.js"],
  ["js/app.js", "app.js"],
  ["js/core.js", "core.js"],
  ["js/storage.js", "storage.js"],
  ["js/ntfy.js", "ntfy.js"],
  ["icons/app-icon.svg", "app-icon.svg"],
  ["icons/apple-touch-icon.png", "apple-touch-icon.png"],
  ["icons/icon-192.png", "icon-192.png"],
  ["icons/icon-512.png", "icon-512.png"],
  ["icons/icon-maskable-512.png", "icon-maskable-512.png"],
];

await Promise.all(
  releaseFiles.map(([source, destination]) =>
    copyFile(resolve(root, source), resolve(releaseDirectory, destination)),
  ),
);

const manifest = JSON.parse(await readFile(resolve(root, "manifest.webmanifest"), "utf8"));
manifest.icons = manifest.icons.map((icon) => ({
  ...icon,
  src: `releases/${version}/${basename(icon.src)}`,
}));
await writeFile(
  resolve(root, `manifest.${version}.webmanifest`),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(`release assets built: ${version}`);
