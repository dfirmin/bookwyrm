// Match the OS: its name (for small shape differences) and the accent colour the person chose.
export async function applyOs() {
  const set = (info) => {
    if (!info) return;
    document.body.dataset.os = info.platform;
    if (info.accent) {
      document.documentElement.style.setProperty("--accent", info.accent);
      document.documentElement.style.setProperty("--accent-text", info.accentText || "#fff");
    }
  };
  set(await window.bookwyrm.osInfo());
  window.bookwyrm.onOsInfo?.(set);
}
