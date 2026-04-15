import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  CreateRoomPayload,
  JoinRoomPayload,
  MultiplayerClientOptions,
  ReconnectRoomPayload,
  ServerToClientEvents,
} from "./types.js";
import type { GameActionEnvelope } from "../module-c/protocol/types.js";

export class MultiplayerClient<TView = unknown> {
  private readonly socket: Socket<ServerToClientEvents<TView>, ClientToServerEvents>;
  private readonly playerId: string;

  constructor(options: MultiplayerClientOptions) {
    this.playerId = options.auth.playerId;
    this.socket = io(options.url, {
      transports: ["websocket"],
      autoConnect: options.autoConnect ?? false,
      auth: options.auth,
    });
  }

  async connect(): Promise<void> {
    if (this.socket.connected) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.socket.off("connect", onConnect);
        this.socket.off("connect_error", onError);
      };

      this.socket.on("connect", onConnect);
      this.socket.on("connect_error", onError);
      this.socket.connect();
    });
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  createRoom(gameId: string): void {
    const payload: CreateRoomPayload = { gameId, playerId: this.playerId };
    this.socket.emit("room:create", payload);
  }

  joinRoom(roomId: string): void {
    const payload: JoinRoomPayload = { roomId, playerId: this.playerId };
    this.socket.emit("room:join", payload);
  }

  leaveRoom(): void {
    this.socket.emit("room:leave");
  }

  reconnectRoom(roomId: string): void {
    const payload: ReconnectRoomPayload = { roomId, playerId: this.playerId };
    this.socket.emit("room:reconnect", payload);
  }

  ready(): void {
    this.socket.emit("game:ready");
  }

  requestFullSync(): void {
    this.socket.emit("room:sync_full");
  }

  sendAction(action: GameActionEnvelope & { stateVersion?: number }): void {
    this.socket.emit("game:action", action);
  }

  onRoomSync(handler: ServerToClientEvents<TView>["room:sync"]): () => void {
    this.socket.on("room:sync", handler);
    return () => this.socket.off("room:sync", handler);
  }

  onGameStart(handler: ServerToClientEvents<TView>["game:start"]): () => void {
    this.socket.on("game:start", handler);
    return () => this.socket.off("game:start", handler);
  }

  onGameUpdate(handler: ServerToClientEvents<TView>["game:update"]): () => void {
    this.socket.on("game:update", handler);
    return () => this.socket.off("game:update", handler);
  }

  onGameOver(handler: ServerToClientEvents<TView>["game:over"]): () => void {
    this.socket.on("game:over", handler);
    return () => this.socket.off("game:over", handler);
  }

  onGameError(handler: ServerToClientEvents<TView>["game:error"]): () => void {
    this.socket.on("game:error", handler);
    return () => this.socket.off("game:error", handler);
  }

  onFullSync(handler: ServerToClientEvents<TView>["game:sync_full"]): () => void {
    this.socket.on("game:sync_full", handler);
    return () => this.socket.off("game:sync_full", handler);
  }
}

export function buildDevAuth(playerId: string): MultiplayerClientOptions["auth"] {
  return {
    playerId,
    token: `dev_${playerId}`,
  };
}
