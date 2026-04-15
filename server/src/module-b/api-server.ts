import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { URL } from "node:url";
import { InMemoryStore } from "./store.js";
import type { ApiErrorBody } from "./types.js";

export interface ApiServerRuntime {
  port: number;
  close(): Promise<void>;
}

interface RequestContext {
  requestId: string;
  userId?: string;
}

export async function bootstrapApiServer(port = 3000): Promise<ApiServerRuntime> {
  const store = new InMemoryStore();
  const server = createServer(async (req, res) => {
    const requestId = `req_${randomUUID()}`;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("x-request-id", requestId);

    try {
      await handleRequest(req, res, { requestId }, store);
    } catch (error) {
      if (error instanceof JsonBodyParseError) {
        writeError(res, 400, {
          code: "BAD_REQUEST",
          message: "Malformed JSON body",
          requestId,
        });
        return;
      }
      if (error instanceof ValidationError) {
        writeError(res, 400, {
          code: "BAD_REQUEST",
          message: error.message,
          requestId,
        });
        return;
      }
      if (error instanceof ConflictError) {
        writeError(res, 409, {
          code: error.code,
          message: error.message,
          requestId,
        });
        return;
      }
      if (error instanceof ForbiddenError) {
        writeError(res, 403, {
          code: error.code,
          message: error.message,
          requestId,
        });
        return;
      }
      if (error instanceof NotFoundError) {
        writeError(res, 404, {
          code: error.code,
          message: error.message,
          requestId,
        });
        return;
      }
      writeError(res, 500, {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "INTERNAL_ERROR",
        requestId,
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, () => {
      const address = server.address() as { port: number } | null;
      const listenPort = address?.port ?? port;
      // eslint-disable-next-line no-console
      console.log(`[module-b] api server on :${listenPort}`);
      resolve();
    });
  });

  const address = server.address() as { port: number } | null;
  return {
    port: address?.port ?? port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: RequestContext,
  store: InMemoryStore,
): Promise<void> {
  if (!req.url || !req.method) {
    throw new ValidationError("INVALID_REQUEST");
  }

  const ip = getRemoteAddress(req.socket);
  const rateKey = `${ip}:${req.method}:${req.url}`;
  if (!store.checkRateLimit(rateKey, Date.now(), 60_000, 120)) {
    writeError(res, 429, {
      code: "RATE_LIMITED",
      message: "TOO_MANY_REQUESTS",
      requestId: context.requestId,
    });
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const method = req.method.toUpperCase();
  const path = url.pathname;

  if (method === "GET" && path === "/healthz") {
    writeJson(res, 200, { ok: true, requestId: context.requestId });
    return;
  }

  if (!path.startsWith("/api/v1/")) {
    throw new NotFoundError("NOT_FOUND", "ROUTE_NOT_FOUND");
  }

  if (method === "POST" && path === "/api/v1/user/register") {
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body.deviceFp !== "string" || typeof body.nickname !== "string") {
      throw new ValidationError("deviceFp and nickname are required");
    }
    const user = store.registerUser({
      deviceFp: body.deviceFp,
      nickname: body.nickname,
      seatNo: typeof body.seatNo === "string" ? body.seatNo : undefined,
    });
    writeJson(res, 200, { data: user, requestId: context.requestId });
    return;
  }

  const authed = withBearerAuth(req, context);
  if (!authed.ok) {
    writeError(res, authed.status, authed.error);
    return;
  }
  const authContext: RequestContext = { ...context, userId: authed.userId };

  if (method === "GET" && path === "/api/v1/user/profile") {
    const user = store.getUserProfile(authContext.userId!);
    if (!user) {
      throw new NotFoundError("USER_NOT_FOUND", "USER_NOT_FOUND");
    }
    writeJson(res, 200, { data: user, requestId: authContext.requestId });
    return;
  }

  if (method === "POST" && path === "/api/v1/user/bind-member") {
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body.memberNo !== "string" || body.memberNo.trim().length < 4) {
      throw new ValidationError("memberNo is invalid");
    }
    const bound = store.bindMember(authContext.userId!, body.memberNo);
    if (!bound) {
      throw new NotFoundError("USER_NOT_FOUND", "USER_NOT_FOUND");
    }
    writeJson(res, 200, {
      data: {
        userId: bound.user.id,
        memberMasked: bound.user.memberMasked,
        points: bound.user.points,
        bonus: {
          amount: bound.bonusLog.amount,
          idempotent: bound.bonusIdempotent,
          capped: bound.bonusLog.capped,
          reason: bound.bonusLog.reason,
          sessionId: bound.bonusLog.sessionId,
          createdAt: bound.bonusLog.createdAt,
        },
      },
      requestId: authContext.requestId,
    });
    return;
  }

  if (method === "GET" && path === "/api/v1/points/rules") {
    writeJson(res, 200, { data: store.getPointRules(), requestId: authContext.requestId });
    return;
  }

  if (method === "GET" && path === "/api/v1/points/history") {
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : 50;
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new ValidationError("limit must be a positive number");
    }
    writeJson(res, 200, {
      data: store.getPointHistory(authContext.userId!, limit),
      requestId: authContext.requestId,
    });
    return;
  }

  if (method === "POST" && path === "/api/v1/points/settle") {
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body.sessionId !== "string" || typeof body.reason !== "string") {
      throw new ValidationError("sessionId and reason are required");
    }
    if (body.sessionId.trim().length === 0 || body.reason.trim().length === 0) {
      throw new ValidationError("sessionId and reason are required");
    }
    if (body.amount !== undefined && (typeof body.amount !== "number" || !Number.isFinite(body.amount))) {
      throw new ValidationError("amount must be a number");
    }
    const reasonRule = store.getPointReason(body.reason);
    if (!reasonRule) {
      throw new ValidationError("reason is invalid");
    }
    if (reasonRule.adminOnly && !isAdminUser(authContext.userId!)) {
      throw new ForbiddenError("FORBIDDEN", "reason requires admin role");
    }
    const user = store.getUserProfile(authContext.userId!);
    if (!user) {
      throw new NotFoundError("USER_NOT_FOUND", "USER_NOT_FOUND");
    }
    const result = store.settlePoints({
      userId: user.id,
      sessionId: body.sessionId,
      reason: body.reason,
      amount: typeof body.amount === "number" ? body.amount : undefined,
    });
    writeJson(res, 200, {
      data: {
        userId: result.user.id,
        points: result.user.points,
        idempotent: result.idempotent,
        log: result.log,
      },
      requestId: authContext.requestId,
    });
    return;
  }

  if (method === "GET" && path === "/api/v1/games") {
    writeJson(res, 200, { data: store.getGames(), requestId: authContext.requestId });
    return;
  }

  if (method === "GET" && path.startsWith("/api/v1/games/")) {
    const gameId = path.split("/").at(-1) ?? "";
    const game = store.getGameDetail(gameId);
    if (!game) {
      throw new NotFoundError("GAME_NOT_FOUND", "GAME_NOT_FOUND");
    }
    writeJson(res, 200, { data: game, requestId: authContext.requestId });
    return;
  }

  if (method === "GET" && path === "/api/v1/rooms") {
    const gameId = url.searchParams.get("gameId") ?? undefined;
    writeJson(res, 200, { data: store.listRooms(gameId), requestId: authContext.requestId });
    return;
  }

  if (method === "POST" && path === "/api/v1/rooms") {
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body.gameId !== "string") {
      throw new ValidationError("gameId is required");
    }
    const room = store.createRoom({ gameId: body.gameId, ownerUserId: authContext.userId! });
    writeJson(res, 201, { data: room, requestId: authContext.requestId });
    return;
  }

  if (method === "POST" && path.startsWith("/api/v1/rooms/") && path.endsWith("/join")) {
    const roomId = path.split("/")[4];
    if (!roomId) {
      throw new ValidationError("roomId is invalid");
    }
    const room = store.joinRoom(roomId, authContext.userId!);
    if (!room) {
      throw new NotFoundError("ROOM_NOT_FOUND", "ROOM_NOT_FOUND");
    }
    writeJson(res, 200, { data: room, requestId: authContext.requestId });
    return;
  }

  if (method === "DELETE" && path.startsWith("/api/v1/rooms/") && path.endsWith("/leave")) {
    const roomId = path.split("/")[4];
    if (!roomId) {
      throw new ValidationError("roomId is invalid");
    }
    const room = store.leaveRoom(roomId, authContext.userId!);
    if (!room) {
      throw new NotFoundError("ROOM_NOT_FOUND", "ROOM_NOT_FOUND");
    }
    writeJson(res, 200, { data: room, requestId: authContext.requestId });
    return;
  }

  if (method === "POST" && path === "/api/v1/admin/flight/init") {
    const body = await readJsonBody(req);
    if (
      !isRecord(body) ||
      typeof body.id !== "string" ||
      typeof body.flightNo !== "string" ||
      typeof body.date !== "string" ||
      typeof body.departure !== "string" ||
      typeof body.arrival !== "string"
    ) {
      throw new ValidationError("flight payload is invalid");
    }
    try {
      const flight = store.initFlight({
        id: body.id,
        flightNo: body.flightNo,
        date: body.date,
        departure: body.departure,
        arrival: body.arrival,
      });
      writeJson(res, 200, { data: flight, requestId: authContext.requestId });
    } catch (error) {
      throw new ConflictError("FLIGHT_STATE_INVALID", error instanceof Error ? error.message : "FLIGHT_STATE_INVALID");
    }
    return;
  }

  if (method === "POST" && path === "/api/v1/admin/flight/complete") {
    try {
      writeJson(res, 200, { data: store.completeFlight(), requestId: authContext.requestId });
    } catch (error) {
      throw new ConflictError("FLIGHT_STATE_INVALID", error instanceof Error ? error.message : "FLIGHT_STATE_INVALID");
    }
    return;
  }

  if (method === "GET" && path === "/api/v1/admin/flight/export") {
    try {
      writeJson(res, 200, { data: store.exportFlight(), requestId: authContext.requestId });
    } catch (error) {
      throw new ConflictError("FLIGHT_STATE_INVALID", error instanceof Error ? error.message : "FLIGHT_STATE_INVALID");
    }
    return;
  }

  if (method === "POST" && path === "/api/v1/admin/flight/reset") {
    try {
      writeJson(res, 200, { data: store.resetFlight(), requestId: authContext.requestId });
    } catch (error) {
      throw new ConflictError("FLIGHT_STATE_INVALID", error instanceof Error ? error.message : "FLIGHT_STATE_INVALID");
    }
    return;
  }

  if (method === "GET" && path === "/api/v1/admin/stats") {
    writeJson(res, 200, { data: store.getStats(), requestId: authContext.requestId });
    return;
  }

  if (method === "POST" && path === "/api/v1/admin/points/grant") {
    if (!isAdminUser(authContext.userId!)) {
      throw new ForbiddenError("FORBIDDEN", "admin role required");
    }
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body.userId !== "string" || typeof body.amount !== "number") {
      throw new ValidationError("userId and amount are required");
    }
    if (body.userId.trim().length === 0 || !Number.isFinite(body.amount) || body.amount < 0) {
      throw new ValidationError("userId and amount are invalid");
    }
    const user = store.getUserProfile(body.userId);
    if (!user) {
      throw new NotFoundError("USER_NOT_FOUND", "USER_NOT_FOUND");
    }
    const reason = typeof body.reason === "string" && body.reason.trim().length > 0 ? body.reason : "OPS_GRANT";
    const reasonRule = store.getPointReason(reason);
    if (!reasonRule) {
      throw new ValidationError("reason is invalid");
    }
    const sessionId =
      typeof body.sessionId === "string" && body.sessionId.trim().length > 0
        ? body.sessionId
        : `ops-grant:${Date.now()}:${body.userId}`;
    const result = store.settlePoints({
      userId: user.id,
      sessionId,
      reason,
      amount: body.amount,
    });
    writeJson(res, 200, {
      data: {
        userId: result.user.id,
        points: result.user.points,
        idempotent: result.idempotent,
        log: result.log,
      },
      requestId: authContext.requestId,
    });
    return;
  }

  throw new NotFoundError("NOT_FOUND", "ROUTE_NOT_FOUND");
}

