import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  ExportBatchRecord,
  FlightInfo,
  MemberSyncExportPayload,
  PointLogRecord,
  PointReasonRule,
  PointsCaps,
  PointsRulesSnapshot,
  RoomRecord,
  UserRecord,
} from "./types.js";

interface RateBucket {
  windowStartMs: number;
  count: number;
}

interface SettlePointsPayload {
  userId: string;
  sessionId: string;
  reason: string;
  amount?: number;
  createdAt?: string;
}

interface SettlePointsResult {
  user: UserRecord;
  log: PointLogRecord;
  idempotent: boolean;
}

interface RawReasonRule {
  description?: unknown;
  points?: unknown;
  adminOnly?: unknown;
}

interface RawPointsRulesFile {
  version?: unknown;
  caps?: {
    perSession?: unknown;
    perDay?: unknown;
    perFlight?: unknown;
  };
  reasons?: Record<string, RawReasonRule>;
}

interface LoadedPointsRules {
  snapshot: PointsRulesSnapshot;
  reasonMap: Map<string, PointReasonRule>;
}

const DEFAULT_POINTS_RULES = {
  version: "2026.04.1",
  caps: {
    perSession: 200,
    perDay: 500,
    perFlight: 1200,
  },
  reasons: [
    {
      reason: "GAME_PLAY",
      description: "完成一局对局",
      points: 20,
    },
    {
      reason: "GAME_WIN",
      description: "获胜奖励",
      points: 50,
    },
    {
      reason: "MEMBER_BIND_BONUS",
      description: "会员绑定奖励",
      points: 100,
    },
    {
      reason: "OPS_GRANT",
      description: "运营补发",
      points: 0,
      adminOnly: true,
    },
  ] satisfies PointReasonRule[],
};

export class InMemoryStore {
  private readonly users = new Map<string, UserRecord>();
  private readonly usersByDeviceFp = new Map<string, string>();
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly exportBatches = new Map<string, ExportBatchRecord>();
  private readonly exportPayloads = new Map<string, MemberSyncExportPayload>();
  private readonly rateLimitBuckets = new Map<string, RateBucket>();
  private readonly pointLogs = new Map<string, PointLogRecord>();
  private readonly pointDedup = new Map<string, string>();
  private readonly pointsRules: PointsRulesSnapshot;
  private readonly pointReasons: Map<string, PointReasonRule>;
  private readonly pointsPerMile: number;

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

  constructor() {
    const loaded = loadPointsRules();
    this.pointsRules = loaded.snapshot;
    this.pointReasons = loaded.reasonMap;
    this.pointsPerMile = normalizePositiveInt(Number(process.env.POINTS_PER_MILE ?? 10), 10);
  }

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

