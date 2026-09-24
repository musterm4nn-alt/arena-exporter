import crypto from "node:crypto";

export function chromeExtensionId(publicKey) {
  const digest = crypto.createHash("sha256").update(Buffer.from(publicKey, "base64")).digest().subarray(0, 16);
  let id = "";
  for (const byte of digest) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 15));
  }
  return id;
}

export function nativeHostManifest(browser, { hostPath, publicKey, geckoId }) {
  const manifest = {
    name: "com.arenaarchive.host",
    description: "Arena Archive native messaging writer",
    path: hostPath,
    type: "stdio"
  };
  if (browser === "chrome") {
    manifest.allowed_origins = [`chrome-extension://${chromeExtensionId(publicKey)}/`];
  } else if (browser === "firefox") {
    manifest.allowed_extensions = [geckoId];
  } else {
    throw new Error(`Unsupported native-host browser: ${browser}`);
  }
  return manifest;
}
