import type {
  GameActionEnvelope,
  GameErrorPayload,
  GameOverPayload,
  GameUpdatePayload,
  GameViewPayload,
  RoomSyncPayload,
  SocketHandshakeAuth,
} from "../module-c/protocol/types.js";

export type {
  GameActionEnvelope,
  GameErrorPayload,
  GameOverPayload,
  GameUpdatePayload,
  GameViewPayload,
  RoomSyncPayload,
  SocketHandshakeAuth,
};

export interface CreateRoomPayload {
  gameId: string;
  playerId: string;
}

export interface JoinRoomPayload {
  roomId: string;
  playerId: string;
}

export interface ReconnectRoomPayload {
  roomId: string;
  playerId: string;
}

export interface ClientToServerEvents {
  "room:create": (payload: CreateRoomPayload) => void;
  "room:join": (payload: JoinRoomPayload) => void;
  "room:leave": () => void;
  "room:reconnect": (payload: ReconnectRoomPayload) => void;
  "room:sync_full": () => void;
  "game:ready": () => void;
  "game:action": (payload: GameActionEnvelope & { stateVersion?: number }) => void;
}

export interface ServerToClientEvents<TView = unknown> {
  "room:sync": (payload: RoomSyncPayload) => void;
  "game:start": (payload: GameViewPayload<TView>) => void;
  "game:update": (payload: GameUpdatePayload<TView>) => void;
  "game:sync_full": (payload: GameViewPayload<TView>) => void;
  "game:over": (payload: GameOverPayload) => void;
  "game:error": (payload: GameErrorPayload) => void;
}

export interface MultiplayerClientOptions {
  url: string;
  auth: SocketHandshakeAuth;
  autoConnect?: boolean;
}
