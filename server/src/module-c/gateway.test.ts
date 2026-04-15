import assert from "node:assert/strict";
import test from "node:test";
import { io, type Socket } from "socket.io-client";
import { bootstrapGateway } from "./gateway.js";

interface ClientHandle {
  playerId: string;
  socket: Socket;
}

async function onceEvent<T>(socket: Socket, event: string): Promise<T> {
  return await new Promise<T>((resolve) => {
    socket.once(event, (payload: T) => resolve(payload));
  });
}

async function connectClient(baseUrl: string, playerId: string): Promise<ClientHandle> {
  const socket = io(baseUrl, {
    transports: ["websocket"],
    auth: { playerId, token: `dev_${playerId}` },
    reconnection: false,
    timeout: 5000,
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });

  return { playerId, socket };
}

async function closeClients(clients: ClientHandle[]): Promise<void> {
  await Promise.all(
    clients.map(
      async ({ socket }) =>
        await new Promise<void>((resolve) => {
          if (!socket.connected) {
            socket.close();
            resolve();
            return;
          }
          socket.once("disconnect", () => resolve());
          socket.close();
        }),
    ),
  );
}

test("Gateway 按玩家定向下发视图，避免隐藏信息广播泄漏", async () => {
  const runtime = await bootstrapGateway(0);
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const clients = await Promise.all(["p1", "p2", "p3"].map((playerId) => connectClient(baseUrl, playerId)));

  try {
    const [owner, p2, p3] = clients;
    const ownerSync = onceEvent<{ roomId: string }>(owner.socket, "room:sync");
    owner.socket.emit("room:create", { gameId: "doudizhu", playerId: owner.playerId });
    const { roomId } = await ownerSync;

    for (const client of [p2, p3]) {
      const joined = onceEvent<{ roomId: string }>(client.socket, "room:sync");
      client.socket.emit("room:join", { roomId, playerId: client.playerId });
      await joined;
    }

    const startEvents = new Map<string, Array<{ playerId: string; stateVersion: number }>>();
    for (const client of clients) {
      startEvents.set(client.playerId, []);
      client.socket.on("game:start", (payload: { playerId: string; stateVersion: number }) => {
        startEvents.get(client.playerId)?.push(payload);
      });
    }

    for (const client of clients) {
      client.socket.emit("game:ready");
    }

    await new Promise((resolve) => setTimeout(resolve, 200));

    for (const client of clients) {
      const events = startEvents.get(client.playerId) ?? [];
      assert.equal(events.length, 1);
      assert.equal(events[0]?.playerId, client.playerId);
      assert.equal(typeof events[0]?.stateVersion, "number");
    }

    const updateEvents = new Map<string, Array<{ playerId: string; stateVersion: number }>>();
    for (const client of clients) {
      updateEvents.set(client.playerId, []);
      client.socket.on("game:update", (payload: { playerId: string; stateVersion: number }) => {
        updateEvents.get(client.playerId)?.push(payload);
      });
    }

    owner.socket.emit("game:action", {
      actionId: "act_1",
      type: "PASS",
      payload: {},
      clientTs: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    for (const client of clients) {
      const events = updateEvents.get(client.playerId) ?? [];
      assert.equal(events.length, 1);
      assert.equal(events[0]?.playerId, client.playerId);
      assert.equal(typeof events[0]?.stateVersion, "number");
    }
  } finally {
    await closeClients(clients);
    await runtime.close();
  }
});

test("room:reconnect 必须与握手鉴权玩家一致", async () => {
  const runtime = await bootstrapGateway(0);
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const owner = await connectClient(baseUrl, "owner");
  const intruder = await connectClient(baseUrl, "intruder");

  try {
    const sync = onceEvent<{ roomId: string }>(owner.socket, "room:sync");
    owner.socket.emit("room:create", { gameId: "gobang", playerId: owner.playerId });
    const { roomId } = await sync;

    const disconnected = new Promise<void>((resolve) => owner.socket.once("disconnect", () => resolve()));
    owner.socket.close();
    await disconnected;

    const errorPayload = onceEvent<{ message: string }>(intruder.socket, "game:error");
    intruder.socket.emit("room:reconnect", { roomId, playerId: owner.playerId });
    const error = await errorPayload;

    assert.equal(error.message, "Error: UNAUTHORIZED");
  } finally {
    await closeClients([intruder]);
    await runtime.close();
  }
});
