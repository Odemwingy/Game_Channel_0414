import { bootstrapGateway } from "./module-c/gateway.js";

await bootstrapGateway(Number(process.env.WS_PORT ?? 3001));
