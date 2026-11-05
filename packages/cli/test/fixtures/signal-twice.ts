// A process whose deliveries never finish, for the second-signal test.
import { shutdownOnSignal } from "../../src/serve";

shutdownOnSignal({
  shutdown: () => {
    console.log("stopping");
    return new Promise<void>(() => {});
  },
});
setInterval(() => {}, 1000);
console.log("ready");
