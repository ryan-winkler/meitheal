export const principleTableSql = `
  CREATE TABLE IF NOT EXISTS principles (
    id TEXT PRIMARY KEY,
    pillar_id TEXT NOT NULL,
    statement TEXT NOT NULL,
    is_non_negotiable INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (pillar_id) REFERENCES pillars(id) ON DELETE CASCADE
  )
`

export const pillarAssociationTableSql = `
  CREATE TABLE IF NOT EXISTS pillar_associations (
    id TEXT PRIMARY KEY,
    pillar_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (pillar_id) REFERENCES pillars(id) ON DELETE CASCADE,
    UNIQUE(pillar_id, entity_type, entity_id)
  )
`
