-- ====================================================================
-- Email engine (2026-05-31): unified lifecycle email.
--   - email_templates    : editable templates with {{variable}} merge tags
--   - email_sequences    : an ordered drip, optionally fired by a trigger event
--   - email_sequence_steps : step_order + delay_minutes + which template
--   - email_enrollments  : one customer walking one sequence (step pointer + due time)
--   - email_sends        : outbox log (one row per attempted send)
--   - email_events       : Resend delivery webhooks (delivered/bounced/complained/...)
--   - email_suppression  : do-not-send list (unsubscribe / bounce / complaint / manual)
-- All additive + idempotent (CREATE IF NOT EXISTS). Seeds live in email_engine.js.
-- ====================================================================

CREATE TABLE IF NOT EXISTS email_templates (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT,
  category TEXT NOT NULL DEFAULT 'lifecycle',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_sequences (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  trigger_event TEXT,                 -- e.g. 'first_purchase'; NULL = manual enroll only
  active BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_sequence_steps (
  id SERIAL PRIMARY KEY,
  sequence_id INTEGER NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  template_key TEXT NOT NULL,
  delay_minutes INTEGER NOT NULL DEFAULT 0,  -- delay measured from the previous step (or enrollment for step 1)
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sequence_id, step_order)
);
CREATE INDEX IF NOT EXISTS email_steps_seq_idx ON email_sequence_steps(sequence_id, step_order);

CREATE TABLE IF NOT EXISTS email_enrollments (
  id SERIAL PRIMARY KEY,
  sequence_id INTEGER NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','cancelled','unsubscribed')),
  current_step INTEGER NOT NULL DEFAULT 0,    -- count of steps already sent
  next_send_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,  -- merge vars: customer_name, order_id, code, ...
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Only one ACTIVE enrollment per (sequence, email); completed/cancelled rows may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS email_enroll_active_uniq
  ON email_enrollments(sequence_id, lower(email))
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS email_enroll_due_idx
  ON email_enrollments(status, next_send_at);

CREATE TABLE IF NOT EXISTS email_sends (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  template_key TEXT,
  sequence_id INTEGER REFERENCES email_sequences(id),
  enrollment_id INTEGER REFERENCES email_enrollments(id),
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sent','failed','skipped')),
  resend_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS email_sends_email_idx ON email_sends(lower(email), created_at DESC);
CREATE INDEX IF NOT EXISTS email_sends_status_idx ON email_sends(status, created_at DESC);

CREATE TABLE IF NOT EXISTS email_events (
  id SERIAL PRIMARY KEY,
  resend_id TEXT,
  email TEXT,
  type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_events_email_idx ON email_events(lower(email), created_at DESC);

CREATE TABLE IF NOT EXISTS email_suppression (
  email TEXT PRIMARY KEY,             -- always stored lower-cased
  reason TEXT NOT NULL,               -- unsubscribe | bounce | complaint | manual
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
