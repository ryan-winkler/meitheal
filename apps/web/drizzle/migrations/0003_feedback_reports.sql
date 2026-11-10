CREATE TABLE IF NOT EXISTS feedback_reports (
  id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL,
  submitter_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes > 0),
  category TEXT NOT NULL CHECK (category IN ('problem', 'accessibility', 'suggestion', 'other')),
  message TEXT NOT NULL,
  app_version TEXT,
  route_family TEXT,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'in_progress', 'resolved', 'declined')),
  claimed_by TEXT,
  closed_by TEXT,
  disposition TEXT,
  UNIQUE (installation_id, submitter_id, submission_id),
  CHECK (
    (state = 'open' AND claimed_by IS NULL AND closed_by IS NULL AND disposition IS NULL)
    OR (state = 'in_progress' AND claimed_by IS NOT NULL AND closed_by IS NULL AND disposition IS NULL)
    OR (state IN ('resolved', 'declined') AND claimed_by IS NOT NULL AND closed_by IS NOT NULL
      AND disposition IS NOT NULL AND length(trim(disposition)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_feedback_reports_queue
  ON feedback_reports (installation_id, created_at DESC, id DESC);
