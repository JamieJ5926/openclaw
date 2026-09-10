import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { installDiscordEndpointRuntime, type DiscordEndpointLease } from "../endpoint-runtime.js";
import { createDiscordGatewayPlugin } from "./gateway-plugin.js";

let endpointLease: DiscordEndpointLease | undefined;
let server: WebSocketServer | undefined;

afterEach(async () => {
  endpointLease?.close();
  endpointLease = undefined;
  if (server) {
    for (const client of server.clients) {
      client.terminate();
    }
    const currentServer = server;
    await new Promise<void>((resolve) => {
      currentServer.close(() => resolve());
    });
    server = undefined;
  }
});

describe("Discord Gateway endpoint retirement", () => {
  it("closes a real active socket and rejects delayed sends and reconnects", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback TCP address");
    }
    const origin = `ws://127.0.0.1:${address.port}`;
    endpointLease = installDiscordEndpointRuntime({
      restApiBaseUrl: `http://127.0.0.1:${address.port}/api/v10`,
      gatewayBotUrl: `http://127.0.0.1:${address.port}/api/v10/gateway/bot`,
      gatewayOrigin: origin,
    });
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      testing: { webSocketCtor: WebSocket },
    });
    const createWebSocket = Reflect.get(plugin, "createWebSocket");
    if (typeof createWebSocket !== "function") {
      throw new Error("expected Gateway WebSocket factory");
    }
    const connection = once(server, "connection");
    const socket = Reflect.apply(createWebSocket, plugin, [`${origin}/gateway?v=10`]);
    if (!(socket instanceof WebSocket)) {
      throw new Error("expected ws WebSocket");
    }
    Reflect.set(plugin, "ws", socket);
    const opened = once(socket, "open");
    const [connected] = await Promise.all([connection, opened]);
    const [peer] = connected;
    if (!(peer instanceof WebSocket)) {
      throw new Error("expected server WebSocket");
    }
    let received = 0;
    peer.on("message", () => {
      received += 1;
    });
    socket.send("before-retirement");
    await once(peer, "message");

    endpointLease.close();
    await once(peer, "close");
    const delayedSendError = await new Promise<Error | undefined>((resolve) => {
      try {
        socket.send("after-retirement", (error) => resolve(error));
      } catch (error) {
        resolve(error instanceof Error ? error : new Error(String(error)));
      }
    });

    expect(delayedSendError).toBeInstanceOf(Error);
    expect(received).toBe(1);
    expect(() => Reflect.apply(createWebSocket, plugin, [`${origin}/gateway?resume=1`])).toThrow(
      "lease has been retired",
    );
    console.log(
      `[discord gateway retirement proof] active_closed=true delayed_send_rejected=${Boolean(delayedSendError)} received_after_close=${received - 1} reconnect_rejected=true`,
    );
  });
});
