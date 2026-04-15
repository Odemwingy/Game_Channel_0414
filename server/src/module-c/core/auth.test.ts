import assert from "node:assert/strict";
import test from "node:test";
import { validateSocketAuth } from "./auth.js";

test("握手鉴权：缺失 token 时拒绝连接", () => {
  assert.throws(() => validateSocketAuth({ playerId: "u1" }), /UNAUTHORIZED/);
});

test("握手鉴权：token 必须与 playerId 匹配", () => {
  assert.throws(() => validateSocketAuth({ playerId: "u1", token: "dev_u2" }), /UNAUTHORIZED/);
});

test("握手鉴权：合法的 dev token 可通过", () => {
  assert.deepEqual(validateSocketAuth({ playerId: "u1", token: "dev_u1" }), {
    playerId: "u1",
    token: "dev_u1",
  });
});
