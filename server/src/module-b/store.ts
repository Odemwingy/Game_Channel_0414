import { createHash, randomUUID } from "node:crypto";
import type { ExportBatchRecord, FlightInfo, RoomRecord, UserRecord } from "./types.js";

interface RateBucket {
  windowStartMs: number;
  count: number;
}

export class InMemoryStore {
  private readonly users = new Map<string, UserRecord>();
  private readonly usersByDeviceFp = new Map<string, string>();
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly exportBatches = new Map<string, ExportBatchRecord>();
  private readonly rateLimitBuckets = new Map<string, RateBucket>();

  private flightInfo: FlightInfo = {
    id: "flight-default",
    flightNo: "UNKNOWN",
    date: "1970-01-01",
    departure: "N/A",
    arrival: "N/A",
    status: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  registerUser(payload: { deviceFp: string; nickname: string; seatNo?: string }): UserRecord {
    const existingId = this.usersByDeviceFp.get(payload.deviceFp);
    if (existingId) {
      return this.users.get(existingId)!;
    }

    const id = randomUUID();
    const record: UserRecord = {
      id,
      flightId: this.flightInfo.id,
      nickname: payload.nickname,
      seatNo: payload.seatNo,
      deviceFp: payload.deviceFp,
      points: 0,
      createdAt: new Date().toISOString(),
    };
    this.users.set(id, record);
    this.usersByDeviceFp.set(payload.deviceFp, id);
    return record;
  }

  getUserProfile(userId: string): UserRecord | null {
    return this.users.get(userId) ?? null;
  }

  bindMember(userId: string, memberNo: string): UserRecord | null {
    const user = this.users.get(userId);
    if (!user) return null;

    const normalized = memberNo.trim().toUpperCase();
    user.memberHash = sha256(normalized);
    user.memberMasked = maskMemberNo(normalized);
    return user;
  }

  createRoom(payload: { gameId: string; ownerUserId: string }): RoomRecord {
    const room: RoomRecord = {
      id: randomUUID(),
      gameId: payload.gameId,
      ownerUserId: payload.ownerUserId,
      players: [payload.ownerUserId],
      state: "WAITING",
      createdAt: new Date().toISOString(),
    };
    this.rooms.set(room.id, room);
    return room;
  }

  listRooms(gameId?: string): RoomRecord[] {
    const all = [...this.rooms.values()];
    if (!gameId) return all;
    return all.filter((room) => room.gameId === gameId);
  }

  joinRoom(roomId: string, userId: string): RoomRecord | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    if (!room.players.includes(userId)) {
      room.players.push(userId);
    }
    return room;
  }

  leaveRoom(roomId: string, userId: string): RoomRecord | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.players = room.players.filter((id) => id !== userId);
    if (room.players.length === 0) {
      room.state = "DISMISSED";
    }
    return room;
  }

  getGames(): Array<{ id: string; name: string; mode: "solo" | "multiplayer" | "both" }> {
    return [
      { id: "gobang", name: "五子棋", mode: "both" },
      { id: "doudizhu", name: "斗地主", mode: "multiplayer" },
    ];
  }

  getGameDetail(gameId: string): { id: string; name: string; mode: "solo" | "multiplayer" | "both" } | null {
    return this.getGames().find((game) => game.id === gameId) ?? null;
  }

  initFlight(payload: { id: string; flightNo: string; date: string; departure: string; arrival: string }): FlightInfo {
    if (this.flightInfo.status !== "idle") {
      throw new Error("FLIGHT_STATE_INVALID");
    }
    const now = new Date().toISOString();
    this.flightInfo = {
      id: payload.id,
      flightNo: payload.flightNo,
      date: payload.date,
      departure: payload.departure,
      arrival: payload.arrival,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    return this.flightInfo;
  }

  completeFlight(): FlightInfo {
    if (this.flightInfo.status !== "active") {
      throw new Error("FLIGHT_STATE_INVALID");
    }
    this.flightInfo = {
      ...this.flightInfo,
      status: "completed",
      updatedAt: new Date().toISOString(),
    };
    return this.flightInfo;
  }

  exportFlight(): ExportBatchRecord {
    if (this.flightInfo.status !== "completed" && this.flightInfo.status !== "exported") {
      throw new Error("FLIGHT_STATE_INVALID");
    }

    const existing = [...this.exportBatches.values()].find(
      (batch) => batch.flightId === this.flightInfo.id && batch.status === "success",
    );
    if (existing) {
      this.flightInfo = {
        ...this.flightInfo,
        status: "exported",
        updatedAt: new Date().toISOString(),
      };
      return existing;
    }

    const createdAt = new Date().toISOString();
    const batch: ExportBatchRecord = {
      id: randomUUID(),
      flightId: this.flightInfo.id,
      exportType: "member_credit",
      status: "success",
      filePath: `/app/data/exports/${this.flightInfo.id}.json`,
      checksum: sha256(`${this.flightInfo.id}:${createdAt}`),
      createdAt,
    };
    this.exportBatches.set(batch.id, batch);
    this.flightInfo = {
      ...this.flightInfo,
      status: "exported",
      updatedAt: new Date().toISOString(),
    };
    return batch;
  }

  resetFlight(): FlightInfo {
    if (this.flightInfo.status !== "completed" && this.flightInfo.status !== "exported") {
      throw new Error("FLIGHT_STATE_INVALID");
    }
    this.flightInfo = {
      id: "flight-default",
      flightNo: "UNKNOWN",
      date: "1970-01-01",
      departure: "N/A",
      arrival: "N/A",
      status: "idle",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return this.flightInfo;
  }

  getStats(): { onlineRooms: number; totalUsers: number; exportBatches: number; flightStatus: string } {
    return {
      onlineRooms: [...this.rooms.values()].filter((room) => room.state !== "DISMISSED").length,
      totalUsers: this.users.size,
      exportBatches: this.exportBatches.size,
      flightStatus: this.flightInfo.status,
    };
  }

  checkRateLimit(key: string, nowMs: number, windowMs: number, maxCount: number): boolean {
    const bucket = this.rateLimitBuckets.get(key);
    if (!bucket || nowMs - bucket.windowStartMs >= windowMs) {
      this.rateLimitBuckets.set(key, {
        windowStartMs: nowMs,
        count: 1,
      });
      return true;
    }
    if (bucket.count >= maxCount) {
      return false;
    }
    bucket.count += 1;
    return true;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function maskMemberNo(value: string): string {
  if (value.length <= 4) {
    return `${value[0] ?? "*"}***`;
  }
  const prefix = value.slice(0, 2);
  const suffix = value.slice(-2);
  return `${prefix}${"*".repeat(Math.max(4, value.length - 4))}${suffix}`;
}
