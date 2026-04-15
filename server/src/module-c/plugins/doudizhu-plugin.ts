import type { GameLogicPlugin } from "../core/plugin.js";
import type { GameActionEnvelope } from "../protocol/types.js";

interface State {
  players: string[];
  turn: number;
  hands: Record<string, string[]>;
  ended: boolean;
  winnerId?: string;
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
      ended: false,
      hands: Object.fromEntries(players.map((id) => [id, ["?", "?", "?"]])),
    };
  }

  onPlayerAction(state: State, playerId: string, action: GameActionEnvelope) {
    if (state.ended) return { valid: false, error: "GAME_ALREADY_OVER" };
    if (state.players[state.turn] !== playerId) return { valid: false, error: "NOT_YOUR_TURN" };
    if (action.type !== "PLAY_CARD" && action.type !== "PASS") return { valid: false, error: "UNSUPPORTED_ACTION" };
    if (action.type === "PASS") {
      return { valid: true, newState: { ...state, turn: (state.turn + 1) % state.players.length } };
    }

    const currentHand = state.hands[playerId] ?? [];
    if (currentHand.length === 0) {
      return { valid: false, error: "NO_CARD_LEFT" };
    }

    const nextHands = {
      ...state.hands,
      [playerId]: currentHand.slice(1),
    };
    const winnerId = nextHands[playerId].length === 0 ? playerId : undefined;
    return {
      valid: true,
      newState: {
        ...state,
        hands: nextHands,
        turn: (state.turn + 1) % state.players.length,
        ended: Boolean(winnerId),
        winnerId,
      },
    };
  }

  getPlayerView(state: State, playerId: string): Record<string, unknown> {
    return {
      turnPlayerId: state.players[state.turn],
      myHand: state.hands[playerId] ?? [],
      handCount: Object.fromEntries(state.players.map((id) => [id, state.hands[id]?.length ?? 0])),
    };
  }

  isGameOver(state: State): { isOver: boolean; winners?: string[] } {
    return state.ended ? { isOver: true, winners: state.winnerId ? [state.winnerId] : undefined } : { isOver: false };
  }

  fallbackAction(): GameActionEnvelope {
    return { actionId: `fallback-${Date.now()}`, type: "PASS", payload: {}, clientTs: Date.now() };
  }
}
