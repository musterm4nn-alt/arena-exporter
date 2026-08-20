"use strict";
document.getElementById("btn-ping").addEventListener("click", ping);
ping();
function ping() {
  const el = document.getElementById("host-status");
  el.textContent = "Pinging…";
  chrome.runtime.sendMessage({ type: "AE_PING_HOST" }, (res) => {
    void chrome.runtime.lastError;
    if (res && res.ok) el.textContent = "Host ok. root=" + (res.root || "?");
    else el.textContent = "Host not installed or extension ID not in native manifest.";
  });
}
