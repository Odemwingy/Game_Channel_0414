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
  updatedAt: string;
  syncedAt?: string;
  successCount?: number;
  failedCount?: number;
  lastError?: string;
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

export interface MemberSyncDetailRecord {
  sessionId: string;
  reason: string;
  amount: number;
  createdAt: string;
}

export interface MemberSyncExportRecord {
  mappedUserId: string;
  memberMasked: string;
  memberHash: string;
  totalPoints: number;
  mileage: number;
  details: MemberSyncDetailRecord[];
}

export interface MemberSyncExportPayload {
  batchId: string;
  flight: {
    id: string;
    flightNo: string;
    date: string;
    departure: string;
    arrival: string;
  };
  rules: {
    pointsPerMile: number;
    ruleVersion: string;
  };
  summary: {
    totalUsers: number;
    totalPoints: number;
    totalMileage: number;
    skippedUsers: number;
  };
  records: MemberSyncExportRecord[];
  generatedAt: string;
}
