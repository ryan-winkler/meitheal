const maxTicketNumber = Number.MAX_SAFE_INTEGER

// Use in a single-task INSERT or UPDATE. The trigger rejects exhaustion before RETURNING.
export const nextHouseholdTicketNumberSql = `(SELECT COALESCE((
  SELECT ticket_high_water + 1 FROM main.task_boards WHERE id = 'household'
), 0))`

const numberedHouseholdTask = "NEW.task_board_id IS NULL AND NEW.ticket_number IS NOT NULL"
const advanceHouseholdTicket = `BEGIN
  SELECT CASE
    WHEN typeof(NEW.ticket_number) <> 'integer' OR NEW.ticket_number < 1
      THEN RAISE(ABORT, 'Household ticket number must be a positive integer')
    WHEN NEW.ticket_number > ${maxTicketNumber}
      THEN RAISE(ABORT, 'Household ticket number limit reached')
    WHEN NEW.ticket_number IS NOT ${nextHouseholdTicketNumberSql}
      THEN RAISE(ABORT, 'Expected the next Household ticket number')
  END;
  UPDATE task_boards SET ticket_high_water = NEW.ticket_number WHERE id = 'household';
  SELECT CASE WHEN (SELECT ticket_high_water FROM task_boards WHERE id = 'household') IS NOT NEW.ticket_number
    THEN RAISE(ABORT, 'Household ticket high-water did not advance') END;
END`

const ticketTriggers = {
  tasks_household_ticket_insert: `CREATE TRIGGER tasks_household_ticket_insert AFTER INSERT ON main.tasks
    WHEN ${numberedHouseholdTask}
    ${advanceHouseholdTicket}`,
  tasks_household_ticket_update: `CREATE TRIGGER tasks_household_ticket_update AFTER UPDATE OF ticket_number ON main.tasks
    WHEN ${numberedHouseholdTask} AND NEW.ticket_number IS NOT OLD.ticket_number
    ${advanceHouseholdTicket}`,
}

export const taskBoardTicketTriggerNames = Object.freeze(Object.keys(ticketTriggers))

// Keep unsafe SQLite integers in SQL. Returning one to the adapter would throw.
const householdTicketEvidence = `WITH creation_events AS (
  SELECT CASE WHEN json_valid(payload) THEN payload END AS payload
  FROM main.domain_events WHERE event_type = 'task.created' COLLATE BINARY
), event_fields AS (
  SELECT json_extract(payload, '$.ticket_number') AS number,
    json_type(payload, '$.ticket_number') AS number_kind,
    json_extract(payload, '$.ticket_key') AS key
  FROM creation_events
), event_tickets AS (
  SELECT number, number_kind, key, CAST(substr(key, 5) AS INTEGER) AS key_number FROM event_fields
), ticket_floor AS (SELECT MAX(
  COALESCE((
    SELECT MAX(ticket_number) FROM main.tasks
    WHERE typeof(ticket_number) = 'integer' AND ticket_number BETWEEN 1 AND ${maxTicketNumber}
  ), 0),
  COALESCE((
    SELECT MAX(MAX(
      CASE WHEN number_kind = 'integer' AND typeof(number) = 'integer' AND number BETWEEN 1 AND ${maxTicketNumber}
        THEN number ELSE 0 END,
      CASE WHEN typeof(key) = 'text' AND key_number BETWEEN 1 AND ${maxTicketNumber}
        AND key COLLATE BINARY = 'MTH-' || key_number THEN key_number ELSE 0 END
    )) FROM event_tickets
  ), 0)
) AS value)`

const seedHouseholdTickets = `${householdTicketEvidence}
  UPDATE main.task_boards SET ticket_high_water = MAX(ticket_high_water, (SELECT value FROM ticket_floor))
  WHERE id = 'household'`

/** Install inside the Board migration's write transaction. */
export async function applyTaskBoardTicketAllocator(tx) {
  if (typeof tx.commit !== "function" || tx.closed) throw new Error("Household ticket storage requires a write transaction")
  await tx.batch([seedHouseholdTickets, ...Object.values(ticketTriggers)])
  await validateTaskBoardTicketAllocator(tx)
}

export async function validateTaskBoardTicketAllocator(db) {
  const { rows: triggers } = await db.execute({
    sql: `SELECT name, type, tbl_name, sql FROM main.sqlite_schema
      WHERE name IN (${taskBoardTicketTriggerNames.map(() => "?").join(", ")})`,
    args: [...taskBoardTicketTriggerNames],
  })
  for (const [name, sql] of Object.entries(ticketTriggers)) {
    const trigger = triggers.find(row => row.name === name)
    if (trigger?.type !== "trigger" || trigger.tbl_name !== "tasks" || trigger.sql !== sql) {
      throw new Error(`Unexpected Household ticket trigger: ${name}`)
    }
  }

  const { rows: [household] } = await db.execute(`${householdTicketEvidence} SELECT
    typeof(ticket_high_water) = 'integer' AND ticket_high_water BETWEEN 0 AND ${maxTicketNumber} AS valid,
    ticket_high_water < (SELECT value FROM ticket_floor) AS behind
    FROM main.task_boards WHERE id = 'household' AND ticket_prefix = 'MTH'`)
  if (household?.valid !== 1 || household.behind !== 0) throw new Error("Invalid Household ticket high-water mark")
}
