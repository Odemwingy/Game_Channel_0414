export type RoomState = "WAITING" | "PLAYING" | "SETTLED" | "DISMISSED";
export type PlayerPresence = "ONLINE" | "OFFLINE";

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

export interface RoomSyncPayload {
  roomId: string;
  gameId: string;
  state: RoomState;
  players: Array<{ playerId: string; presence: PlayerPresence; ready: boolean }>;
  stateVersion: number;
}
