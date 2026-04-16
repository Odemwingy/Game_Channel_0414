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

test("重复 join：保持 ready 状态且不推进版本", () => {
  const engine = new RoomEngine();
  const roomId = engine.createRoom("dummy", testPlugin);
  engine.joinRoom(roomId, "u1", "s1");
  engine.joinRoom(roomId, "u2", "s2");
  engine.markReady(roomId, "u1");

  const versionBefore = engine.getStateVersion(roomId);
  const sync = engine.joinRoom(roomId, "u1", "s1");

  assert.equal(sync.players.find((player) => player.playerId === "u1")?.ready, true);
  assert.equal(sync.stateVersion, versionBefore);
  assert.equal(engine.getStateVersion(roomId), versionBefore);
});

test("重复 ready：不重复推进版本", () => {
  const engine = new RoomEngine();
  const roomId = engine.createRoom("dummy", testPlugin);
  engine.joinRoom(roomId, "u1", "s1");
  engine.joinRoom(roomId, "u2", "s2");

  engine.markReady(roomId, "u1");
  const versionBefore = engine.getStateVersion(roomId);
  const sync = engine.markReady(roomId, "u1");

  assert.equal(sync.players.find((player) => player.playerId === "u1")?.ready, true);
  assert.equal(sync.stateVersion, versionBefore);
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
  assert.equal(engine.getSnapshot(roomId).players.every((player) => player.ready === false), true);
});

test("结算后可重新 ready 开启下一局", () => {
  const engine = new RoomEngine();
  const roomId = engine.createRoom("dummy", testPlugin);
  engine.joinRoom(roomId, "u1", "s1");
  engine.joinRoom(roomId, "u2", "s2");
  engine.markReady(roomId, "u1");
  engine.markReady(roomId, "u2");
  engine.handleAction(roomId, "u1", action("round-1"));

  const afterFirstReady = engine.markReady(roomId, "u1");
  assert.equal(afterFirstReady.state, "WAITING");
  assert.equal(afterFirstReady.players.find((player) => player.playerId === "u1")?.ready, true);
  assert.equal(afterFirstReady.players.find((player) => player.playerId === "u2")?.ready, false);

  const restarted = engine.markReady(roomId, "u2");
  assert.equal(restarted.state, "PLAYING");
  assert.equal(engine.getPlayerView(roomId, "u1") != null, true);
});

test("非法动作：拒绝处理且不推进版本", () => {
  const engine = new RoomEngine();
  const roomId = engine.createRoom("dummy", testPlugin);
  engine.joinRoom(roomId, "u1", "s1");
  engine.joinRoom(roomId, "u2", "s2");
  engine.markReady(roomId, "u1");
  engine.markReady(roomId, "u2");

  const versionBefore = engine.getStateVersion(roomId);
  const result = engine.handleAction(roomId, "u2", action("wrong-turn"));

  assert.equal(result.accepted, false);
  assert.equal(result.error, "NOT_YOUR_TURN");
  assert.equal(result.version, versionBefore);
  assert.equal(engine.getStateVersion(roomId), versionBefore);
});

test("断线托管：超过保留时长后执行 fallbackAction", () => {
  const engine = new RoomEngine();
  const roomId = engine.createRoom("dummy", {
    ...testPlugin,
    fallbackAction() {
      return { actionId: "fallback-1", type: "STEP", payload: {}, clientTs: Date.now() };
    },
  });
  engine.joinRoom(roomId, "u1", "s1");
  engine.joinRoom(roomId, "u2", "s2");
  engine.markReady(roomId, "u1");
  engine.markReady(roomId, "u2");

  const versionBefore = engine.getStateVersion(roomId);
  engine.markOffline(roomId, "u1");
  const events = engine.tick(Date.now() + 121_000);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.lastAction?.type, "STEP");
  assert.equal(engine.getStateVersion(roomId), versionBefore + 2);
  assert.equal(engine.getSnapshot(roomId).state, "SETTLED");
});

test("空闲房间：超时后自动解散并回收", () => {
  const engine = new RoomEngine();
  const roomId = engine.createRoom("dummy", testPlugin);
  engine.joinRoom(roomId, "u1", "s1");

  const events = engine.tick(Date.now() + 10 * 60_000 + 1_000);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.idleDismissed, true);
  assert.equal(events[0]?.sync.state, "DISMISSED");
  assert.throws(() => engine.getSnapshot(roomId), /ROOM_NOT_FOUND/);
});

test("空房间：建房后无人加入，超时后自动回收", () => {
  const engine = new RoomEngine();
  const roomId = engine.createRoom("dummy", testPlugin);

  const events = engine.tick(Date.now() + 10 * 60_000 + 1_000);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.roomId, roomId);
  assert.equal(events[0]?.idleDismissed, true);
  assert.equal(events[0]?.sync.players.length, 0);
  assert.throws(() => engine.getSnapshot(roomId), /ROOM_NOT_FOUND/);
});

test("批量空闲房间：超时后全部回收，避免 rooms 持续增长", () => {
  const engine = new RoomEngine();
  const roomIds: string[] = [];
  for (let i = 0; i < 50; i += 1) {
    roomIds.push(engine.createRoom("dummy", testPlugin));
  }

  const events = engine.tick(Date.now() + 10 * 60_000 + 1_000);
  assert.equal(events.length, roomIds.length);
  assert.equal(events.every((event) => event.idleDismissed === true), true);
  for (const roomId of roomIds) {
    assert.throws(() => engine.getSnapshot(roomId), /ROOM_NOT_FOUND/);
  }
});
