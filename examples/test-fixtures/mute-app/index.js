// Test fixture: ready, but never answers a request (exercises the request timeout).
import WebSocket from "ws";
const ws = new WebSocket(process.env.PIFI_URL);
const send = (m) => ws.send(JSON.stringify({ v: 1, ...m }));
ws.on("open", () => send({ type: "hello", payload: { name: process.env.PIFI_APP_NAME, token: process.env.PIFI_APP_TOKEN, sdkVersion: "fixture" } }));
ws.on("close", () => process.exit(1));

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "welcome") send({ type: "ready" });
  if (msg.type === "shutdown") process.exit(0);
});
