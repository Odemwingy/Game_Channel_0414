import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { PluginRegistry } from "./core/plugin.js";
import { RoomEngine } from "./core/room-engine.js";
import { validateSocketAuth } from "./core/auth.js";
import { writeAuditLog } from "./core/audit-log.js";
import { DoudizhuPlugin } from "./plugins/doudizhu-plugin.js";
import { GobangPlugin } from "./plugins/gobang-plugin.js";
import type { GameActionEnvelope } from "./protocol/types.js";

export interface GatewayRuntime {
  port: number;
  close(): Promise<void>;
}

interface ActiveSession {
  roomId: string;
  playerId: string;
}

function emitScopedView(
  io: Server,
  engine: RoomEngine,
  roomId: string,
  playerId: string,
  event: "game:start" | "game:update",
  payload: Record<string, unknown>,
): void {
  const socketId = engine.getPlayerSocketId(roomId, playerId);
  if (!socketId) return;
  io.to(socketId).emit(event, {
    roomId,
    playerId,
    view: engine.getPlayerView(roomId, playerId),
    ...payload,
  });
}

export async function bootstrapGateway(port = 3001): Promise<GatewayRuntime> {
  const httpServer = createServer();
  const io = new Server(httpServer, {
    cors: { origin: "*" },
    pingInterval: 30000,
    pingTimeout: 60000,
  });
  const registry = new PluginRegistry();
  registry.register(new DoudizhuPlugin());
  registry.register(new GobangPlugin());
  const engine = new RoomEngine();
  const session = new Map<string, ActiveSession>();

  function getActiveSession(socketId: string): ActiveSession | null {
    const current = session.get(socketId);
    if (!current) {
      return null;
    }
    if (engine.getPlayerSocketId(current.roomId, current.playerId) !== socketId) {
      session.delete(socketId);
      return null;
    }
    return current;
  }

  function replaceSocket(previousSocketId: string | null, nextSocketId: string, roomId: string): void {
    if (!previousSocketId || previousSocketId === nextSocketId) {
      return;
    }
    session.delete(previousSocketId);
    const previousSocket = io.sockets.sockets.get(previousSocketId);
    if (!previousSocket) {
      return;
    }
    previousSocket.leave(roomId);
    previousSocket.emit("game:error", { message: "SESSION_REPLACED" });
    previousSocket.disconnect(true);
  }

  io.on("connection", (socket) => {
    let authedPlayerId = "";
    try {
      const auth = validateSocketAuth(socket.handshake.auth);
      authedPlayerId = auth.playerId;
    } catch (e) {
      writeAuditLog("WARN", { event: "auth_failed", detail: { reason: String(e) } });
      socket.emit("game:error", { message: String(e) });
      socket.disconnect();
      return;
    }

    socket.on("room:create", ({ gameId, playerId }: { gameId: string; playerId: string }) => {
      try {
        if (playerId !== authedPlayerId) throw new Error("UNAUTHORIZED");
        const roomId = engine.createRoom(gameId, registry.get(gameId));
        const sync = engine.joinRoom(roomId, playerId, socket.id);
        socket.join(roomId);
        session.set(socket.id, { roomId, playerId });
        io.to(roomId).emit("room:sync", sync);
      } catch (e) {
        writeAuditLog("WARN", {
          event: "room_create_failed",
          playerId,
          detail: { gameId, reason: String(e) },
        });
        socket.emit("game:error", { message: String(e) });
      }
    });

    socket.on("room:join", ({ roomId, playerId }: { roomId: string; playerId: string }) => {
      try {
        if (playerId !== authedPlayerId) throw new Error("UNAUTHORIZED");
        const previousSocketId = engine.getPlayerSocketId(roomId, playerId);
        const sync = engine.joinRoom(roomId, playerId, socket.id);
        socket.join(roomId);
        session.set(socket.id, { roomId, playerId });
        replaceSocket(previousSocketId, socket.id, roomId);
        io.to(roomId).emit("room:sync", sync);
      } catch (e) {
        writeAuditLog("WARN", {
          event: "room_join_failed",
          roomId,
          playerId,
          detail: { reason: String(e) },
        });
        socket.emit("game:error", { message: String(e) });
      }
    });

    socket.on("game:ready", () => {
      const s = getActiveSession(socket.id);
      if (!s) {
        socket.emit("game:error", { message: "STALE_SESSION" });
        return;
      }
      try {
        const sync = engine.markReady(s.roomId, s.playerId);
        io.to(s.roomId).emit("room:sync", sync);
        if (sync.state === "PLAYING") {
          for (const p of sync.players) {
            emitScopedView(io, engine, s.roomId, p.playerId, "game:start", {
              stateVersion: sync.stateVersion,
            });
          }
        }
      } catch (e) {
        socket.emit("game:error", { message: String(e) });
      }
    });

    socket.on("game:action", (action: GameActionEnvelope & { stateVersion?: number }) => {
      const s = getActiveSession(socket.id);
      if (!s) {
        socket.emit("game:error", { message: "STALE_SESSION" });
        return;
      }
      try {
        const currentVersion = engine.getStateVersion(s.roomId);
        if (typeof action.stateVersion === "number" && action.stateVersion < currentVersion) {
          writeAuditLog("INFO", {
            event: "stale_action_rejected",
            roomId: s.roomId,
            playerId: s.playerId,
            detail: { actionId: action.actionId, clientVersion: action.stateVersion, serverVersion: currentVersion },
          });
          socket.emit("game:sync_full", {
            roomId: s.roomId,
            stateVersion: currentVersion,
            view: engine.getPlayerView(s.roomId, s.playerId),
          });
          return;
        }
        const out = engine.handleAction(s.roomId, s.playerId, action);
        if (!out.accepted) {
          writeAuditLog("WARN", {
            event: "action_rejected",
            roomId: s.roomId,
            playerId: s.playerId,
            detail: { actionId: action.actionId, reason: out.error },
          });
          socket.emit("game:error", { message: out.error, stateVersion: out.version });
          return;
        }
        const sync = engine.getSnapshot(s.roomId);
        for (const p of sync.players) {
          emitScopedView(io, engine, s.roomId, p.playerId, "game:update", {
            stateVersion: sync.stateVersion,
            lastAction: action,
          });
        }
        if (out.gameOver) {
          writeAuditLog("INFO", {
            event: "game_over",
            roomId: s.roomId,
            detail: { winners: out.gameOver.winners ?? [] },
          });
          io.to(s.roomId).emit("game:over", {
            roomId: s.roomId,
            winners: out.gameOver.winners ?? [],
            stateVersion: out.version,
          });
        }
      } catch (e) {
        writeAuditLog("ERROR", {
          event: "action_failed",
          roomId: s.roomId,
          playerId: s.playerId,
          detail: { reason: String(e) },
        });
        socket.emit("game:error", { message: String(e) });
      }
    });

    socket.on("room:sync_full", () => {
      const s = getActiveSession(socket.id);
      if (!s) {
        socket.emit("game:error", { message: "STALE_SESSION" });
        return;
      }
      try {
        const sync = engine.getSnapshot(s.roomId);
        socket.emit("game:sync_full", {
          roomId: s.roomId,
          stateVersion: sync.stateVersion,
          view: engine.getPlayerView(s.roomId, s.playerId),
        });
      } catch (e) {
        socket.emit("game:error", { message: String(e) });
      }
    });

    socket.on("room:leave", () => {
      const s = getActiveSession(socket.id);
      if (!s) {
        socket.emit("game:error", { message: "STALE_SESSION" });
        return;
      }
      try {
        const sync = engine.leaveRoom(s.roomId, s.playerId);
        socket.leave(s.roomId);
        session.delete(socket.id);
        io.to(s.roomId).emit("room:sync", sync);
      } catch (e) {
        socket.emit("game:error", { message: String(e) });
      }
    });

    socket.on("room:reconnect", ({ roomId, playerId }: { roomId: string; playerId: string }) => {
      try {
        if (playerId !== authedPlayerId) throw new Error("UNAUTHORIZED");
        const previousSocketId = engine.getPlayerSocketId(roomId, playerId);
        const sync = engine.reconnect(roomId, playerId, socket.id);
        socket.join(roomId);
        session.set(socket.id, { roomId, playerId });
        replaceSocket(previousSocketId, socket.id, roomId);
        socket.emit("game:sync_full", { roomId, stateVersion: sync.stateVersion, view: engine.getPlayerView(roomId, playerId) });
        io.to(roomId).emit("room:sync", sync);
      } catch (e) {
        writeAuditLog("WARN", {
          event: "reconnect_failed",
          roomId,
          playerId,
          detail: { reason: String(e) },
        });
        socket.emit("game:error", { message: String(e) });
      }
    });

    socket.on("disconnect", () => {
      const s = session.get(socket.id);
      if (!s) return;
      session.delete(socket.id);
      if (engine.getPlayerSocketId(s.roomId, s.playerId) !== socket.id) {
        return;
      }
      try {
        io.to(s.roomId).emit("room:sync", engine.markOffline(s.roomId, s.playerId));
        writeAuditLog("INFO", { event: "player_offline", roomId: s.roomId, playerId: s.playerId });
      } catch {
        // ignore
      }
    });
  });

  const offlineTicker = setInterval(() => {
    const tickEvents = engine.tick();
    for (const event of tickEvents) {
      io.to(event.roomId).emit("room:sync", event.sync);
      if (event.lastAction) {
        for (const player of event.sync.players) {
          emitScopedView(io, engine, event.roomId, player.playerId, "game:update", {
            stateVersion: event.sync.stateVersion,
            lastAction: event.lastAction,
          });
        }
      }
      if (event.gameOver) {
        io.to(event.roomId).emit("game:over", {
          roomId: event.roomId,
          winners: event.gameOver.winners ?? [],
          stateVersion: event.sync.stateVersion,
        });
      }
      if (event.idleDismissed) {
        for (const [socketId, activeSession] of session.entries()) {
          if (activeSession.roomId !== event.roomId) continue;
          session.delete(socketId);
          const activeSocket = io.sockets.sockets.get(socketId);
          activeSocket?.leave(event.roomId);
          activeSocket?.emit("game:error", { message: "ROOM_IDLE_DISMISSED", stateVersion: event.sync.stateVersion });
        }
      }
    }
  }, 5000);
  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => {
      const address = httpServer.address() as AddressInfo | null;
      const listenPort = address?.port ?? port;
      console.log(`[module-c] ws gateway on :${listenPort}`);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo | null;
  return {
    port: address?.port ?? port,
    close: async () => {
      clearInterval(offlineTicker);
      await new Promise<void>((resolve, reject) => {
        io.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
