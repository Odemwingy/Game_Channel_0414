# 模块 B/C 服务开发说明

当前目录提供两套可并行运行的服务：
- 模块 B：REST API（用户、房间、航班管理）
- 模块 C：联机底座（WebSocket Gateway + RoomEngine + Plugin）

同时提供：
- 最小客户端 SDK：`server/src/sdk/`
- 服务端插件模板：`server/src/module-c/templates/plugin-template.ts`

## 运行

```bash
npm install
npm run dev
npm test
```

默认端口：
- REST API：`3000`（可用 `API_PORT` 覆盖）
- WebSocket Gateway：`3001`（可用 `WS_PORT` 覆盖）

## 鉴权桩（开发态）

### REST

- `Authorization: Bearer dev_<userId>`
- 向后兼容：`Authorization: Bearer dev_user_<userId>`

### WebSocket 握手

```json
{
  "playerId": "u1",
  "token": "dev_u1"
}
```

## 模块 B 能力

- `POST /api/v1/user/register`
- `GET /api/v1/user/profile`
- `POST /api/v1/user/bind-member`
- `GET /api/v1/games`
- `GET /api/v1/games/{id}`
- `GET /api/v1/rooms`
- `POST /api/v1/rooms`
- `POST /api/v1/rooms/{id}/join`（`userId + roomId` 幂等）
- `DELETE /api/v1/rooms/{id}/leave`
- `POST /api/v1/admin/flight/init`
- `POST /api/v1/admin/flight/complete`
- `GET /api/v1/admin/flight/export`（同航班幂等返回同一批次）
- `POST /api/v1/admin/flight/reset`
- `GET /api/v1/admin/stats`

## 模块 C 能力

- `room:sync_full` 主动全量同步
- `stateVersion` 回放保护（客户端落后时强制全量快照）
- 审计日志（鉴权失败、非法动作、重连失败、终局等）
- 重复 `room:join` 幂等与会话接管防抖
- 空闲房间超时自动解散（`WAITING/SETTLED` 10 分钟）

## 简易压测

```bash
npm run loadtest
```

可选环境变量：
- `WS_URL`：默认 `http://127.0.0.1:3001`
- `CLIENTS`：默认 `50`
- `GAME_ID`：默认 `gobang`
