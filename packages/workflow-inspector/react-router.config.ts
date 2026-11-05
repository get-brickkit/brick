import type { Config } from "@react-router/dev/config";
import { BASE_PATH } from "./base-path";

export default {
  appDirectory: "app",
  basename: BASE_PATH,
  ssr: true,
} satisfies Config;