function withBearerAuth(
  req: IncomingMessage,
  context: RequestContext,
):
  | { ok: true; userId: string }
  | { ok: false; status: number; error: ApiErrorBody } {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      error: {
        code: "UNAUTHORIZED",
        message: "Authorization Bearer token is required",
        requestId: context.requestId,
      },
    };
  }
  const token = auth.slice("Bearer ".length).trim();
  if (token.startsWith("dev_user_")) {
    return {
      ok: true,
      userId: token.slice("dev_user_".length),
    };
  }
  if (token.startsWith("dev_")) {
    return {
      ok: true,
      userId: token.slice("dev_".length),
    };
  }
  return {
    ok: false,
    status: 401,
    error: {
      code: "UNAUTHORIZED",
      message: "Invalid token",
      requestId: context.requestId,
    },
  };
}

function writeJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode;
  res.end(JSON.stringify(data));
}

function writeError(res: ServerResponse, statusCode: number, body: ApiErrorBody): void {
  writeJson(res, statusCode, body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new JsonBodyParseError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getRemoteAddress(socket: Socket): string {
  return socket.remoteAddress ?? "unknown";
}

function isAdminUser(userId: string): boolean {
  return userId === "admin";
}

class JsonBodyParseError extends Error {}

class ValidationError extends Error {}

class ConflictError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class ForbiddenError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class NotFoundError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
