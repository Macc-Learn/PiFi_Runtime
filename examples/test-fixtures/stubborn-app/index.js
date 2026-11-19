// Test fixture: refuses to die politely. Only SIGKILL can stop it.
import WebSocket from "ws";
const ws = new WebSocket(process.env.PIFI_URL);
const send = (m) => ws.send(JSON.stringify({ v: 1, ...m }));
ws.on("open", () => send({ type: "hello", payload: { name: process.env.PIFI_APP_NAME, token: process.env.PIFI_APP_TOKEN, sdkVersion: "fixture" } }));
ws.on("close", () => process.exit(1));

process.on("SIGTERM", () => console.log("stubborn: ignoring SIGTERM"));
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "welcome") send({ type: "ready" });
  if (msg.type === "shutdown") console.log("stubborn: ignoring shutdown");
});
setInterval(() => {}, 1000); // keep the event loop alive
