import { afterEach, expect, it } from "vitest";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { localWebSocketFactory } from "./transport";

let directory: string | undefined;
let server: Server | undefined;
let sockets: WebSocketServer | undefined;
let client: WebSocket | undefined;
afterEach(async () => {
  client?.terminate();
  for (const socket of sockets?.clients ?? []) socket.terminate();
  if (sockets) await new Promise<void>((resolve) => sockets!.close(() => resolve()));
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined; server = undefined; sockets = undefined; client = undefined;
});

async function roundtrip(url: string, path?: string) {
  let header: string | string[] | undefined;
  sockets!.on("connection", (socket, request) => {
    header = request.headers["x-local-test"];
    socket.on("message", (data) => socket.send(data));
  });
  client = localWebSocketFactory(path)(url, { headers: { "x-local-test": "verified" } }) as unknown as WebSocket;
  await once(client, "open");
  const response = once(client, "message");
  client.send("local roundtrip");
  expect(String((await response)[0])).toBe("local roundtrip");
  expect(header).toBe("verified");
}

it.skipIf(process.platform === "win32")("uses the Unix socket even when the URL's TCP listener does not exist", async () => {
  directory = await mkdtemp(join(tmpdir(), "uds-"));
  const path = join(directory, "ws.sock");
  server = createServer(); sockets = new WebSocketServer({ server });
  server.listen(path); await once(server, "listening");
  await roundtrip("ws://localhost:1/ws", path);
});

it("keeps the regular loopback WebSocket transport working", async () => {
  server = createServer(); sockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  await roundtrip(`ws://127.0.0.1:${address.port}/ws`);
});
