-- ============================================================================
-- Reviews + discount engine migration (2026-05-30; full review-acquisition flow)
-- reviews: customer reviews with moderation + publish consent
-- discount_codes: single-use per-customer codes (50% win-back) gated to a Stripe coupon
-- orders: review_email_sent_at (dedupe the day-after email) + review_token (link the review page to an order)
-- Idempotent: CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS reviews (
  id              SERIAL PRIMARY KEY,
  order_id        INTEGER REFERENCES orders(id),
  email           TEXT,
  rating          INTEGER CHECK (rating BETWEEN 1 AND 5),
  title           TEXT,
  body            TEXT,
  photo_url       TEXT,
  consent_publish BOOLEAN NOT NULL DEFAULT FALSE,
  display_name    TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  moderated_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, created_at DESC);

CREATE TABLE IF NOT EXISTS discount_codes (
  id            SERIAL PRIMARY KEY,
  code          TEXT UNIQUE NOT NULL,
  email         TEXT,
  order_id      INTEGER REFERENCES orders(id),
  percent_off   INTEGER NOT NULL DEFAULT 50,
  stripe_coupon TEXT NOT NULL DEFAULT 'REVIEW50',
  expires_at    TIMESTAMPTZ,
  used          BOOLEAN NOT NULL DEFAULT FALSE,
  used_order_id INTEGER REFERENCES orders(id),
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_discount_codes_code ON discount_codes(code);
CREATE INDEX IF NOT EXISTS idx_discount_codes_email ON discount_codes(email);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_email_sent_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_token TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_review_token ON orders(review_token);
