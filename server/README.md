# 模块C开发启动说明

当前目录提供联机底座 MVP：
- WebSocket Gateway
- RoomEngine（状态机、幂等、断线托管）
- PluginRegistry
- 示例插件：`doudizhu`（权威）、`gobang`（校验）

## 运行

```bash
npm install
npm run dev
```

默认端口 `3001`，可通过 `WS_PORT` 修改。
