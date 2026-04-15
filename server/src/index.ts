import { bootstrapGateway } from "./module-c/gateway.js";

bootstrapGateway(Number(process.env.WS_PORT ?? 3001));
