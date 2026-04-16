import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapApiServer } from "./api-server.js";

interface HttpResponse<T = unknown> {
  status: number;
  requestId: string;
  body: T;
}

async function withApiServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const runtime = await bootstrapApiServer(0);
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  try {
    await run(baseUrl);
  } finally {
    await runtime.close();
  }
}

async function jsonRequest<T = unknown>(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    rawBody?: string;
  } = {},
): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined || options.rawBody !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body:
      options.rawBody !== undefined
        ? options.rawBody
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
  });

  const requestId = response.headers.get("x-request-id") ?? "";
  const bodyText = await response.text();
  return {
    status: response.status,
    requestId,
    body: bodyText ? (JSON.parse(bodyText) as T) : ({} as T),
  };
}

test("healthz 返回请求追踪信息", async () => {
  await withApiServer(async (baseUrl) => {
    const response = await jsonRequest<{ ok: boolean; requestId: string }>(baseUrl, "/healthz");
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(typeof response.requestId, "string");
    assert.equal(response.requestId.startsWith("req_"), true);
    assert.equal(response.body.requestId, response.requestId);
  });
});

test("注册后可通过 Bearer dev_<userId> 查询画像并绑定会员号", async () => {
  await withApiServer(async (baseUrl) => {
    const registered = await jsonRequest<{ data: { id: string; nickname: string; points: number } }>(
      baseUrl,
      "/api/v1/user/register",
      {
        method: "POST",
        body: {
          deviceFp: "device-a",
          nickname: "alice",
          seatNo: "12A",
        },
      },
    );
    assert.equal(registered.status, 200);
    const userId = registered.body.data.id;
    assert.equal(typeof userId, "string");
    assert.equal(registered.body.data.nickname, "alice");
    assert.equal(registered.body.data.points, 0);

    const profile = await jsonRequest<{ data: { id: string; nickname: string; seatNo?: string } }>(
      baseUrl,
      "/api/v1/user/profile",
      {
        token: `dev_${userId}`,
      },
    );
    assert.equal(profile.status, 200);
    assert.equal(profile.body.data.id, userId);
    assert.equal(profile.body.data.seatNo, "12A");

    const bound = await jsonRequest<{ data: { userId: string; memberMasked: string } }>(
      baseUrl,
      "/api/v1/user/bind-member",
      {
        method: "POST",
        token: `dev_${userId}`,
        body: { memberNo: "MU12345678" },
      },
    );
    assert.equal(bound.status, 200);
    assert.equal(bound.body.data.userId, userId);
    assert.equal(bound.body.data.memberMasked.startsWith("MU"), true);
    assert.equal(bound.body.data.memberMasked.endsWith("78"), true);
  });
});

test("房间接口支持 userId+roomId 幂等 join", async () => {
  await withApiServer(async (baseUrl) => {
    const user1 = await jsonRequest<{ data: { id: string } }>(baseUrl, "/api/v1/user/register", {
      method: "POST",
      body: { deviceFp: "device-owner", nickname: "owner" },
    });
    const user2 = await jsonRequest<{ data: { id: string } }>(baseUrl, "/api/v1/user/register", {
      method: "POST",
      body: { deviceFp: "device-guest", nickname: "guest" },
    });
    const ownerId = user1.body.data.id;
    const guestId = user2.body.data.id;

    const created = await jsonRequest<{ data: { id: string; players: string[] } }>(baseUrl, "/api/v1/rooms", {
      method: "POST",
      token: `dev_${ownerId}`,
      body: { gameId: "gobang" },
    });
    assert.equal(created.status, 201);
    const roomId = created.body.data.id;
    assert.deepEqual(created.body.data.players, [ownerId]);

    const joinedOnce = await jsonRequest<{ data: { players: string[] } }>(baseUrl, `/api/v1/rooms/${roomId}/join`, {
      method: "POST",
      token: `dev_${guestId}`,
    });
    assert.equal(joinedOnce.status, 200);
    assert.equal(joinedOnce.body.data.players.length, 2);
    assert.equal(joinedOnce.body.data.players.includes(guestId), true);

    const joinedTwice = await jsonRequest<{ data: { players: string[] } }>(baseUrl, `/api/v1/rooms/${roomId}/join`, {
      method: "POST",
      token: `dev_${guestId}`,
    });
    assert.equal(joinedTwice.status, 200);
    assert.equal(joinedTwice.body.data.players.length, 2);

    const listed = await jsonRequest<{ data: Array<{ id: string; players: string[] }> }>(
      baseUrl,
      "/api/v1/rooms?gameId=gobang",
      {
        token: `dev_${ownerId}`,
      },
    );
    assert.equal(listed.status, 200);
    const target = listed.body.data.find((room) => room.id === roomId);
    assert.equal(Boolean(target), true);
    assert.equal(target?.players.length, 2);
  });
});

