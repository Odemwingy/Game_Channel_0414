type AuditLevel = "INFO" | "WARN" | "ERROR";

interface AuditPayload {
  event: string;
  roomId?: string;
  playerId?: string;
  detail?: Record<string, unknown>;
}

export function writeAuditLog(level: AuditLevel, payload: AuditPayload): void {
  const logLine = {
    ts: new Date().toISOString(),
    level,
    ...payload,
  };
  // 先用标准输出作为审计日志出口，后续可替换为文件或DB落库。
  // eslint-disable-next-line no-console
  console.log("[audit]", JSON.stringify(logLine));
}
