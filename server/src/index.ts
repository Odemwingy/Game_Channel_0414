import { bootstrapApiServer } from "./module-b/api-server.js";
import { bootstrapGateway } from "./module-c/gateway.js";

await Promise.all([
  bootstrapApiServer(Number(process.env.API_PORT ?? 3000)),
  bootstrapGateway(Number(process.env.WS_PORT ?? 3001)),
]);
