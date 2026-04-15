import type { GameLogicPlugin } from "../core/plugin.js";
import type { GameActionEnvelope } from "../protocol/types.js";

interface State {
  board: string[][];
  players: string[];
  turn: number;
}

export class GobangPlugin implements GameLogicPlugin<State, State> {
  readonly gameId = "gobang";
  readonly minPlayers = 2;
  readonly maxPlayers = 2;
  readonly serverMode = "validation" as const;

  onGameStart(players: string[]): State {
    return { players, turn: 0, board: Array.from({ length: 15 }, () => Array.from({ length: 15 }, () => "")) };
  }

  onPlayerAction(state: State, playerId: string, action: GameActionEnvelope) {
    if (action.type !== "PLACE_STONE") return { valid: false, error: "UNSUPPORTED_ACTION" };
    if (state.players[state.turn] !== playerId) return { valid: false, error: "NOT_YOUR_TURN" };
    const { x, y } = action.payload as { x: number; y: number };
    if (x < 0 || x > 14 || y < 0 || y > 14 || state.board[y][x]) return { valid: false, error: "INVALID_MOVE" };
    const next = state.board.map((row) => [...row]);
    next[y][x] = state.turn === 0 ? "B" : "W";
    return { valid: true, newState: { ...state, board: next, turn: (state.turn + 1) % 2 } };
  }

  getPlayerView(state: State): State {
    return state;
  }

  isGameOver(): { isOver: boolean } {
    return { isOver: false };
  }
}
