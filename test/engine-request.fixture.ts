// ---
// relationships:
//   verifies: engine-and-run-model
// ---
// A separate process sends requests to Heddle's writer; it never opens SQLite.
process.on("message", () => {
  process.disconnect();
});
process.send?.({ runId: "shipment-1", nodeId: "inspect", result: "handoff" });
