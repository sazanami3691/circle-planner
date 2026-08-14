import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

async function read(relativePath, encoding = "utf8") {
  return readFile(resolve(root, relativePath), encoding);
}

function releaseFromHtml(html) {
  return html.match(/data-app-release=["']([^"']+)["']/)?.[1];
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
  const html = await read("index.html");
  const release = releaseFromHtml(html);
  const manifest = JSON.parse(await read(`manifest.${release}.webmanifest`));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.theme_color, "#0f141b");
  assert.deepEqual(
    manifest.icons.map((icon) => icon.sizes),
    ["192x192", "512x512", "512x512"],
  );

  for (const icon of manifest.icons) {
    assert.match(icon.src, new RegExp(`^releases/${release}/`));
    const png = await read(icon.src, null);
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  }
});

test("Service Workerのアプリシェル参照先がすべて存在する", async () => {
  const worker = await read("service-worker.js");
  const release = worker.match(/const RELEASE_VERSION = ["']([^"']+)["']/)?.[1];
  assert.ok(release);
  const appShellBlock = worker.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  assert.ok(appShellBlock);

  const paths = [...appShellBlock[1].matchAll(/["'`](\.\/.*?)["'`]/g)]
    .map((match) => match[1].replace("${RELEASE_VERSION}", release))
    .filter(Boolean);
  assert.ok(paths.includes("./index.html"));
  assert.ok(paths.includes(`./releases/${release}/pwa-bootstrap.js`));
  assert.ok(paths.includes(`./releases/${release}/app.js`));
  assert.ok(paths.includes(`./manifest.${release}.webmanifest`));

  for (const relativePath of paths) {
    if (relativePath === "./") continue;
    await assert.doesNotReject(
      read(relativePath, null),
      `Missing app shell file: ${relativePath}`,
    );
  }
});

test("同一リリースIDがHTML・モジュール・manifest・Service Workerを結ぶ", async () => {
  const [html, app, bootstrap, worker, releaseConfig] = await Promise.all([
    read("index.html"),
    read("js/app.js"),
    read("js/pwa-bootstrap.js"),
    read("service-worker.js"),
    read("release.json").then(JSON.parse),
  ]);
  const release = releaseFromHtml(html);
  assert.ok(release);
  assert.equal(releaseConfig.version, release);

  const requiredHtmlAssets = [
    `releases/${release}/styles.css`,
    `releases/${release}/pwa-bootstrap.js`,
    `releases/${release}/app.js`,
    `manifest.${release}.webmanifest`,
    `releases/${release}/app-icon.svg`,
    `releases/${release}/apple-touch-icon.png`,
  ];
  for (const asset of requiredHtmlAssets) {
    assert.match(html, new RegExp(asset.replaceAll(".", "\\.")));
  }

  assert.match(app, /from ["']\.\/core\.js["']/);
  assert.match(app, /from ["']\.\/storage\.js["']/);
  assert.match(bootstrap, /document\.documentElement\.dataset\.appRelease/);
  assert.match(bootstrap, /register\(["']\.\/service-worker\.js["']/);
  assert.match(worker, new RegExp(`const RELEASE_VERSION = ["']${release}["']`));
});

test("リリース用アセットは正本と一致する", async () => {
  const { version } = JSON.parse(await read("release.json"));
  const sourceFiles = [
    ["styles.css", "styles.css"],
    ["js/pwa-bootstrap.js", "pwa-bootstrap.js"],
    ["js/app.js", "app.js"],
    ["js/core.js", "core.js"],
    ["js/storage.js", "storage.js"],
    ["icons/app-icon.svg", "app-icon.svg"],
    ["icons/apple-touch-icon.png", "apple-touch-icon.png"],
    ["icons/icon-192.png", "icon-192.png"],
    ["icons/icon-512.png", "icon-512.png"],
    ["icons/icon-maskable-512.png", "icon-maskable-512.png"],
  ];

  for (const [source, output] of sourceFiles) {
    assert.deepEqual(await read(source, null), await read(`releases/${version}/${output}`, null));
  }
});

test("旧cache-firstキャッシュは新リリースのCSSとJavaScriptに一致しない", async () => {
  const html = await read("index.html");
  const release = releaseFromHtml(html);
  const origin = "https://example.test/circle-planner/";
  const legacyUrls = new Set(
    ["styles.css", "js/app.js", "js/core.js", "js/storage.js"].map(
      (path) => new URL(path, origin).href,
    ),
  );
  const newReleasePaths = [
    `releases/${release}/styles.css`,
    `releases/${release}/app.js`,
    `releases/${release}/core.js`,
    `releases/${release}/storage.js`,
  ];

  assert.equal(newReleasePaths.length, 4);
  const newReleaseMarkup = html + (await read(`releases/${release}/app.js`));
  for (const path of newReleasePaths) {
    const fileName = path.split("/").at(-1).replace(".", "\\.");
    assert.match(newReleaseMarkup, new RegExp(fileName));
    assert.equal(legacyUrls.has(new URL(path, origin).href), false);
  }
  assert.equal(legacyUrls.has(new URL("styles.css", origin).href), true);
  assert.equal(legacyUrls.has(new URL("js/app.js", origin).href), true);
});

test("手動更新は再取得完了後にキャッシュを切り替え、保存データには触れない", async () => {
  const [worker, app, bootstrap] = await Promise.all([
    read("service-worker.js"),
    read("js/app.js"),
    read("js/pwa-bootstrap.js"),
  ]);

  assert.match(worker, /REFRESH_APP_SHELL/);
  assert.match(worker, /cache:\s*["']reload["']/);
  assert.match(worker, /ACTIVE_CACHE_KEY/);
  assert.match(worker, /event\.ports\[0\]/);
  assert.match(worker, /stagedCacheName/);
  assert.match(app, /updateViaCache:\s*["']none["']/);
  assert.match(bootstrap, /updateViaCache:\s*["']none["']/);
  assert.match(app, /MessageChannel/);
  assert.doesNotMatch(app, /localStorage\.(?:clear|removeItem)\s*\(/);
  assert.doesNotMatch(bootstrap, /localStorage/);
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
