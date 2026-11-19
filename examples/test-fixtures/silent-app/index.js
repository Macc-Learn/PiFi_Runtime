// Test fixture: says hello but never sends "ready", so PiFi's start timeout must fire.
import WebSocket from "ws";
const ws = new WebSocket(process.env.PIFI_URL);
const send = (m) => ws.send(JSON.stringify({ v: 1, ...m }));
ws.on("open", () => send({ type: "hello", payload: { name: process.env.PIFI_APP_NAME, token: process.env.PIFI_APP_TOKEN, sdkVersion: "fixture" } }));
ws.on("close", () => process.exit(1));

ws.on("message", () => {}); // receives welcome, deliberately does nothing
setInterval(() => {}, 1000);
