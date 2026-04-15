import assert from "node:assert/strict";
import test from "node:test";
import { io, type Socket } from "socket.io-client";
import { bootstrapGateway } from "./gateway.js";

interface ClientHandle {
  playerId: string;
  socket: Socket;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function onceEvent<T>(socket: Socket, event: string, timeoutMs = 2000): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`TIMEOUT_WAITING_${event}`));
    }, timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
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

    await delay(200);

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

    await delay(200);

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

test("会话接管后，旧连接断开不会把玩家重新标记为 OFFLINE", async () => {
  const runtime = await bootstrapGateway(0);
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const originalP1 = await connectClient(baseUrl, "p1");
  const p2 = await connectClient(baseUrl, "p2");
  const clients: ClientHandle[] = [originalP1, p2];

  try {
    const created = onceEvent<{ roomId: string }>(originalP1.socket, "room:sync");
    originalP1.socket.emit("room:create", { gameId: "gobang", playerId: originalP1.playerId });
    const { roomId } = await created;

    const joined = onceEvent<{ roomId: string }>(p2.socket, "room:sync");
    p2.socket.emit("room:join", { roomId, playerId: p2.playerId });
    await joined;

    originalP1.socket.emit("game:ready");
    p2.socket.emit("game:ready");
    await Promise.all([onceEvent(originalP1.socket, "game:start"), onceEvent(p2.socket, "game:start")]);

    const roomSyncEvents: Array<Array<{ playerId: string; presence: string }>> = [];
    p2.socket.on("room:sync", (payload: { players: Array<{ playerId: string; presence: string }> }) => {
      roomSyncEvents.push(payload.players);
    });

    const replacement = await connectClient(baseUrl, "p1");
    clients.push(replacement);

    try {
      const syncFull = onceEvent<{ roomId: string; stateVersion: number }>(replacement.socket, "game:sync_full");
      const roomSync = onceEvent<{ players: Array<{ playerId: string; presence: string }> }>(p2.socket, "room:sync");
      replacement.socket.emit("room:reconnect", { roomId, playerId: "p1" });

      const [full, onlineState] = await Promise.all([syncFull, roomSync]);
      assert.equal(full.roomId, roomId);
      assert.equal(onlineState.players.find((player) => player.playerId === "p1")?.presence, "ONLINE");

      await delay(150);
      assert.equal(
        roomSyncEvents.some((players) => players.find((player) => player.playerId === "p1")?.presence === "OFFLINE"),
        false,
      );
    } finally {
      await closeClients([replacement]);
      clients.pop();
    }
  } finally {
    await closeClients(clients);
    await runtime.close();
  }
});

test("客户端版本落后时拒绝动作并返回全量同步", async () => {
  const runtime = await bootstrapGateway(0);
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const clients = await Promise.all(["p1", "p2"].map((playerId) => connectClient(baseUrl, playerId)));

  try {
    const [p1, p2] = clients;
    const created = onceEvent<{ roomId: string }>(p1.socket, "room:sync");
    p1.socket.emit("room:create", { gameId: "gobang", playerId: p1.playerId });
    const { roomId } = await created;

    const joined = onceEvent<{ roomId: string }>(p2.socket, "room:sync");
    p2.socket.emit("room:join", { roomId, playerId: p2.playerId });
    await joined;

    await Promise.all([onceEvent(p1.socket, "game:start"), onceEvent(p2.socket, "game:start")].map(async (startPromise, index) => {
      clients[index]?.socket.emit("game:ready");
      await startPromise;
    }));

    const p1Updates: Array<{ stateVersion: number }> = [];
    const p2Updates: Array<{ stateVersion: number }> = [];
    p1.socket.on("game:update", (payload: { stateVersion: number }) => p1Updates.push(payload));
    p2.socket.on("game:update", (payload: { stateVersion: number }) => p2Updates.push(payload));

    const syncFull = onceEvent<{ roomId: string; stateVersion: number }>(p1.socket, "game:sync_full");
    p1.socket.emit("game:action", {
      actionId: "stale_move_1",
      type: "PLACE_STONE",
      payload: { x: 0, y: 0 },
      clientTs: Date.now(),
      stateVersion: 1,
    });

    const full = await syncFull;
    assert.equal(full.roomId, roomId);
    assert.equal(full.stateVersion, 4);
    await delay(150);
    assert.equal(p1Updates.length, 0);
    assert.equal(p2Updates.length, 0);
  } finally {
    await closeClients(clients);
    await runtime.close();
  }
});

test("断线后同一玩家可重连并恢复在线状态与全量视图", async () => {
  const runtime = await bootstrapGateway(0);
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const originalP1 = await connectClient(baseUrl, "p1");
  const p2 = await connectClient(baseUrl, "p2");
  const clients: ClientHandle[] = [originalP1, p2];

  try {
    const created = onceEvent<{ roomId: string }>(originalP1.socket, "room:sync");
    originalP1.socket.emit("room:create", { gameId: "gobang", playerId: originalP1.playerId });
    const { roomId } = await created;

    const joined = onceEvent<{ roomId: string }>(p2.socket, "room:sync");
    p2.socket.emit("room:join", { roomId, playerId: p2.playerId });
    await joined;

    originalP1.socket.emit("game:ready");
    p2.socket.emit("game:ready");
    await Promise.all([onceEvent(originalP1.socket, "game:start"), onceEvent(p2.socket, "game:start")]);

    const offlineSync = onceEvent<{ players: Array<{ playerId: string; presence: string }> }>(p2.socket, "room:sync");
    const disconnected = new Promise<void>((resolve) => originalP1.socket.once("disconnect", () => resolve()));
    originalP1.socket.close();
    await disconnected;

    const offlineState = await offlineSync;
    assert.equal(offlineState.players.find((player) => player.playerId === "p1")?.presence, "OFFLINE");

    const reconnectedP1 = await connectClient(baseUrl, "p1");
    clients.push(reconnectedP1);

    try {
      const syncBack = onceEvent<{ roomId: string; stateVersion: number }>(reconnectedP1.socket, "game:sync_full");
      const roomSync = onceEvent<{ players: Array<{ playerId: string; presence: string }> }>(p2.socket, "room:sync");
      reconnectedP1.socket.emit("room:reconnect", { roomId, playerId: "p1" });

      const [full, onlineState] = await Promise.all([syncBack, roomSync]);
      assert.equal(full.roomId, roomId);
      assert.equal(typeof full.stateVersion, "number");
      assert.equal(onlineState.players.find((player) => player.playerId === "p1")?.presence, "ONLINE");
    } finally {
      await closeClients([reconnectedP1]);
      clients.pop();
    }
  } finally {
    await closeClients(clients);
    await runtime.close();
  }
});
