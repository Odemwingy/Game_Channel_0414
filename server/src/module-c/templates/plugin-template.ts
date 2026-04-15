import type { GameLogicPlugin } from "../core/plugin.js";
import type { GameActionEnvelope } from "../protocol/types.js";

interface TemplateGameState {
  players: string[];
  turn: number;
  ended: boolean;
  winnerId?: string;
}

interface TemplateGameView {
  myPlayerId: string;
  turnPlayerId: string;
  ended: boolean;
  winnerId?: string;
}

export class TemplateGamePlugin implements GameLogicPlugin<TemplateGameState, TemplateGameView> {
  readonly gameId = "replace-with-your-game-id";
  readonly minPlayers = 2;
  readonly maxPlayers = 2;
  readonly serverMode = "validation" as const;

  onGameStart(players: string[]): TemplateGameState {
    return {
      players,
      turn: 0,
      ended: false,
    };
  }

  onPlayerAction(state: TemplateGameState, playerId: string, action: GameActionEnvelope) {
    if (state.ended) return { valid: false, error: "GAME_ALREADY_OVER" };
    if (state.players[state.turn] !== playerId) return { valid: false, error: "NOT_YOUR_TURN" };

    switch (action.type) {
      case "PLACEHOLDER_ACTION":
        return {
          valid: true,
          newState: {
            ...state,
            turn: (state.turn + 1) % state.players.length,
          },
        };
      default:
        return { valid: false, error: "UNSUPPORTED_ACTION" };
    }
  }

  getPlayerView(state: TemplateGameState, playerId: string): TemplateGameView {
    return {
      myPlayerId: playerId,
      turnPlayerId: state.players[state.turn],
      ended: state.ended,
      winnerId: state.winnerId,
    };
  }

  isGameOver(state: TemplateGameState): { isOver: boolean; winners?: string[] } {
    return state.ended ? { isOver: true, winners: state.winnerId ? [state.winnerId] : undefined } : { isOver: false };
  }

  fallbackAction(state: TemplateGameState): GameActionEnvelope | null {
    if (state.ended) {
      return null;
    }
    return {
      actionId: `fallback-${Date.now()}`,
      type: "PLACEHOLDER_ACTION",
      payload: {},
      clientTs: Date.now(),
    };
  }
}
