import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

async function read(relativePath, encoding = "utf8") {
  return readFile(resolve(root, relativePath), encoding);
}

test("HTMLはローカル資産だけを参照し、主要操作を備える", async () => {
  const html = await read("index.html");
  assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//i);
  for (const id of [
    "menu-toggle",
    "menu-layer",
    "app-drawer",
    "menu-overlay",
    "menu-close",
    "update-app",
    "update-status",
    "schedule-svg",
    "open-add-dialog",
    "previous-day",
    "today",
    "next-day",
    "event-form",
    "delete-event",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test("manifestの必須情報とアイコンが揃っている", async () => {
  const manifest = JSON.parse(await read("manifest.webmanifest"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.theme_color, "#0f141b");
  assert.deepEqual(
    manifest.icons.map((icon) => icon.sizes),
    ["192x192", "512x512", "512x512"],
  );

  for (const icon of manifest.icons) {
    const png = await read(icon.src, null);
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  }
});

test("Service Workerのアプリシェル参照先がすべて存在する", async () => {
  const worker = await read("service-worker.js");
  const appShellBlock = worker.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  assert.ok(appShellBlock);

  const paths = [...appShellBlock[1].matchAll(/["']\.\/(.*?)["']/g)]
    .map((match) => match[1])
    .filter(Boolean);
  assert.ok(paths.includes("index.html"));
  assert.ok(paths.includes("js/app.js"));
  assert.ok(paths.includes("manifest.webmanifest"));

  for (const relativePath of paths) {
    await assert.doesNotReject(read(relativePath, null), `Missing app shell file: ${relativePath}`);
  }
});

test("手動更新は再取得完了後にキャッシュを切り替え、保存データには触れない", async () => {
  const [worker, app] = await Promise.all([read("service-worker.js"), read("js/app.js")]);

  assert.match(worker, /REFRESH_APP_SHELL/);
  assert.match(worker, /cache:\s*["']reload["']/);
  assert.match(worker, /ACTIVE_CACHE_KEY/);
  assert.match(worker, /event\.ports\[0\]/);
  assert.match(worker, /stagedCacheName/);
  assert.match(app, /updateViaCache:\s*["']none["']/);
  assert.match(app, /MessageChannel/);
  assert.doesNotMatch(app, /localStorage\.(?:clear|removeItem)\s*\(/);
  assert.doesNotMatch(worker, /localStorage/);
});

test("メニューはアクセシブルなドロワーとして定義される", async () => {
  const [html, css, app] = await Promise.all([
    read("index.html"),
    read("styles.css"),
    read("js/app.js"),
  ]);

  assert.match(html, /aria-controls=["']app-drawer["']/);
  assert.match(html, /aria-expanded=["']false["']/);
  assert.match(html, /aria-modal=["']true["']/);
  assert.match(html, /aria-live=["']polite["']/);
  assert.match(css, /\.menu-action[\s\S]*?min-height:\s*60px/);
  assert.match(css, /\.app-drawer[\s\S]*?safe-area-inset/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(app, /event\.key === ["']Escape["']/);
  assert.match(app, /\.inert\s*=/);
});

test("レスポンシブUIと44px操作領域の基準がCSSにある", async () => {
  const css = await read("styles.css");
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /min-width:\s*320px/);
  assert.match(css, /@media\s*\(max-width:\s*620px\)/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /safe-area-inset/);
});
