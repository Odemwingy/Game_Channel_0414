export interface AuthContext {
  playerId: string;
  token?: string;
}

export function validateSocketAuth(input: unknown): AuthContext {
  if (!input || typeof input !== "object") {
    throw new Error("UNAUTHORIZED");
  }
  const payload = input as { playerId?: unknown; token?: unknown };
  if (typeof payload.playerId !== "string" || payload.playerId.length === 0) {
    throw new Error("UNAUTHORIZED");
  }
  if (payload.token != null && typeof payload.token !== "string") {
    throw new Error("UNAUTHORIZED");
  }
  if (typeof payload.token === "string" && !payload.token.startsWith("dev_")) {
    throw new Error("UNAUTHORIZED");
  }
  return { playerId: payload.playerId, token: payload.token as string | undefined };
}
