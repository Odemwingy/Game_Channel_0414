import test from "node:test";
import assert from "node:assert/strict";
import { RoomEngine } from "./room-engine.js";
import type { GameLogicPlugin } from "./plugin.js";
import type { GameActionEnvelope } from "../protocol/types.js";

interface DummyState {
  turn: number;
  players: string[];
  ended: boolean;
}

const testPlugin: GameLogicPlugin<DummyState, DummyState> = {
  gameId: "dummy",
  minPlayers: 2,
  maxPlayers: 2,
  serverMode: "validation",
  onGameStart(players) {
    return { turn: 0, players, ended: false };
  },
  onPlayerAction(state, playerId, action) {
    if (state.players[state.turn] !== playerId) {
      return { valid: false, error: "NOT_YOUR_TURN" };
    }
    if (action.type !== "STEP") {
      return { valid: false, error: "BAD_ACTION" };
    }
    return {
      valid: true,
      newState: {
        ...state,
        turn: (state.turn + 1) % state.players.length,
        ended: true,
      },
    };
  },
  getPlayerView(state) {
    return state;
  },
  isGameOver(state) {
    return state.ended ? { isOver: true, winners: [state.players[0]] } : { isOver: false };
  },
};

function action(id: string): GameActionEnvelope {
  return { actionId: id, type: "STEP", payload: {}, clientTs: Date.now() };
}

test("幂等去重：重复 actionId 只处理一次", () => {
  const engine = new RoomEngine();
  const roomId = engine.createRoom("dummy", testPlugin);
  engine.joinRoom(roomId, "u1", "s1");
  engine.joinRoom(roomId, "u2", "s2");
  engine.markReady(roomId, "u1");
  engine.markReady(roomId, "u2");

  const first = engine.handleAction(roomId, "u1", action("a1"));
  const second = engine.handleAction(roomId, "u1", action("a1"));
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(first.version, second.version);
});

test("玩家离开：room:leave 后人数减少", () => {
  const engine = new RoomEngine();
  const roomId = engine.createRoom("dummy", testPlugin);
  engine.joinRoom(roomId, "u1", "s1");
  engine.joinRoom(roomId, "u2", "s2");

  const sync = engine.leaveRoom(roomId, "u2");
  assert.equal(sync.players.length, 1);
  assert.equal(sync.players[0]?.playerId, "u1");
});

test("终局标记：命中 isGameOver 后返回 winners", () => {
  const engine = new RoomEngine();
  const roomId = engine.createRoom("dummy", testPlugin);
  engine.joinRoom(roomId, "u1", "s1");
  engine.joinRoom(roomId, "u2", "s2");
  engine.markReady(roomId, "u1");
  engine.markReady(roomId, "u2");

  const result = engine.handleAction(roomId, "u1", action("a2"));
  assert.equal(result.accepted, true);
  assert.deepEqual(result.gameOver?.winners, ["u1"]);
});
