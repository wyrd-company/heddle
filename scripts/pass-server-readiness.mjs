// ---
// relationships:
//   verifies: node-types
// ---
// Fixture-only readiness notification from the actual bound HTTP listener.
import { Server } from "node:http";
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once("listening", () => {
    const address = this.address();
    if (process.connected && address && typeof address === "object")
      process.send?.({ fixtureHttpPort: address.port });
  });
  return Reflect.apply(listen, this, args);
};