  bindMember(
    userId: string,
    memberNo: string,
  ): {
    user: UserRecord;
    bonusLog: PointLogRecord;
    bonusIdempotent: boolean;
  } | null {
    const user = this.users.get(userId);
    if (!user) return null;

    const normalized = memberNo.trim().toUpperCase();
    user.memberHash = sha256(normalized);
    user.memberMasked = maskMemberNo(normalized);

    const bonus = this.settlePoints({
      userId,
      sessionId: `member-bind:${userId}`,
      reason: "MEMBER_BIND_BONUS",
    });
    return {
      user,
      bonusLog: bonus.log,
      bonusIdempotent: bonus.idempotent,
    };
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

  getPointRules(): PointsRulesSnapshot {
    return this.pointsRules;
  }

  getPointReason(reason: string): PointReasonRule | null {
    return this.pointReasons.get(reason) ?? null;
  }

  getPointHistory(userId: string, limit = 50): PointLogRecord[] {
    const normalizedLimit = Math.min(Math.max(1, Math.floor(limit)), 200);
    return [...this.pointLogs.values()]
      .filter((log) => log.userId === userId)
      .sort((a, b) => Number(new Date(b.createdAt)) - Number(new Date(a.createdAt)))
      .slice(0, normalizedLimit);
  }

  settlePoints(payload: SettlePointsPayload): SettlePointsResult {
    const user = this.users.get(payload.userId);
    if (!user) {
      throw new Error("USER_NOT_FOUND");
    }
    const reasonRule = this.pointReasons.get(payload.reason);
    if (!reasonRule) {
      throw new Error("POINT_REASON_INVALID");
    }
    const createdAt = payload.createdAt ?? new Date().toISOString();
    const dedupKey = `${user.flightId}:${payload.userId}:${payload.sessionId}:${payload.reason}`;
    const existingLogId = this.pointDedup.get(dedupKey);
    if (existingLogId) {
      const existing = this.pointLogs.get(existingLogId);
      if (existing) {
        return {
          user,
          log: existing,
          idempotent: true,
        };
      }
      this.pointDedup.delete(dedupKey);
    }

    const requestedAmount = normalizePoints(payload.amount ?? reasonRule.points);
    const amount = this.applyPointsCap({
      user,
      sessionId: payload.sessionId,
      requestedAmount,
      createdAt,
    });
    const log: PointLogRecord = {
      id: randomUUID(),
      flightId: user.flightId,
      userId: payload.userId,
      sessionId: payload.sessionId,
      reason: payload.reason,
      amount,
      ruleVersion: this.pointsRules.version,
      capped: amount < requestedAmount,
      createdAt,
    };
    this.pointLogs.set(log.id, log);
    this.pointDedup.set(dedupKey, log.id);
    user.points += log.amount;
    return {
      user,
      log,
      idempotent: false,
    };
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
      this.ensureExportPayload(existing);
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
    this.exportPayloads.set(batch.id, this.buildExportPayload(batch));
    this.flightInfo = {
      ...this.flightInfo,
      status: "exported",
      updatedAt: new Date().toISOString(),
    };
    return batch;
  }

  getExportData(batchId: string): MemberSyncExportPayload | null {
    if (!this.exportBatches.has(batchId)) {
      return null;
    }
    const payload = this.exportPayloads.get(batchId);
    if (payload) {
      return payload;
    }
    const batch = this.exportBatches.get(batchId)!;
    const generated = this.buildExportPayload(batch);
    this.exportPayloads.set(batchId, generated);
    return generated;
  }

  resetFlight(): FlightInfo {
    if (this.flightInfo.status !== "completed" && this.flightInfo.status !== "exported") {
      throw new Error("FLIGHT_STATE_INVALID");
    }
    this.users.clear();
    this.usersByDeviceFp.clear();
    this.rooms.clear();
    this.exportBatches.clear();
    this.exportPayloads.clear();
    this.pointLogs.clear();
    this.pointDedup.clear();
    this.rateLimitBuckets.clear();
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

  getStats(): { onlineRooms: number; totalUsers: number; exportBatches: number; pointLogs: number; flightStatus: string } {
    return {
      onlineRooms: [...this.rooms.values()].filter((room) => room.state !== "DISMISSED").length,
      totalUsers: this.users.size,
      exportBatches: this.exportBatches.size,
      pointLogs: this.pointLogs.size,
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

  private applyPointsCap(payload: {
    user: UserRecord;
    sessionId: string;
    requestedAmount: number;
    createdAt: string;
  }): number {
    if (payload.requestedAmount <= 0) {
      return 0;
    }
    const caps = this.pointsRules.caps;
    const sessionUsed = this.sumPoints((log) => log.userId === payload.user.id && log.sessionId === payload.sessionId);
    const dayStart = dayStartIso(payload.createdAt);
    const dayUsed = this.sumPoints(
      (log) =>
        log.userId === payload.user.id &&
        Number(new Date(log.createdAt)) >= Number(new Date(dayStart)) &&
        Number(new Date(log.createdAt)) < Number(new Date(dayStart)) + 24 * 60 * 60 * 1000,
    );
    const flightUsed = this.sumPoints((log) => log.userId === payload.user.id && log.flightId === payload.user.flightId);

    const amount = Math.min(
      payload.requestedAmount,
      Math.max(0, caps.perSession - sessionUsed),
      Math.max(0, caps.perDay - dayUsed),
      Math.max(0, caps.perFlight - flightUsed),
    );
    return Math.max(0, amount);
  }

  private sumPoints(filter: (log: PointLogRecord) => boolean): number {
    let total = 0;
    for (const log of this.pointLogs.values()) {
      if (!filter(log)) continue;
      total += log.amount;
    }
    return total;
  }

  private ensureExportPayload(batch: ExportBatchRecord): void {
    if (this.exportPayloads.has(batch.id)) {
      return;
    }
    this.exportPayloads.set(batch.id, this.buildExportPayload(batch));
  }

  private buildExportPayload(batch: ExportBatchRecord): MemberSyncExportPayload {
    const records = [...this.users.values()]
      .filter((user) => Boolean(user.memberHash && user.memberMasked))
      .map((user) => {
        const details = [...this.pointLogs.values()]
          .filter((log) => log.userId === user.id)
          .sort((a, b) => Number(new Date(a.createdAt)) - Number(new Date(b.createdAt)))
          .map((log) => ({
            sessionId: log.sessionId,
            reason: log.reason,
            amount: log.amount,
            createdAt: log.createdAt,
          }));
        const totalPoints = details.reduce((acc, detail) => acc + detail.amount, 0);
        return {
          mappedUserId: sha256(`${this.flightInfo.id}:${user.id}`).slice(0, 16),
          memberMasked: user.memberMasked!,
          memberHash: user.memberHash!,
          totalPoints,
          mileage: Math.floor(totalPoints / this.pointsPerMile),
          details,
        };
      });

    const totalPoints = records.reduce((acc, record) => acc + record.totalPoints, 0);
    const totalMileage = records.reduce((acc, record) => acc + record.mileage, 0);
    return {
      batchId: batch.id,
      flight: {
        id: this.flightInfo.id,
        flightNo: this.flightInfo.flightNo,
        date: this.flightInfo.date,
        departure: this.flightInfo.departure,
        arrival: this.flightInfo.arrival,
      },
      rules: {
        pointsPerMile: this.pointsPerMile,
        ruleVersion: this.pointsRules.version,
      },
      summary: {
        totalUsers: records.length,
        totalPoints,
        totalMileage,
        skippedUsers: this.users.size - records.length,
      },
      records,
      generatedAt: batch.createdAt,
    };
  }
}

function loadPointsRules(): LoadedPointsRules {
  const candidates = [
    process.env.POINTS_RULES_PATH,
    "/app/config/points.json",
    path.resolve(process.cwd(), "config/points.json"),
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim().length > 0));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as RawPointsRulesFile;
      return normalizePointsRules(parsed, candidate);
    } catch {
      // ignore invalid file and continue fallback
    }
  }
  return normalizePointsRules({}, "builtin-default");
}

function normalizePointsRules(raw: RawPointsRulesFile, loadedFrom: string): LoadedPointsRules {
  const caps: PointsCaps = {
    perSession: normalizePositiveInt(raw.caps?.perSession, DEFAULT_POINTS_RULES.caps.perSession),
    perDay: normalizePositiveInt(raw.caps?.perDay, DEFAULT_POINTS_RULES.caps.perDay),
    perFlight: normalizePositiveInt(raw.caps?.perFlight, DEFAULT_POINTS_RULES.caps.perFlight),
  };
  const reasons = normalizeReasons(raw.reasons);
  const snapshot: PointsRulesSnapshot = {
    version: typeof raw.version === "string" && raw.version.trim().length > 0 ? raw.version : DEFAULT_POINTS_RULES.version,
    loadedFrom,
    caps,
    reasons,
  };
  return {
    snapshot,
    reasonMap: new Map(snapshot.reasons.map((reason) => [reason.reason, reason])),
  };
}

function normalizeReasons(raw?: Record<string, RawReasonRule>): PointReasonRule[] {
  if (!raw || typeof raw !== "object") {
    return [...DEFAULT_POINTS_RULES.reasons];
  }
  const normalized: PointReasonRule[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const reason = key.trim();
    if (!reason) continue;
    const points = normalizePoints(value.points);
    const description =
      typeof value.description === "string" && value.description.trim().length > 0
        ? value.description
        : `${reason} 积分规则`;
    normalized.push({
      reason,
      points,
      description,
      adminOnly: Boolean(value.adminOnly),
    });
  }
  if (normalized.length === 0) {
    return [...DEFAULT_POINTS_RULES.reasons];
  }
  return normalized;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizePoints(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function dayStartIso(value: string): string {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
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
