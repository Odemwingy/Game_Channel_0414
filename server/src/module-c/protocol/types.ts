export type RoomState = "WAITING" | "PLAYING" | "SETTLED" | "DISMISSED";
export type PlayerPresence = "ONLINE" | "OFFLINE";

export interface SocketHandshakeAuth {
  playerId: string;
  token: string;
}

export interface GameActionEnvelope<TPayload = unknown> {
  actionId: string;
  type: string;
  payload: TPayload;
  clientTs: number;
}

export interface PlayerSession {
  playerId: string;
  socketId: string;
  seatNo?: string;
  presence: PlayerPresence;
  ready: boolean;
  lastSeenAt: number;
}

export interface RoomPlayerPayload {
  playerId: string;
  seatIndex: number;
  presence: PlayerPresence;
  ready: boolean;
}

export interface RoomSyncPayload {
  roomId: string;
  gameId: string;
  state: RoomState;
  players: RoomPlayerPayload[];
  stateVersion: number;
}

export interface GameViewPayload<TView = unknown> {
  roomId: string;
  playerId: string;
  view: TView;
  stateVersion: number;
}

export interface GameUpdatePayload<TView = unknown> extends GameViewPayload<TView> {
  lastAction: GameActionEnvelope;
}

export interface GameOverPayload {
  roomId: string;
  winners: string[];
  stateVersion: number;
}

export interface GameErrorPayload {
  message: string;
  stateVersion?: number;
}
