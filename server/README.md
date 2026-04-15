# 模块C开发启动说明

当前目录提供联机底座 MVP：
- WebSocket Gateway
- RoomEngine（状态机、幂等、断线托管）
- PluginRegistry
- 示例插件：`doudizhu`（权威，可完成最小手牌结算）、`gobang`（校验，可完成五连子结算）
- 玩家视角按 `socket` 定向下发，避免隐藏信息广播泄漏

## 运行

```bash
npm install
npm run dev
npm test
```

默认端口 `3001`，可通过 `WS_PORT` 修改。

WebSocket 握手需携带：

```json
{
  "playerId": "u1",
  "token": "dev_u1"
}
```

## 第三阶段增强

- 新增 `room:sync_full` 主动全量同步事件
- 新增 `stateVersion` 回放保护（客户端版本落后时强制下发全量快照）
- 新增审计日志输出（鉴权失败、非法动作、重连失败、终局等）
- 新增重复 `room:join` 幂等保护与会话接管防抖

## 简易压测

```bash
npm run loadtest
```

可选环境变量：
- `WS_URL`：默认 `http://127.0.0.1:3001`
- `CLIENTS`：默认 `50`
- `GAME_ID`：默认 `gobang`
