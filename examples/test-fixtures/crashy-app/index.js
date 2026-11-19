// Test fixture: healthy at first, then crashes after CRASH_AFTER_MS.
import WebSocket from "ws";
const ws = new WebSocket(process.env.PIFI_URL);
const send = (m) => ws.send(JSON.stringify({ v: 1, ...m }));
ws.on("open", () => send({ type: "hello", payload: { name: process.env.PIFI_APP_NAME, token: process.env.PIFI_APP_TOKEN, sdkVersion: "fixture" } }));
ws.on("close", () => process.exit(1));

const crashAfter = Number(process.env.CRASH_AFTER_MS ?? 150);
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "welcome") {
    send({ type: "ready" });
    setTimeout(() => { console.error("crashy: crashing now"); process.exit(1); }, crashAfter);
  }
  if (msg.type === "shutdown") process.exit(0);
});
