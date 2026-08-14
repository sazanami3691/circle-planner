const CACHE_PREFIX = "circle-planner-shell-";
const CACHE_NAME = "circle-planner-shell-v3-20260814";
const CACHE_META_NAME = "circle-planner-cache-meta-v1";
const ACTIVE_CACHE_KEY = new URL("./__active-shell-cache__", self.registration.scope).href;
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/app.js",
  "./js/core.js",
  "./js/storage.js",
  "./manifest.webmanifest",
  "./icons/app-icon.svg",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

let refreshPromise = null;

function canonicalRequest(path) {
  return new Request(new URL(path, self.registration.scope).href, {
    credentials: "same-origin"
  });
}

function freshRequest(path, token) {
  const url = new URL(path, self.registration.scope);
  url.searchParams.set("circlePlannerUpdate", token);
  return new Request(url.href, {
    cache: "reload",
    credentials: "same-origin"
  });
}

async function responsesAreEqual(first, second) {
  if (!first || !second) return false;
  const [firstBytes, secondBytes] = await Promise.all([
    first.arrayBuffer(),
    second.arrayBuffer()
  ]);
  if (firstBytes.byteLength !== secondBytes.byteLength) return false;

  const firstView = new Uint8Array(firstBytes);
  const secondView = new Uint8Array(secondBytes);
  for (let index = 0; index < firstView.length; index += 1) {
    if (firstView[index] !== secondView[index]) return false;
  }
  return true;
}

async function getActiveCacheName() {
  const metadata = await caches.open(CACHE_META_NAME);
  const saved = await metadata.match(ACTIVE_CACHE_KEY);
  return saved ? saved.text() : CACHE_NAME;
}

async function setActiveCacheName(cacheName) {
  const metadata = await caches.open(CACHE_META_NAME);
  await metadata.put(
    ACTIVE_CACHE_KEY,
    new Response(cacheName, { headers: { "Content-Type": "text/plain" } })
  );
}

async function populateShellCache(targetCacheName, comparisonCacheName = null) {
  const targetCache = await caches.open(targetCacheName);
  const comparisonCache = comparisonCacheName ? await caches.open(comparisonCacheName) : null;
  const updateToken = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let changed = !comparisonCache;

  for (const path of APP_SHELL) {
    const canonical = canonicalRequest(path);
    const response = await fetch(freshRequest(path, updateToken));
    if (!response.ok) {
      throw new Error(`App shell request failed: ${path}`);
    }

    if (comparisonCache && !changed) {
      const current = await comparisonCache.match(canonical);
      changed = !(await responsesAreEqual(current, response.clone()));
    }

    await targetCache.put(canonical, response);
  }

  return changed;
}

async function deleteUnusedShellCaches(activeCacheName) {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((cacheName) => cacheName.startsWith(CACHE_PREFIX) && cacheName !== activeCacheName)
      .map((cacheName) => caches.delete(cacheName))
  );
}

async function installCurrentShell() {
  try {
    await populateShellCache(CACHE_NAME);
    await setActiveCacheName(CACHE_NAME);
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

async function refreshAppShell() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const activeCacheName = await getActiveCacheName();
    const stagedCacheName = `${CACHE_PREFIX}manual-${Date.now()}`;

    try {
      const updated = await populateShellCache(stagedCacheName, activeCacheName);
      if (!updated) {
        await caches.delete(stagedCacheName);
        return { updated: false };
      }

      await setActiveCacheName(stagedCacheName);
      await deleteUnusedShellCaches(stagedCacheName);
      return { updated: true };
    } catch (error) {
      await caches.delete(stagedCacheName);
      throw error;
    }
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function matchActiveCache(request) {
  const activeCacheName = await getActiveCacheName();
  const cache = await caches.open(activeCacheName);
  return cache.match(request);
}

async function cacheResponseInActiveCache(request, response) {
  const activeCacheName = await getActiveCacheName();
  const cache = await caches.open(activeCacheName);
  await cache.put(request, response);
}

async function cacheFirst(request) {
  const cached = await matchActiveCache(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.status === 200 && response.type === "basic") {
    await cacheResponseInActiveCache(request, response.clone());
  }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.all([installCurrentShell(), self.skipWaiting()]));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    getActiveCacheName()
      .then((activeCacheName) => deleteUnusedShellCaches(activeCacheName))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "REFRESH_APP_SHELL") return;

  const replyPort = event.ports[0];
  event.waitUntil(
    refreshAppShell().then(
      (result) => replyPort?.postMessage({ ok: true, ...result }),
      () => replyPort?.postMessage({ ok: false })
    )
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => matchActiveCache(canonicalRequest("./index.html")))
    );
    return;
  }

  event.respondWith(cacheFirst(request));
});
