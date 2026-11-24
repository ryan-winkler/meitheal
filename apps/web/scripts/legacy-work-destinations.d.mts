import type { Client } from "@libsql/client"
import type { WorkDestinations } from "../src/domains/tasks/integration-destinations"
export function enrollLegacyWorkDestinations(tx: Pick<Client, "execute">, legacyBoardId: string, now: number): Promise<WorkDestinations>
