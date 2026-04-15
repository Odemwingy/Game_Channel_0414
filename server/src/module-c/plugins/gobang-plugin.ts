import type { GameLogicPlugin } from "../core/plugin.js";
import type { GameActionEnvelope } from "../protocol/types.js";

interface State {
  board: string[][];
  players: string[];
  turn: number;
  ended: boolean;
  winnerId?: string;
}

export class GobangPlugin implements GameLogicPlugin<State, State> {
  readonly gameId = "gobang";
  readonly minPlayers = 2;
  readonly maxPlayers = 2;
  readonly serverMode = "validation" as const;

  onGameStart(players: string[]): State {
    return {
      players,
      turn: 0,
      ended: false,
      board: Array.from({ length: 15 }, () => Array.from({ length: 15 }, () => "")),
    };
  }

  onPlayerAction(state: State, playerId: string, action: GameActionEnvelope) {
    if (state.ended) return { valid: false, error: "GAME_ALREADY_OVER" };
    if (action.type !== "PLACE_STONE") return { valid: false, error: "UNSUPPORTED_ACTION" };
    if (state.players[state.turn] !== playerId) return { valid: false, error: "NOT_YOUR_TURN" };
    const { x, y } = action.payload as { x: number; y: number };
    if (x < 0 || x > 14 || y < 0 || y > 14 || state.board[y][x]) return { valid: false, error: "INVALID_MOVE" };
    const next = state.board.map((row) => [...row]);
    const stone = state.turn === 0 ? "B" : "W";
    next[y][x] = stone;
    const winnerId = hasFiveInRow(next, x, y, stone) ? playerId : undefined;
    const ended = Boolean(winnerId) || next.every((row) => row.every((cell) => cell !== ""));
    return {
      valid: true,
      newState: {
        ...state,
        board: next,
        turn: (state.turn + 1) % 2,
        ended,
        winnerId,
      },
    };
  }

  getPlayerView(state: State): State {
    return state;
  }

  isGameOver(state: State): { isOver: boolean; winners?: string[] } {
    return state.ended ? { isOver: true, winners: state.winnerId ? [state.winnerId] : undefined } : { isOver: false };
  }
}

function hasFiveInRow(board: string[][], x: number, y: number, stone: string): boolean {
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ] as const;

  return directions.some(([dx, dy]) => {
    let count = 1;
    count += countDirection(board, x, y, dx, dy, stone);
    count += countDirection(board, x, y, -dx, -dy, stone);
    return count >= 5;
  });
}

function countDirection(board: string[][], x: number, y: number, dx: number, dy: number, stone: string): number {
  let count = 0;
  let nextX = x + dx;
  let nextY = y + dy;

  while (nextX >= 0 && nextX < 15 && nextY >= 0 && nextY < 15 && board[nextY]?.[nextX] === stone) {
    count += 1;
    nextX += dx;
    nextY += dy;
  }

  return count;
}
