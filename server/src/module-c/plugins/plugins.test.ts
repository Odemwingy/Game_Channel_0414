import assert from "node:assert/strict";
import test from "node:test";
import { DoudizhuPlugin } from "./doudizhu-plugin.js";
import { GobangPlugin } from "./gobang-plugin.js";
import type { GameActionEnvelope } from "../protocol/types.js";

function action(type: string, payload: Record<string, unknown> = {}): GameActionEnvelope {
  return {
    actionId: `${type}-${Date.now()}-${Math.random()}`,
    type,
    payload,
    clientTs: Date.now(),
  };
}

test("GobangPlugin：五连子后进入终局并产生赢家", () => {
  const plugin = new GobangPlugin();
  let state = plugin.onGameStart(["p1", "p2"]);

  const steps: Array<[string, number, number]> = [
    ["p1", 0, 0],
    ["p2", 0, 1],
    ["p1", 1, 0],
    ["p2", 1, 1],
    ["p1", 2, 0],
    ["p2", 2, 1],
    ["p1", 3, 0],
    ["p2", 3, 1],
    ["p1", 4, 0],
  ];

  for (const [playerId, x, y] of steps) {
    const result = plugin.onPlayerAction(state, playerId, action("PLACE_STONE", { x, y }));
    assert.equal(result.valid, true);
    state = result.newState!;
  }

  assert.deepEqual(plugin.isGameOver(state), { isOver: true, winners: ["p1"] });
});

test("DoudizhuPlugin：玩家打完手牌后进入终局", () => {
  const plugin = new DoudizhuPlugin();
  let state = plugin.onGameStart(["p1", "p2", "p3"]);

  const steps: Array<[string, string]> = [
    ["p1", "PLAY_CARD"],
    ["p2", "PASS"],
    ["p3", "PASS"],
    ["p1", "PLAY_CARD"],
    ["p2", "PASS"],
    ["p3", "PASS"],
    ["p1", "PLAY_CARD"],
  ];

  for (const [playerId, type] of steps) {
    const result = plugin.onPlayerAction(state, playerId, action(type));
    assert.equal(result.valid, true);
    state = result.newState!;
  }

  assert.deepEqual(plugin.isGameOver(state), { isOver: true, winners: ["p1"] });
});
