export interface ApiErrorBody {
  code: string;
  message: string;
  requestId: string;
}

export interface UserRecord {
  id: string;
  flightId: string;
  nickname: string;
  seatNo?: string;
  deviceFp: string;
  memberHash?: string;
  memberMasked?: string;
  points: number;
  createdAt: string;
}

export interface RoomRecord {
  id: string;
  gameId: string;
  ownerUserId: string;
  players: string[];
  state: "WAITING" | "PLAYING" | "SETTLED" | "DISMISSED";
  createdAt: string;
}

export interface ExportBatchRecord {
  id: string;
  flightId: string;
  exportType: "member_credit";
  status: "created" | "success" | "failed" | "partial";
  filePath: string;
  checksum: string;
  createdAt: string;
}

export interface FlightInfo {
  id: string;
  flightNo: string;
  date: string;
  departure: string;
  arrival: string;
  status: "idle" | "active" | "completed" | "exported";
  createdAt: string;
  updatedAt: string;
}

export interface PointReasonRule {
  reason: string;
  description: string;
  points: number;
  adminOnly?: boolean;
}

export interface PointsCaps {
  perSession: number;
  perDay: number;
  perFlight: number;
}

export interface PointsRulesSnapshot {
  version: string;
  loadedFrom: string;
  caps: PointsCaps;
  reasons: PointReasonRule[];
}

export interface PointLogRecord {
  id: string;
  flightId: string;
  userId: string;
  sessionId: string;
  reason: string;
  amount: number;
  ruleVersion: string;
  capped: boolean;
  createdAt: string;
}
