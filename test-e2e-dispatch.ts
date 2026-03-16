import { IntegrationBus } from "./packages/integration-core/src/index.ts";
import { registerWebhookDispatcher } from "./apps/web/src/lib/webhook-dispatcher.ts";

async function run() {
  await registerWebhookDispatcher();
  console.log("Registered dispatcher, emitting task.created event...");
  
  const bus = IntegrationBus.getInstance();
  await bus.emit({
    eventId: crypto.randomUUID(),
    eventType: "task.created",
    occurredAt: new Date().toISOString(),
    payload: {
      task_id: "e2e-test-1",
      title: "End-to-End n8n Test Task",
      status: "todo",
      task_type: "task"
    }
  });
  
  console.log("Emitted.");
}
run().catch(console.error);
