import { io } from "socket.io-client";

const target = process.env.WS_URL ?? "http://127.0.0.1:3001";
const clients = Number(process.env.CLIENTS ?? 50);
const gameId = process.env.GAME_ID ?? "gobang";

async function run(): Promise<void> {
  const sockets = [];
  let connected = 0;
  let errored = 0;

  for (let i = 0; i < clients; i += 1) {
    const playerId = `load_${i}`;
    const socket = io(target, {
      transports: ["websocket"],
      auth: { playerId, token: `dev_${playerId}` },
      reconnection: false,
      timeout: 5000,
    });

    socket.on("connect", () => {
      connected += 1;
      if (i === 0) {
        socket.emit("room:create", { gameId, playerId });
      } else {
        // 第一位创建房间后，其他连接仅保持在线以观察网关容量。
      }
    });

    socket.on("connect_error", () => {
      errored += 1;
    });
    sockets.push(socket);
  }

  await new Promise((resolve) => setTimeout(resolve, 4000));
  // eslint-disable-next-line no-console
  console.log(`[loadtest] target=${target} clients=${clients} connected=${connected} errored=${errored}`);

  for (const socket of sockets) {
    socket.disconnect();
  }
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[loadtest] failed", error);
  process.exit(1);
});
