import {
  BaseProcessor,
  TelemetryEventProcessor,
  EventPayload,
} from "./classes-exercises";

async function main() {
  const p1 = new TelemetryEventProcessor("Processor-1", 5);
  const p2 = new TelemetryEventProcessor("Processor-2", 5);

  const events: EventPayload[] = [
    { id: "1", type: "LOGIN", timestamp: Date.now(), data: {} },
    { id: "2", type: "LOGIN", timestamp: Date.now(), data: {} },
    { id: "1", type: "LOGIN", timestamp: Date.now(), data: {} }, // duplicate
  ];

  console.log("Before:", BaseProcessor.totalProcessedCount);

  console.log(await p1.processBatch(events)); // 2

  console.log("After P1:", BaseProcessor.totalProcessedCount); // 2

  console.log(await p2.processBatch(events)); // 2

  console.log("After P2:", BaseProcessor.totalProcessedCount); // 4

  p1.shutdown();

  console.log("P1 shutdown:", p1.isShutdown);

  console.log("Brand check:", BaseProcessor.isBaseProcessor(p1));
}

main().catch(console.error);
