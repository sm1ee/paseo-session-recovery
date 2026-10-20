import { connect } from "node:net";
import WebSocket from "ws";
import type { WebSocketFactory, WebSocketLike } from "@getpaseo/client/internal/daemon-client";

export function localWebSocketFactory(socketPath?: string): WebSocketFactory {
  return (url, options) => new WebSocket(url, options?.protocols, {
    headers: options?.headers,
    // ws discards the socketPath option. Supply the socket explicitly so a
    // configured Unix endpoint cannot fall back to a TCP connection.
    ...(socketPath ? { createConnection: () => connect({ path: socketPath }) } : {}),
  }) as unknown as WebSocketLike;
}
