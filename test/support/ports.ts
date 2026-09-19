// ---
// relationships:
//   verifies: command-line-interface
// ---
import { createServer } from "node:net";

/** Reserve, then release, a loopback port so a fixture can bind it explicitly. */
export async function freePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === "string")
    throw new Error("Cannot reserve a fixture port");
  const { port } = address;
  await new Promise<void>((resolve) =>
    reservation.close(() => {
      resolve();
    }),
  );
  return port;
}