test("航班状态机符合 init -> complete -> export(幂等) -> reset", async () => {
  await withApiServer(async (baseUrl) => {
    const token = "dev_admin";

    const completeBeforeInit = await jsonRequest<{ code: string }>(baseUrl, "/api/v1/admin/flight/complete", {
      method: "POST",
      token,
    });
    assert.equal(completeBeforeInit.status, 409);
    assert.equal(completeBeforeInit.body.code, "FLIGHT_STATE_INVALID");

    const init = await jsonRequest<{ data: { id: string; status: string } }>(baseUrl, "/api/v1/admin/flight/init", {
      method: "POST",
      token,
      body: {
        id: "flight-mu2501",
        flightNo: "MU2501",
        date: "2026-04-15",
        departure: "SHA",
        arrival: "CTU",
      },
    });
    assert.equal(init.status, 200);
    assert.equal(init.body.data.status, "active");

    const complete = await jsonRequest<{ data: { status: string } }>(baseUrl, "/api/v1/admin/flight/complete", {
      method: "POST",
      token,
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.data.status, "completed");

    const exported = await jsonRequest<{ data: { id: string; status: string } }>(baseUrl, "/api/v1/admin/flight/export", {
      token,
    });
    assert.equal(exported.status, 200);
    assert.equal(exported.body.data.status, "success");
    const batchId = exported.body.data.id;

    const exportedAgain = await jsonRequest<{ data: { id: string } }>(baseUrl, "/api/v1/admin/flight/export", {
      token,
    });
    assert.equal(exportedAgain.status, 200);
    assert.equal(exportedAgain.body.data.id, batchId);

    const reset = await jsonRequest<{ data: { status: string } }>(baseUrl, "/api/v1/admin/flight/reset", {
      method: "POST",
      token,
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.data.status, "idle");
  });
});

test("航后 reset 会清理航班内缓存数据，避免跨航班残留", async () => {
  await withApiServer(async (baseUrl) => {
    const adminToken = "dev_admin";
    const init = await jsonRequest<{ data: { status: string } }>(baseUrl, "/api/v1/admin/flight/init", {
      method: "POST",
      token: adminToken,
      body: {
        id: "flight-cleanup-001",
        flightNo: "MU3001",
        date: "2026-04-16",
        departure: "PVG",
        arrival: "CAN",
      },
    });
    assert.equal(init.status, 200);
    assert.equal(init.body.data.status, "active");

    const registered = await jsonRequest<{ data: { id: string } }>(baseUrl, "/api/v1/user/register", {
      method: "POST",
      body: { deviceFp: "cleanup-device", nickname: "cleanup-user" },
    });
    assert.equal(registered.status, 200);
    const userId = registered.body.data.id;
    const userToken = `dev_${userId}`;

    const createdRoom = await jsonRequest<{ data: { id: string } }>(baseUrl, "/api/v1/rooms", {
      method: "POST",
      token: userToken,
      body: { gameId: "gobang" },
    });
    assert.equal(createdRoom.status, 201);

    const settled = await jsonRequest<{ data: { points: number } }>(baseUrl, "/api/v1/points/settle", {
      method: "POST",
      token: userToken,
      body: {
        sessionId: "cleanup-session-1",
        reason: "GAME_PLAY",
      },
    });
    assert.equal(settled.status, 200);
    assert.equal(settled.body.data.points > 0, true);

    const complete = await jsonRequest<{ data: { status: string } }>(baseUrl, "/api/v1/admin/flight/complete", {
      method: "POST",
      token: adminToken,
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.data.status, "completed");

    const exported = await jsonRequest<{ data: { id: string } }>(baseUrl, "/api/v1/admin/flight/export", {
      token: adminToken,
    });
    assert.equal(exported.status, 200);
    assert.equal(typeof exported.body.data.id, "string");

    const beforeResetStats = await jsonRequest<{
      data: { totalUsers: number; onlineRooms: number; pointLogs: number; exportBatches: number };
    }>(baseUrl, "/api/v1/admin/stats", {
      token: adminToken,
    });
    assert.equal(beforeResetStats.status, 200);
    assert.equal(beforeResetStats.body.data.totalUsers >= 1, true);
    assert.equal(beforeResetStats.body.data.onlineRooms >= 1, true);
    assert.equal(beforeResetStats.body.data.pointLogs >= 1, true);
    assert.equal(beforeResetStats.body.data.exportBatches >= 1, true);

    const reset = await jsonRequest<{ data: { status: string } }>(baseUrl, "/api/v1/admin/flight/reset", {
      method: "POST",
      token: adminToken,
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.data.status, "idle");

    const afterResetStats = await jsonRequest<{
      data: { totalUsers: number; onlineRooms: number; pointLogs: number; exportBatches: number; flightStatus: string };
    }>(baseUrl, "/api/v1/admin/stats", {
      token: adminToken,
    });
    assert.equal(afterResetStats.status, 200);
    assert.equal(afterResetStats.body.data.totalUsers, 0);
    assert.equal(afterResetStats.body.data.onlineRooms, 0);
    assert.equal(afterResetStats.body.data.pointLogs, 0);
    assert.equal(afterResetStats.body.data.exportBatches, 0);
    assert.equal(afterResetStats.body.data.flightStatus, "idle");

    const oldProfile = await jsonRequest<{ code: string }>(baseUrl, "/api/v1/user/profile", {
      token: userToken,
    });
    assert.equal(oldProfile.status, 404);
    assert.equal(oldProfile.body.code, "USER_NOT_FOUND");

    const reRegistered = await jsonRequest<{ data: { id: string; points: number } }>(baseUrl, "/api/v1/user/register", {
      method: "POST",
      body: { deviceFp: "cleanup-device", nickname: "cleanup-user-restart" },
    });
    assert.equal(reRegistered.status, 200);
    assert.notEqual(reRegistered.body.data.id, userId);
    assert.equal(reRegistered.body.data.points, 0);
  });
});

test("航后导出后可按 batchId 查询会员同步数据", async () => {
  await withApiServer(async (baseUrl) => {
    const adminToken = "dev_admin";
    const init = await jsonRequest<{ data: { status: string } }>(baseUrl, "/api/v1/admin/flight/init", {
      method: "POST",
      token: adminToken,
      body: {
        id: "flight-member-sync-001",
        flightNo: "MU3002",
        date: "2026-04-16",
        departure: "SHA",
        arrival: "CTU",
      },
    });
    assert.equal(init.status, 200);
    assert.equal(init.body.data.status, "active");

    const boundUser = await jsonRequest<{ data: { id: string } }>(baseUrl, "/api/v1/user/register", {
      method: "POST",
      body: { deviceFp: "member-sync-bound", nickname: "bound-user" },
    });
    const unboundUser = await jsonRequest<{ data: { id: string } }>(baseUrl, "/api/v1/user/register", {
      method: "POST",
      body: { deviceFp: "member-sync-unbound", nickname: "unbound-user" },
    });
    const boundUserId = boundUser.body.data.id;
    const unboundUserId = unboundUser.body.data.id;

    const boundToken = `dev_${boundUserId}`;
    const unboundToken = `dev_${unboundUserId}`;

    const bound = await jsonRequest<{ data: { points: number } }>(baseUrl, "/api/v1/user/bind-member", {
      method: "POST",
      token: boundToken,
      body: { memberNo: "MU55667788" },
    });
    assert.equal(bound.status, 200);
    assert.equal(bound.body.data.points > 0, true);

    const boundSettle = await jsonRequest<{ data: { points: number } }>(baseUrl, "/api/v1/points/settle", {
      method: "POST",
      token: boundToken,
      body: {
        sessionId: "member-sync-session-1",
        reason: "GAME_WIN",
      },
    });
    assert.equal(boundSettle.status, 200);
    assert.equal(boundSettle.body.data.points > 0, true);

    const unboundSettle = await jsonRequest<{ data: { points: number } }>(baseUrl, "/api/v1/points/settle", {
      method: "POST",
      token: unboundToken,
      body: {
        sessionId: "member-sync-session-2",
        reason: "GAME_PLAY",
      },
    });
    assert.equal(unboundSettle.status, 200);
    assert.equal(unboundSettle.body.data.points > 0, true);

    const complete = await jsonRequest<{ data: { status: string } }>(baseUrl, "/api/v1/admin/flight/complete", {
      method: "POST",
      token: adminToken,
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.data.status, "completed");

    const exported = await jsonRequest<{ data: { id: string } }>(baseUrl, "/api/v1/admin/flight/export", {
      token: adminToken,
    });
    assert.equal(exported.status, 200);
    const batchId = exported.body.data.id;
    assert.equal(typeof batchId, "string");

    const exportData = await jsonRequest<{
      data: {
        batchId: string;
        flight: { id: string; flightNo: string };
        rules: { pointsPerMile: number; ruleVersion: string };
        summary: { totalUsers: number; totalPoints: number; totalMileage: number; skippedUsers: number };
        records: Array<{
          mappedUserId: string;
          memberMasked: string;
          memberHash: string;
          totalPoints: number;
          mileage: number;
          details: Array<{ sessionId: string; reason: string; amount: number }>;
        }>;
      };
    }>(baseUrl, `/api/v1/admin/flight/export/data?batchId=${batchId}`, {
      token: adminToken,
    });
    assert.equal(exportData.status, 200);
    assert.equal(exportData.body.data.batchId, batchId);
    assert.equal(exportData.body.data.flight.id, "flight-member-sync-001");
    assert.equal(exportData.body.data.flight.flightNo, "MU3002");
    assert.equal(exportData.body.data.rules.pointsPerMile > 0, true);
    assert.equal(typeof exportData.body.data.rules.ruleVersion, "string");
    assert.equal(exportData.body.data.summary.totalUsers, 1);
    assert.equal(exportData.body.data.summary.skippedUsers, 1);
    assert.equal(exportData.body.data.summary.totalPoints > 0, true);
    assert.equal(exportData.body.data.summary.totalMileage >= 0, true);
    assert.equal(exportData.body.data.records.length, 1);

    const first = exportData.body.data.records[0];
    assert.equal(Boolean(first), true);
    assert.notEqual(first?.mappedUserId, boundUserId);
    assert.equal(first?.memberMasked.startsWith("MU"), true);
    assert.equal(typeof first?.memberHash, "string");
    assert.equal((first?.memberHash.length ?? 0) > 10, true);
    assert.equal((first?.totalPoints ?? 0) > 0, true);
    assert.equal((first?.details.length ?? 0) > 0, true);
    assert.equal(first?.details.some((detail) => detail.sessionId.startsWith("member-bind:")), true);

    const missing = await jsonRequest<{ code: string }>(baseUrl, "/api/v1/admin/flight/export/data?batchId=missing", {
      token: adminToken,
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "EXPORT_BATCH_NOT_FOUND");
  });
});

test("非法 JSON 返回标准错误体", async () => {
  await withApiServer(async (baseUrl) => {
    const response = await jsonRequest<{ code: string; requestId: string }>(baseUrl, "/api/v1/user/register", {
      method: "POST",
      rawBody: "{bad-json",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "BAD_REQUEST");
    assert.equal(response.body.requestId, response.requestId);
  });
});

test("积分规则与积分流水接口可用，会员绑定自动发放奖励", async () => {
  await withApiServer(async (baseUrl) => {
    const registered = await jsonRequest<{ data: { id: string } }>(baseUrl, "/api/v1/user/register", {
      method: "POST",
      body: { deviceFp: "device-points-1", nickname: "points-user" },
    });
    const userId = registered.body.data.id;
    const token = `dev_${userId}`;

    const rules = await jsonRequest<{
      data: {
        version: string;
        caps: { perSession: number; perDay: number; perFlight: number };
        reasons: Array<{ reason: string; points: number }>;
      };
    }>(baseUrl, "/api/v1/points/rules", { token });
    assert.equal(rules.status, 200);
    assert.equal(typeof rules.body.data.version, "string");
    assert.equal(rules.body.data.caps.perSession > 0, true);
    assert.equal(rules.body.data.reasons.some((reason) => reason.reason === "MEMBER_BIND_BONUS"), true);

    const bound = await jsonRequest<{ data: { points: number; bonus: { amount: number; idempotent: boolean } } }>(
      baseUrl,
      "/api/v1/user/bind-member",
      {
        method: "POST",
        token,
        body: { memberNo: "MU99887766" },
      },
    );
    assert.equal(bound.status, 200);
    assert.equal(bound.body.data.bonus.amount > 0, true);
    assert.equal(bound.body.data.bonus.idempotent, false);
    assert.equal(bound.body.data.points > 0, true);

    const history = await jsonRequest<{
      data: Array<{ reason: string; amount: number; sessionId: string }>;
    }>(baseUrl, "/api/v1/points/history?limit=10", { token });
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length >= 1, true);
    assert.equal(history.body.data[0]?.reason, "MEMBER_BIND_BONUS");
    assert.equal(history.body.data[0]?.amount > 0, true);
    assert.equal(history.body.data[0]?.sessionId.startsWith("member-bind:"), true);
  });
});

test("积分入账接口支持幂等与封顶", async () => {
  await withApiServer(async (baseUrl) => {
    const registered = await jsonRequest<{ data: { id: string } }>(baseUrl, "/api/v1/user/register", {
      method: "POST",
      body: { deviceFp: "device-points-2", nickname: "settle-user" },
    });
    const userId = registered.body.data.id;
    const token = `dev_${userId}`;

    const first = await jsonRequest<{
      data: { points: number; idempotent: boolean; log: { id: string; amount: number; capped: boolean } };
    }>(baseUrl, "/api/v1/points/settle", {
      method: "POST",
      token,
      body: {
        sessionId: "session-idem",
        reason: "GAME_PLAY",
        amount: 30,
      },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.idempotent, false);
    const firstLogId = first.body.data.log.id;
    assert.equal(first.body.data.log.amount, 30);

    const second = await jsonRequest<{
      data: { points: number; idempotent: boolean; log: { id: string; amount: number } };
    }>(baseUrl, "/api/v1/points/settle", {
      method: "POST",
      token,
      body: {
        sessionId: "session-idem",
        reason: "GAME_PLAY",
        amount: 30,
      },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.data.idempotent, true);
    assert.equal(second.body.data.log.id, firstLogId);
    assert.equal(second.body.data.points, 30);

    const capFirst = await jsonRequest<{
      data: { points: number; log: { amount: number; capped: boolean } };
    }>(baseUrl, "/api/v1/points/settle", {
      method: "POST",
      token,
      body: {
        sessionId: "session-cap",
        reason: "GAME_WIN",
        amount: 180,
      },
    });
    assert.equal(capFirst.status, 200);
    assert.equal(capFirst.body.data.log.amount, 180);
    assert.equal(capFirst.body.data.log.capped, false);

    const capSecond = await jsonRequest<{
      data: { points: number; log: { amount: number; capped: boolean } };
    }>(baseUrl, "/api/v1/points/settle", {
      method: "POST",
      token,
      body: {
        sessionId: "session-cap",
        reason: "GAME_PLAY",
        amount: 80,
      },
    });
    assert.equal(capSecond.status, 200);
    assert.equal(capSecond.body.data.log.amount, 20);
    assert.equal(capSecond.body.data.log.capped, true);
    assert.equal(capSecond.body.data.points, 230);
  });
});

test("运营补发接口仅管理员可调用，且支持幂等", async () => {
  await withApiServer(async (baseUrl) => {
    const registered = await jsonRequest<{ data: { id: string } }>(baseUrl, "/api/v1/user/register", {
      method: "POST",
      body: { deviceFp: "device-points-3", nickname: "grant-user" },
    });
    const userId = registered.body.data.id;

    const forbidden = await jsonRequest<{ code: string }>(baseUrl, "/api/v1/admin/points/grant", {
      method: "POST",
      token: `dev_${userId}`,
      body: {
        userId,
        amount: 40,
        sessionId: "ops-grant-1",
      },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, "FORBIDDEN");

    const first = await jsonRequest<{
      data: { points: number; idempotent: boolean; log: { reason: string; amount: number; id: string } };
    }>(baseUrl, "/api/v1/admin/points/grant", {
      method: "POST",
      token: "dev_admin",
      body: {
        userId,
        amount: 40,
        sessionId: "ops-grant-1",
      },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.idempotent, false);
    assert.equal(first.body.data.log.reason, "OPS_GRANT");
    assert.equal(first.body.data.log.amount, 40);
    const logId = first.body.data.log.id;

    const second = await jsonRequest<{
      data: { points: number; idempotent: boolean; log: { id: string } };
    }>(baseUrl, "/api/v1/admin/points/grant", {
      method: "POST",
      token: "dev_admin",
      body: {
        userId,
        amount: 40,
        sessionId: "ops-grant-1",
      },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.data.idempotent, true);
    assert.equal(second.body.data.log.id, logId);
    assert.equal(second.body.data.points, 40);
  });
});
