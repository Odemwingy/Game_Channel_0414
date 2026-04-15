import type { GameActionEnvelope } from "../protocol/types.js";

export interface GameLogicPlugin<TState = unknown, TView = unknown> {
  readonly gameId: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly serverMode: "authoritative" | "validation";
  onGameStart(players: string[]): TState;
  onPlayerAction(
    state: TState,
    playerId: string,
    action: GameActionEnvelope,
  ): { valid: boolean; newState?: TState; error?: string };
  getPlayerView(state: TState, playerId: string): TView;
  isGameOver(state: TState): { isOver: boolean; winners?: string[] };
  fallbackAction?(state: TState, playerId: string): GameActionEnvelope | null;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, GameLogicPlugin>();
  register(plugin: GameLogicPlugin): void {
    this.plugins.set(plugin.gameId, plugin);
  }
  get(gameId: string): GameLogicPlugin {
    const plugin = this.plugins.get(gameId);
    if (!plugin) throw new Error("PLUGIN_NOT_FOUND");
    return plugin;
  }
}
