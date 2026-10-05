async function render() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "status" });
    document.getElementById("count").textContent = res.count ?? 0;
    document.getElementById("source").textContent = res.source ?? "unknown";
    document.getElementById("updated").textContent =
      res.updatedAt ? new Date(res.updatedAt).toLocaleString() : "never";
    document.getElementById("dns").textContent = res.dnsCached ?? 0;
    document.getElementById("smart").textContent = res.learned ?? 0;
    document.getElementById("net").textContent = res.netRules ?? 0;
  } catch {
    document.getElementById("count").textContent = "error";
  }
}
document.getElementById("refresh").addEventListener("click", async () => {
  const btn = document.getElementById("refresh");
  btn.textContent = "Refreshing…";
  try {
    await chrome.runtime.sendMessage({ type: "refresh" });
  } catch {}
  await render();
  btn.textContent = "Refresh block list now";
});
document.getElementById("clear-smart").addEventListener("click", async () => {
  const btn = document.getElementById("clear-smart");
  btn.textContent = "Clearing…";
  try {
    await chrome.runtime.sendMessage({ type: "clearLearned" });
  } catch {}
  await render();
  btn.textContent = "Clear smart list";
});
render();
