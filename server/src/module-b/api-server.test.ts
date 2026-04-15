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
