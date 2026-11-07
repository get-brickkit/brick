import { index, type RouteConfig, route } from "@react-router/dev/routes";
import { API_PATHS } from "./lib/types";

export default [
  index("./routes/home.tsx"),
  route("run/:runId", "./routes/run-detail.tsx"),
  route(API_PATHS.rpc, "./routes/api.rpc.tsx"),
  route(`${API_PATHS.stream}:streamId`, "./routes/api.stream.$streamId.tsx"),
] satisfies RouteConfig;
