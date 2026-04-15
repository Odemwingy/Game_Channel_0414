import { randomUUID } from "node:crypto";
import type { GameLogicPlugin } from "./plugin.js";
import type { GameActionEnvelope, PlayerSession, RoomState, RoomSyncPayload } from "../protocol/types.js";

interface RoomRuntime {
  roomId: string;
  gameId: string;
  plugin: GameLogicPlugin;
  state: RoomState;
  stateVersion: number;
  players: Map<string, PlayerSession>;
  gameState: unknown;
  dedup: Map<string, { accepted: boolean; error?: string; version: number }>;
}

export interface ActionOutcome {
  accepted: boolean;
  error?: string;
  version: number;
  currentVersion?: number;
  gameOver?: {
    winners?: string[];
  };
}

export class RoomEngine {
  private readonly rooms = new Map<string, RoomRuntime>();
  private readonly offlineGraceMs = 120_000;

  createRoom(gameId: string, plugin: GameLogicPlugin): string {
    const roomId = randomUUID();
    this.rooms.set(roomId, {
      roomId,
      gameId,
      plugin,
      state: "WAITING",
      stateVersion: 0,
      players: new Map(),
      gameState: null,
      dedup: new Map(),
    });
    return roomId;
  }

  joinRoom(roomId: string, playerId: string, socketId: string): RoomSyncPayload {
    const room = this.mustRoom(roomId);
    const existingPlayer = room.players.get(playerId);
    if (!existingPlayer && room.players.size >= room.plugin.maxPlayers) {
      throw new Error("ROOM_FULL");
    }

    const now = Date.now();
    if (existingPlayer) {
      if (existingPlayer.socketId === socketId && existingPlayer.presence === "ONLINE") {
        existingPlayer.lastSeenAt = now;
        return this.sync(room);
      }

      room.players.set(playerId, {
        ...existingPlayer,
        socketId,
        presence: "ONLINE",
        lastSeenAt: now,
      });
      room.stateVersion += 1;
      return this.sync(room);
    }

    room.players.set(playerId, {
      playerId,
      socketId,
      presence: "ONLINE",
      ready: false,
      lastSeenAt: now,
    });
    room.stateVersion += 1;
    return this.sync(room);
  }

  leaveRoom(roomId: string, playerId: string): RoomSyncPayload {
    const room = this.mustRoom(roomId);
    room.players.delete(playerId);
    if (room.players.size === 0) {
      room.state = "DISMISSED";
    }
    room.stateVersion += 1;
    return this.sync(room);
  }

  markReady(roomId: string, playerId: string): RoomSyncPayload {
    const room = this.mustRoom(roomId);
    const p = room.players.get(playerId);
    if (!p) throw new Error("PLAYER_NOT_IN_ROOM");

    if (room.state === "PLAYING" || p.ready) {
      return this.sync(room);
    }

    if (room.state === "SETTLED") {
      room.state = "WAITING";
      room.gameState = null;
    }

    p.ready = true;
    if (room.state === "WAITING" && room.players.size >= room.plugin.minPlayers && [...room.players.values()].every((x) => x.ready)) {
      room.state = "PLAYING";
      room.gameState = room.plugin.onGameStart([...room.players.keys()]);
    }
    room.stateVersion += 1;
    return this.sync(room);
  }

  handleAction(roomId: string, playerId: string, action: GameActionEnvelope): ActionOutcome {
    const room = this.mustRoom(roomId);
    const key = `${roomId}:${playerId}:${action.actionId}`;
    const cached = room.dedup.get(key);
    if (cached) return cached;
    if (room.state !== "PLAYING" || room.gameState == null) {
      const result = { accepted: false, error: "GAME_NOT_PLAYING", version: room.stateVersion };
      room.dedup.set(key, result);
      return result;
    }
    const result = room.plugin.onPlayerAction(room.gameState, playerId, action);
    if (!result.valid || !result.newState) {
      const rejected = { accepted: false, error: result.error ?? "INVALID_ACTION", version: room.stateVersion };
      room.dedup.set(key, rejected);
      return rejected;
    }
    room.gameState = result.newState;
    room.stateVersion += 1;
    const overResult = room.plugin.isGameOver(room.gameState);
    if (overResult.isOver) {
      room.state = "SETTLED";
      for (const player of room.players.values()) {
        player.ready = false;
      }
    }
    const accepted = {
      accepted: true,
      version: room.stateVersion,
      gameOver: overResult.isOver ? { winners: overResult.winners } : undefined,
    };
    room.dedup.set(key, accepted);
    return accepted;
  }

  getStateVersion(roomId: string): number {
    return this.mustRoom(roomId).stateVersion;
  }

  markOffline(roomId: string, playerId: string): RoomSyncPayload {
    const room = this.mustRoom(roomId);
    const p = room.players.get(playerId);
    if (!p) throw new Error("PLAYER_NOT_IN_ROOM");
    p.presence = "OFFLINE";
    p.lastSeenAt = Date.now();
    room.stateVersion += 1;
    return this.sync(room);
  }

  reconnect(roomId: string, playerId: string, socketId: string): RoomSyncPayload {
    const room = this.mustRoom(roomId);
    const p = room.players.get(playerId);
    if (!p) throw new Error("PLAYER_NOT_IN_ROOM");
    p.socketId = socketId;
    p.presence = "ONLINE";
    p.lastSeenAt = Date.now();
    room.stateVersion += 1;
    return this.sync(room);
  }

  getPlayerView(roomId: string, playerId: string): unknown {
    const room = this.mustRoom(roomId);
    if (room.gameState == null) return null;
    return room.plugin.getPlayerView(room.gameState, playerId);
  }

  getPlayerSocketId(roomId: string, playerId: string): string | null {
    const room = this.mustRoom(roomId);
    return room.players.get(playerId)?.socketId ?? null;
  }

  getSnapshot(roomId: string): RoomSyncPayload {
    return this.sync(this.mustRoom(roomId));
  }

  tickOfflineFallback(now = Date.now()): void {
    for (const room of this.rooms.values()) {
      if (room.state !== "PLAYING" || room.gameState == null) continue;
      for (const p of room.players.values()) {
        if (p.presence !== "OFFLINE" || now - p.lastSeenAt < this.offlineGraceMs) continue;
        const fallback = room.plugin.fallbackAction?.(room.gameState, p.playerId);
        if (fallback) this.handleAction(room.roomId, p.playerId, fallback);
      }
    }
  }

  private mustRoom(roomId: string): RoomRuntime {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("ROOM_NOT_FOUND");
    return room;
  }

  private sync(room: RoomRuntime): RoomSyncPayload {
    return {
      roomId: room.roomId,
      gameId: room.gameId,
      state: room.state,
      stateVersion: room.stateVersion,
      players: [...room.players.values()].map((p, seatIndex) => ({
        playerId: p.playerId,
        seatIndex,
        presence: p.presence,
        ready: p.ready,
      })),
    };
  }
}
