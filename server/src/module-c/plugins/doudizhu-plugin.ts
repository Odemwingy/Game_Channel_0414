import type { GameLogicPlugin } from "../core/plugin.js";
import type { GameActionEnvelope } from "../protocol/types.js";

interface State {
  players: string[];
  turn: number;
  hands: Record<string, string[]>;
}

export class DoudizhuPlugin implements GameLogicPlugin<State, Record<string, unknown>> {
  readonly gameId = "doudizhu";
  readonly minPlayers = 3;
  readonly maxPlayers = 3;
  readonly serverMode = "authoritative" as const;

  onGameStart(players: string[]): State {
    return {
      players,
      turn: 0,
      hands: Object.fromEntries(players.map((id) => [id, ["?", "?", "?"]])),
    };
  }

  onPlayerAction(state: State, playerId: string, action: GameActionEnvelope) {
    if (state.players[state.turn] !== playerId) return { valid: false, error: "NOT_YOUR_TURN" };
    if (action.type !== "PLAY_CARD" && action.type !== "PASS") return { valid: false, error: "UNSUPPORTED_ACTION" };
    return { valid: true, newState: { ...state, turn: (state.turn + 1) % 3 } };
  }

  getPlayerView(state: State, playerId: string): Record<string, unknown> {
    return {
      turnPlayerId: state.players[state.turn],
      myHand: state.hands[playerId] ?? [],
      handCount: Object.fromEntries(state.players.map((id) => [id, state.hands[id]?.length ?? 0])),
    };
  }

  isGameOver(): { isOver: boolean } {
    return { isOver: false };
  }

  fallbackAction(): GameActionEnvelope {
    return { actionId: `fallback-${Date.now()}`, type: "PASS", payload: {}, clientTs: Date.now() };
  }
}
