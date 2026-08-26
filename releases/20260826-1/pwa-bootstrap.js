(() => {
  const documentRelease = document.documentElement.dataset.appRelease;

  if (!("serviceWorker" in navigator) || !window.location.protocol.startsWith("http")) return;
  if (!documentRelease) return;

  window.addEventListener(
    "load",
    async () => {
      try {
        await navigator.serviceWorker.register("./service-worker.js", { updateViaCache: "none" });
      } catch {
        const connectionStatus = document.querySelector("#connection-status");
        if (connectionStatus) connectionStatus.textContent = "オフライン準備に失敗しました";
      }
    },
    { once: true },
  );
})();
