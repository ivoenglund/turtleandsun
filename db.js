const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      preview_count INTEGER DEFAULT 0,
      has_purchased BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      style_id VARCHAR(255),
      product VARCHAR(255),
      status VARCHAR(50) DEFAULT 'pending',
      amount NUMERIC(10, 2),
      result_url TEXT,
      result_video_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id SERIAL PRIMARY KEY,
      style_id VARCHAR(255),
      style_name VARCHAR(255),
      description TEXT,
      example_image_url TEXT,
      category VARCHAR(50),
      prompt_text TEXT NOT NULL,
      fal_model VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_roles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'moderator', 'viewer')),
      granted_by VARCHAR(255),
      granted_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, role)
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      token VARCHAR(64) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      google_id TEXT,
      name TEXT,
      email TEXT,
      phone TEXT,
      street TEXT,
      city TEXT,
      country TEXT,
      postal_code TEXT,
      birthday TEXT,
      is_placeholder BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, google_id)
    );

    CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relationship_types (
      id SERIAL PRIMARY KEY,
      group_id INTEGER REFERENCES groups(id),
      name TEXT NOT NULL,
      mirror_id INTEGER REFERENCES relationship_types(id)
    );

    CREATE TABLE IF NOT EXISTS contact_relationships (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      contact_a_id INTEGER NOT NULL,
      contact_b_id INTEGER NOT NULL,
      relationship_type_id INTEGER REFERENCES relationship_types(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contact_group_memberships (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      contact_id INTEGER NOT NULL,
      group_id INTEGER REFERENCES groups(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, contact_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS occasions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      contact_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      start_date DATE NOT NULL,
      frequency TEXT NOT NULL CHECK (frequency IN ('yearly', 'milestone', 'one-time')),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS visits (
      id SERIAL PRIMARY KEY,
      ip TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER,
      user_agent TEXT,
      referrer TEXT,
      country TEXT,
      region TEXT,
      city TEXT,
      lat REAL,
      lng REAL,
      user_id INTEGER REFERENCES users(id),
      request_id TEXT,
      flagged BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS failed_deliveries (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id),
      email TEXT,
      product TEXT,
      portrait_url TEXT,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      resolved BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ip_labels (
      ip TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS concept_media (
      id SERIAL PRIMARY KEY,
      concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      kind VARCHAR(20) NOT NULL CHECK (kind IN ('image', 'video', 'card', 'book')),
      url TEXT NOT NULL,
      thumbnail_url TEXT,
      caption TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_primary BOOLEAN NOT NULL DEFAULT FALSE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS concepts (
      id SERIAL PRIMARY KEY,
      slug VARCHAR(64) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      filter_category VARCHAR(64) NOT NULL,
      input_type VARCHAR(20) NOT NULL DEFAULT 'image_video',
      before_image_url TEXT,
      after_image_url TEXT,
      example_video_url TEXT,
      image_prompt TEXT NOT NULL,
      video_prompt TEXT,
      fal_image_model VARCHAR(255) DEFAULT 'fal-ai/kling-image/o1',
      fal_video_model VARCHAR(255) DEFAULT 'fal-ai/kling-video/v3/pro/image-to-video',
      social_caption TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      user_input_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      user_input_label VARCHAR(255),
      user_input_placeholder VARCHAR(255),
      user_input_variable VARCHAR(64),
      user_input_max_length INTEGER DEFAULT 50,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_visits_created_at ON visits(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_visits_ip ON visits(ip);
    CREATE INDEX IF NOT EXISTS idx_visits_flagged ON visits(flagged) WHERE flagged = true;
    CREATE INDEX IF NOT EXISTS idx_failed_deliveries_resolved ON failed_deliveries(resolved) WHERE resolved = false;
    CREATE INDEX IF NOT EXISTS concepts_active_sort_idx ON concepts(active, sort_order);
    CREATE INDEX IF NOT EXISTS concept_media_concept_idx ON concept_media(concept_id, sort_order);
    CREATE INDEX IF NOT EXISTS concept_media_kind_active_idx ON concept_media(kind, active);
  `);

  // Webhook idempotency — records each processed Stripe event id so retried
  // webhook deliveries are ignored (no double order / double generation).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_webhook_events (
      event_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Key-value system settings used by admin features (dev mode, etc.). The
  // dev_mode flag MUST default to 'false' so a fresh deploy is never in dev mode.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO system_settings (key, value)
      VALUES ('dev_mode', 'false')
      ON CONFLICT (key) DO NOTHING;
  `);

  // Migrate existing tables to add new columns
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS result_url TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS result_video_url TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS input_asset_url TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS output_asset_url TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS output_video_asset_url TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS asset_status VARCHAR(20) DEFAULT 'pending';
    ALTER TABLE generations ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE generations ADD COLUMN IF NOT EXISTS flag_note TEXT;
    ALTER TABLE generations ADD COLUMN IF NOT EXISTS tiktok_thumbnail_url TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'sek';
    ALTER TABLE prompts ADD COLUMN IF NOT EXISTS style_name VARCHAR(255);
    ALTER TABLE prompts ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE prompts ADD COLUMN IF NOT EXISTS example_image_url TEXT;
    ALTER TABLE prompts ADD COLUMN IF NOT EXISTS category VARCHAR(50);
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS id SERIAL;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN DEFAULT FALSE;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS street TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS city TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS country TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS postal_code TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS birthday TEXT;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS category TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS died_on DATE;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_pet BOOLEAN DEFAULT FALSE;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS parent_group_id INTEGER REFERENCES groups(id);
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_me BOOLEAN DEFAULT FALSE;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS street_2 TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS region TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS photo_url TEXT;
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS user_input_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS user_input_label VARCHAR(255);
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS user_input_placeholder VARCHAR(255);
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS user_input_variable VARCHAR(64);
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS user_input_max_length INTEGER DEFAULT 50;
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS provider VARCHAR(32) NOT NULL DEFAULT 'fal';
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS image_input_extras JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS video_input_extras JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE concepts ALTER COLUMN filter_category TYPE TEXT;
    ALTER TABLE concept_media ADD COLUMN IF NOT EXISTS filter_category TEXT;
    ALTER TABLE concept_media ADD COLUMN IF NOT EXISTS source_url TEXT;
    ALTER TABLE visits ADD COLUMN IF NOT EXISTS engaged BOOLEAN NOT NULL DEFAULT FALSE;

    -- 2026-07-12: Studio — free-text "About" per contact (yearbook portrait text)
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS about TEXT;

    -- 2026-07-12: Studio timeline blog — posts with photos and free-form tags.
    -- Tags double as filters: include/exclude sets in the timeline and yearbook
    -- (e.g. print everything except tag "private").
    CREATE TABLE IF NOT EXISTS blog_posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT,
      body TEXT,
      post_date DATE NOT NULL DEFAULT CURRENT_DATE,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      photos JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_blog_posts_user ON blog_posts(user_id, post_date);

    -- 2026-06-30: Turtle Studio groups — dated, status-aware memberships.
    -- A membership now carries a from/to date range (so the same model handles
    -- ongoing groups, ended memberships, and historical/dated groups like school
    -- classes & alumni), a lifecycle status, and a self_managed flag for members
    -- who maintain their own row via a fill-in link. All additive; existing rows
    -- default to status='active', self_managed=false, NULL dates (= today's behaviour).
    ALTER TABLE contact_group_memberships ADD COLUMN IF NOT EXISTS from_date    DATE;
    ALTER TABLE contact_group_memberships ADD COLUMN IF NOT EXISTS to_date      DATE;
    ALTER TABLE contact_group_memberships ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE contact_group_memberships ADD COLUMN IF NOT EXISTS self_managed BOOLEAN NOT NULL DEFAULT FALSE;

    -- Self-service fill-in links: one shareable token per group. Members open the
    -- link to add or update their own contact details and membership (no login).
    CREATE TABLE IF NOT EXISTS group_share_links (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id),
      group_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      token       VARCHAR(64) NOT NULL UNIQUE,
      active      BOOLEAN DEFAULT TRUE,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS group_share_links_group_idx ON group_share_links(group_id);

    -- 2026-05-30: triplets — a triplet = (before image, after picture, after video)
    -- attached to a concept. The widget cycles through in_rolling_demo=TRUE triplets
    -- as customers stay on the page, so different subjects (dogs, people, etc.) cycle
    -- under each concept rather than one fixed example.
    CREATE TABLE IF NOT EXISTS concept_triplets (
      id              SERIAL PRIMARY KEY,
      concept_id      INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      triplet_number  INTEGER NOT NULL,
      sort_order      INTEGER NOT NULL DEFAULT 0,
      in_rolling_demo BOOLEAN NOT NULL DEFAULT TRUE,
      before_media_id INTEGER REFERENCES concept_media(id) ON DELETE SET NULL,
      image_media_id  INTEGER REFERENCES concept_media(id) ON DELETE SET NULL,
      video_media_id  INTEGER REFERENCES concept_media(id) ON DELETE SET NULL,
      caption         TEXT,
      created_at      TIMESTAMP DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS concept_triplets_concept_number_idx ON concept_triplets(concept_id, triplet_number);
    CREATE INDEX IF NOT EXISTS concept_triplets_rolling_idx ON concept_triplets(concept_id, in_rolling_demo, sort_order);
    ALTER TABLE concept_triplets ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE concept_triplets ADD COLUMN IF NOT EXISTS in_gallery BOOLEAN NOT NULL DEFAULT TRUE;
  `);

  // ====================================================================
  // Infrastructure Foundation migration (2026-05-27).
  // Adds talking-pet support, multi-image refs, per-concept pricing,
  // FX rates, line-item orders, generation audit log, voice clones,
  // test subjects for the Lab. All additive, all idempotent.
  // See Claude_Workspace/03_Turtleandsun/01_Context/_INFRASTRUCTURE_FOUNDATION.md
  // ====================================================================
  await pool.query(`
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS talking_model VARCHAR(255);
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS speech_text TEXT;
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS voice_ids TEXT[];
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS reference_image_urls TEXT[];
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS talking_input_extras JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS price_tier VARCHAR(32);
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS unit_price_sek_minor INTEGER;
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS pricing_rules JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS test_subjects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      photo_url TEXT NOT NULL,
      notes TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS voice_clones (
      id SERIAL PRIMARY KEY,
      voice_id TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      source_audio_url TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('admin', 'customer')),
      user_id INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS generations (
      id SERIAL PRIMARY KEY,
      concept_id INTEGER REFERENCES concepts(id),
      model_id TEXT NOT NULL,
      input_payload JSONB NOT NULL,
      output_url TEXT,
      fal_output_url TEXT,
      cost_usd NUMERIC(10, 4),
      source_type TEXT NOT NULL CHECK (source_type IN ('admin_test', 'customer_order', 'lab_batch', 'preview')),
      user_id INTEGER REFERENCES users(id),
      order_id INTEGER REFERENCES orders(id),
      test_subject_id INTEGER REFERENCES test_subjects(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS fx_rates (
      base_currency TEXT NOT NULL,
      target_currency TEXT NOT NULL,
      rate NUMERIC(14, 8) NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT,
      PRIMARY KEY (base_currency, target_currency, fetched_at)
    );

    CREATE TABLE IF NOT EXISTS order_line_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      concept_id INTEGER REFERENCES concepts(id),
      product_key VARCHAR(64),
      quantity INTEGER NOT NULL DEFAULT 1,
      recipients JSONB,
      modifiers JSONB,
      unit_price_sek_minor INTEGER NOT NULL,
      total_sek_minor INTEGER NOT NULL,
      display_currency VARCHAR(3) NOT NULL,
      display_price_minor INTEGER NOT NULL,
      fx_rate_used NUMERIC(14, 8) NOT NULL DEFAULT 1.0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_generations_concept ON generations (concept_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generations_user ON generations (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generations_order ON generations (order_id);
    CREATE INDEX IF NOT EXISTS idx_generations_source ON generations (source_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generations_status ON generations (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fx_latest ON fx_rates (base_currency, target_currency, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_line_items_order ON order_line_items (order_id);
    CREATE INDEX IF NOT EXISTS idx_voice_clones_user ON voice_clones (user_id);
  `);

  // ====================================================================
  // Occasions engine (2026-05-30). National/location occasions table +
  // campaign send/print queue, plus a 36-row seed of national occasions.
  // Schema and seed live in migrations/occasions_engine.sql (single source
  // of truth); idempotent (CREATE IF NOT EXISTS / ON CONFLICT DO NOTHING).
  // Personal occasions use the existing `occasions` table.
  // See Claude_Workspace/03_Turtleandsun/01_Context/_POST_LAUNCH_FEATURES.md #22
  // ====================================================================
  await pool.query(
    require('fs').readFileSync(
      require('path').join(__dirname, 'migrations', 'occasions_engine.sql'),
      'utf8'
    )
  );

  // Reviews + discount engine (2026-05-30). reviews, discount_codes tables +
  // orders.review_email_sent_at / review_token. See migrations/reviews_engine.sql
  await pool.query(
    require('fs').readFileSync(
      require('path').join(__dirname, 'migrations', 'reviews_engine.sql'),
      'utf8'
    )
  );

  // Email engine (2026-05-31). Unified lifecycle email: templates, sequences,
  // enrollments, sends, delivery events, suppression. See migrations/email_engine.sql
  await pool.query(
    require('fs').readFileSync(
      require('path').join(__dirname, 'migrations', 'email_engine.sql'),
      'utf8'
    )
  );

  // Backfill: every existing order without line items gets one synthetic line
  // item matching its current product + amount. Idempotent (guarded by
  // NOT EXISTS on order_line_items.order_id).
  await pool.query(`
    INSERT INTO order_line_items (
      order_id, product_key, quantity,
      unit_price_sek_minor, total_sek_minor,
      display_currency, display_price_minor, fx_rate_used, created_at
    )
    SELECT
      o.id,
      o.product,
      1,
      COALESCE(ROUND(o.amount * 100)::INT, 0),
      COALESCE(ROUND(o.amount * 100)::INT, 0),
      COALESCE(o.currency, 'sek'),
      COALESCE(ROUND(o.amount * 100)::INT, 0),
      1.0,
      o.created_at
    FROM orders o
    WHERE NOT EXISTS (
      SELECT 1 FROM order_line_items li WHERE li.order_id = o.id
    )
      AND o.product IS NOT NULL
  `);


  // ====================================================================
  // Currencies table — DB-driven currency catalogue (2026-05-28).
  // Each row is one supported currency. Replaces the hardcoded
  // CHARM_LADDERS / FALLBACK_RATES / SUPPORTED_CURRENCIES sets that
  // previously lived in code only. Code constants stay as final fallback
  // if the table is empty.
  // ====================================================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS currencies (
      code TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      symbol_position TEXT NOT NULL DEFAULT 'after' CHECK (symbol_position IN ('before', 'after')),
      decimal_places INTEGER NOT NULL DEFAULT 2 CHECK (decimal_places >= 0 AND decimal_places <= 4),
      charm_ladder JSONB NOT NULL DEFAULT '[]'::jsonb,
      fallback_rate NUMERIC(14, 8) NOT NULL DEFAULT 1.0,
      country_codes TEXT[] NOT NULL DEFAULT '{}',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_currencies_active ON currencies (active, sort_order);
  `);

  // Social clips — before/after video clips for TikTok, Reels, Shorts.
  // Rows are created by queuing a concept_triplet; generation happens in-process via ffmpeg.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_clips (
      id                  SERIAL PRIMARY KEY,
      triplet_id          INTEGER REFERENCES concept_triplets(id) ON DELETE SET NULL,
      concept_id          INTEGER REFERENCES concepts(id) ON DELETE SET NULL,
      concept_name        TEXT,
      before_url          TEXT,
      after_video_url     TEXT,
      after_image_url     TEXT,
      status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','processing','done','error')),
      output_url          TEXT,
      end_card_url        TEXT,
      panel_url           TEXT,
      video_overlay_text  TEXT,
      before_y_offset     INTEGER NOT NULL DEFAULT 0,
      after_y_offset      INTEGER NOT NULL DEFAULT 0,
      before_pct          NUMERIC(6,2) NOT NULL DEFAULT 40,
      end_card_duration_s NUMERIC(6,2) NOT NULL DEFAULT 4,
      published_tiktok    BOOLEAN NOT NULL DEFAULT FALSE,
      published_instagram BOOLEAN NOT NULL DEFAULT FALSE,
      published_youtube   BOOLEAN NOT NULL DEFAULT FALSE,
      published_facebook  BOOLEAN NOT NULL DEFAULT FALSE,
      tiktok_views        INTEGER,
      tiktok_likes        INTEGER,
      tiktok_shares       INTEGER,
      tiktok_comments     INTEGER,
      instagram_views     INTEGER,
      instagram_likes     INTEGER,
      instagram_shares    INTEGER,
      instagram_comments  INTEGER,
      youtube_views       INTEGER,
      youtube_likes       INTEGER,
      youtube_comments    INTEGER,
      stats_refreshed_at  TIMESTAMPTZ,
      error_msg           TEXT,
      clip_style          INTEGER NOT NULL DEFAULT 1,
      show_before_s       NUMERIC(6,2) NOT NULL DEFAULT 1.0,
      rise_duration_s     NUMERIC(6,2) NOT NULL DEFAULT 1.0,
      rise_pause_s        NUMERIC(6,2) NOT NULL DEFAULT 3.0,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_social_clips_status     ON social_clips (status);
    CREATE INDEX IF NOT EXISTS idx_social_clips_created_at ON social_clips (created_at DESC);
    -- Migration: add new columns to existing tables
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS clip_style      INTEGER      NOT NULL DEFAULT 1;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS show_before_s   NUMERIC(6,2) NOT NULL DEFAULT 1.0;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS rise_duration_s NUMERIC(6,2) NOT NULL DEFAULT 1.0;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS rise_pause_s    NUMERIC(6,2) NOT NULL DEFAULT 3.0;
  `);

  // Seed the four launch currencies if the table is empty. After seeding,
  // edits happen via /admin/currencies. The seed payloads match the legacy
  // hardcoded CHARM_LADDERS + FALLBACK_RATES exactly so behavior is
  // identical at deploy time.
  const curCount = await pool.query(`SELECT COUNT(*)::int AS n FROM currencies`);
  if (curCount.rows[0].n === 0) {
    const SEK_LADDER = JSON.stringify([
      9, 19, 29, 39, 49, 59, 69, 79, 89, 99,
      109, 119, 129, 139, 149, 159, 169, 179, 189, 199,
      229, 249, 279, 299, 329, 349, 379, 399, 449, 499,
      549, 599, 649, 699, 749, 799, 849, 899, 949, 999,
      1099, 1199, 1299, 1399, 1499, 1699, 1799, 1899, 1999,
      2299, 2499, 2799, 2999, 3499, 3999, 4499, 4999,
      5999, 6999, 7999, 8999, 9999, 14999, 19999, 24999, 29999
    ]);
    const DOT99_LADDER = JSON.stringify([
      0.99, 1.99, 2.99, 3.99, 4.99, 5.99, 6.99, 7.99, 8.99, 9.99,
      10.99, 11.99, 12.99, 13.99, 14.99, 15.99, 16.99, 17.99, 18.99, 19.99,
      21.99, 24.99, 27.99, 29.99, 34.99, 39.99, 44.99, 49.99,
      54.99, 59.99, 64.99, 69.99, 74.99, 79.99, 84.99, 89.99, 94.99, 99.99,
      109.99, 119.99, 129.99, 149.99, 169.99, 199.99,
      249.99, 299.99, 349.99, 399.99, 499.99, 699.99, 999.99
    ]);
    // EU country codes used by pickCurrency.
    const EU = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES'];
    await pool.query(
      `INSERT INTO currencies (code, display_name, symbol, symbol_position, decimal_places, charm_ladder, fallback_rate, country_codes, active, sort_order)
       VALUES
         ('sek', 'Swedish krona',  'kr', 'after',  0, $1::jsonb, 1.0,   $5::text[], TRUE, 1),
         ('usd', 'US Dollar',      '$',  'before', 2, $2::jsonb, 0.094, $6::text[], TRUE, 2),
         ('eur', 'Euro',           E'\\u20AC', 'before', 2, $3::jsonb, 0.087, $7::text[], TRUE, 3),
         ('gbp', 'British Pound',  E'\\u00A3', 'before', 2, $4::jsonb, 0.075, $8::text[], TRUE, 4)`,
      [SEK_LADDER, DOT99_LADDER, DOT99_LADDER, DOT99_LADDER, ['SE'], ['US'], EU, ['GB']]
    );
    console.log('Seeded currencies: sek, usd, eur, gbp');
  }

  // Unique index on prompts.style_id for ON CONFLICT support
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS prompts_style_id_unique ON prompts (style_id);
  `);

  // Backfill: remove system-generated 'Me' name from is_me contacts
  await pool.query(`UPDATE contacts SET name = NULL WHERE is_me = TRUE AND name = 'Me'`);

  // Backfill: create is_me contact for every user that doesn't have one yet
  await pool.query(`
    INSERT INTO contacts (user_id, email, is_me)
    SELECT u.id, u.email, TRUE
    FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM contacts c WHERE c.user_id = u.id AND c.is_me = TRUE
    )
  `);

  // Seed the original Royal Portrait concept if the concepts table is empty.
  // Prompts are copied verbatim from the hardcoded values in server.js
  // (the /preview image prompt and ROYAL_VIDEO_PROMPT).
  const conceptCount = await pool.query(`SELECT COUNT(*)::int AS n FROM concepts`);
  if (conceptCount.rows[0].n === 0) {
    await pool.query(
      `INSERT INTO concepts (slug, name, filter_category, input_type, image_prompt, video_prompt, active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        'royal-portrait',
        'Royal Portrait',
        'royal',
        'image_video',
        'Transform @Image1 into a royal portrait painting wearing an ornate golden crown and red velvet royal robes, set in a grand palace. Preserve the exact face and identity of the person in @Image1. Oil painting style, highly detailed.',
        'The royal portrait painting slowly comes to life — subtle movement in the regal robes and hair, ' +
          'dramatic candlelight flickering across the face, eyes gently alive with regal presence. ' +
          'Cinematic depth of field, atmospheric palace setting with soft volumetric light. ' +
          'Painterly and majestic, museum-quality motion. Preserve the exact face and identity of the subject.',
        true,
        1,
      ]
    );
    console.log('Seeded Royal Portrait concept');
  }

  // Seed the first talking-pet concept (Birthday template) if it doesn't
  // exist yet. The 2026-05-27 infrastructure foundation introduced talking
  // concepts; this seed provides the first row so admin + customer flows
  // can be tested end-to-end. Kling v3 Pro, English script with {name}
  // placeholder, 149 kr (default 'talking' tier — falls back to PRICE_TIERS
  // since price_tier is NULL).
  const talkingExists = await pool.query(
    `SELECT 1 FROM concepts WHERE slug = 'talking-pet-birthday' LIMIT 1`
  );
  if (talkingExists.rowCount === 0) {
    await pool.query(
      `INSERT INTO concepts (
         slug, name, filter_category, input_type,
         image_prompt, video_prompt,
         fal_video_model, talking_model, speech_text,
         price_tier, active, sort_order, description
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6,
         $7, $8, $9,
         $10, $11, $12, $13
       )`,
      [
        'talking-pet-birthday',
        'Talking Pet — Birthday',
        'pets,celebration,talking',
        'talking',
        // image_prompt: not used for talking but column is NOT NULL — keep a
        // sensible default so the row is valid.
        'A warm portrait of @Image1 looking gently at the camera.',
        // video_prompt: visual scene description, combined with speech_text
        // at runtime by generation.js composeTalkingPrompt().
        'A friendly pet looks directly at the camera with bright, expressive eyes and a gentle, joyful expression. Warm soft light, shallow depth of field, cinematic atmosphere.',
        'fal-ai/kling-video/v3/pro/image-to-video',
        'fal-ai/kling-video/v3/pro/image-to-video__talking',
        // speech_text: customer-typed name substitutes for {name}; if blank,
        // the leading ",{name}" is stripped cleanly by applyNamePlaceholder.
        "Happy birthday, {name}! You're my favourite human in the whole world. Many more years together.",
        // price_tier NULL means "use default for input_type" — talking maps
        // to PRICE_TIERS.talking (149 kr).
        null,
        false  /* seeded inactive until Friday flow wiring */ ,
        2,
        'Make your pet sing happy birthday. Personalize with a name.',
      ]
    );
    console.log('Seeded Talking Pet — Birthday concept');
  }

  // Seed Father's Day Portrait concept. Seeded inactive — flip active=TRUE
  // once gallery images (concept_media) are generated and attached.
  // June 21 deadline: activate by ~June 14 to allow social promo time.
  const fathersDayExists = await pool.query(
    `SELECT 1 FROM concepts WHERE slug = 'fathers-day-portrait' LIMIT 1`
  );
  if (fathersDayExists.rowCount === 0) {
    await pool.query(
      `INSERT INTO concepts (
         slug, name, filter_category, input_type,
         image_prompt, video_prompt,
         fal_image_model, fal_video_model,
         active, sort_order, description
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6,
         $7, $8,
         $9, $10, $11
       )`,
      [
        'fathers-day-portrait',
        "Father's Day Portrait",
        'family,celebration',
        'image_video',
        // image_prompt
        'Transform @Image1 into a warm, heroic heirloom oil painting portrait — the subject radiates strength, warmth, and gentle wisdom, like a beloved family patriarch. Rich warm tones, wood-panelled study backdrop with soft window light. Preserve the exact face and identity of the person in @Image1. Oil painting style, highly detailed, museum quality.',
        // video_prompt
        'The heirloom portrait gently comes to life — the subject\'s eyes soften with warmth, a subtle proud smile forming, warm candlelight flickering softly in the background. Cinematic depth of field, wood-panelled study atmosphere. Painterly and heartfelt. Preserve the exact face and identity of the subject.',
        'fal-ai/kling-image/o1',
        'fal-ai/kling-video/v3/pro/image-to-video',
        false, /* activate when gallery images are ready — target June 14 */
        3,
        "The family photo you always wanted. Transform a favourite photo into a timeless heirloom portrait — a Father's Day gift they'll keep forever.",
      ]
    );
    console.log("Seeded Father's Day Portrait concept");
  }

  // Seed Father's Day talking pet concepts (x3). All inactive until gallery
  // media is attached. Activate by ~June 14. speech_text uses {name} placeholder
  // for the dad's name (customer fills in at order time via user_input).
  const fdTalkingSlugs = [
    'fathers-day-talking-love',
    'fathers-day-talking-funny',
    'fathers-day-talking-proud',
  ];
  const fdTalkingExists = await pool.query(
    `SELECT slug FROM concepts WHERE slug = ANY($1)`, [fdTalkingSlugs]
  );
  const existingSlugs = new Set(fdTalkingExists.rows.map(r => r.slug));

  const fdTalkingConcepts = [
    {
      slug: 'fathers-day-talking-love',
      name: "Father's Day — Heartfelt",
      sort_order: 4,
      description: "Your pet says what your heart already knows. A warm, loving Father's Day message straight from your furry best friend.",
      speech_text: "Dad, I know I can't say it with words — but I want you to know. You are my whole world. Thank you for every walk, every cuddle, every moment. I love you, {name}. Happy Father's Day.",
    },
    {
      slug: 'fathers-day-talking-funny',
      name: "Father's Day — Funny",
      sort_order: 5,
      description: "Your pet has seen everything. The snoring, the bad jokes, the way you eat. And they still think you're the greatest.",
      speech_text: "{name}, listen. I've seen everything. The snoring. The bad jokes. The way you eat. And I still think you're the greatest human on the planet. Don't tell anyone I said that. Happy Father's Day.",
    },
    {
      slug: 'fathers-day-talking-proud',
      name: "Father's Day — Short & Sweet",
      sort_order: 6,
      description: "Short, proud, and straight to the point. Because some dads deserve all the words and some just need three.",
      speech_text: "World's best dad — right here. That's you, {name}. I'd fetch the whole world for you. Happy Father's Day.",
    },
  ];

  for (const c of fdTalkingConcepts) {
    if (existingSlugs.has(c.slug)) continue;
    await pool.query(
      `INSERT INTO concepts (
         slug, name, filter_category, input_type,
         image_prompt, video_prompt,
         fal_video_model, talking_model, speech_text,
         active, sort_order, description,
         user_input_enabled, user_input_label, user_input_placeholder, user_input_variable, user_input_max_length
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6,
         $7, $8, $9,
         $10, $11, $12,
         $13, $14, $15, $16, $17
       )`,
      [
        c.slug,
        c.name,
        'pets,celebration,fathers-day,talking',
        'talking',
        // image_prompt: not used for talking but column is NOT NULL
        'A warm portrait of @Image1 looking gently and joyfully at the camera.',
        // video_prompt: visual scene description
        'A friendly pet looks directly at the camera with bright, expressive eyes and a warm, loving expression. Soft natural light, shallow depth of field, cinematic and heartfelt atmosphere.',
        'fal-ai/kling-video/v3/pro/image-to-video',
        'fal-ai/kling-video/v3/pro/image-to-video__talking',
        c.speech_text,
        false, /* activate when gallery media ready — target June 14 */
        c.sort_order,
        c.description,
        true,             // user_input_enabled — customer types the dad's name
        "Dad's name",
        'e.g. Michael',
        'name',
        30,
      ]
    );
    console.log(`Seeded ${c.name} concept`);
  }

  // ====================================================================
  // Social Clips — DB-backed clip library with per-channel stats (2026-06-03)
  // ====================================================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_clips (
      id                    SERIAL PRIMARY KEY,
      triplet_id            INTEGER REFERENCES concept_triplets(id) ON DELETE SET NULL,
      concept_id            INTEGER REFERENCES concepts(id) ON DELETE SET NULL,
      concept_name          TEXT,

      -- Source URLs snapshotted at queue time
      before_url            TEXT,
      after_video_url       TEXT,

      -- Scene 1 settings
      label_before          TEXT        NOT NULL DEFAULT 'BEFORE',
      before_duration_s     NUMERIC     NOT NULL DEFAULT 3,

      -- Scene 2 settings
      label_after           TEXT        NOT NULL DEFAULT 'AFTER',
      show_labels           BOOLEAN     NOT NULL DEFAULT TRUE,

      -- Scene 3 — end card
      end_card_enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
      end_card_line1        TEXT        NOT NULL DEFAULT 'Turtle and Sun',
      end_card_line2        TEXT        NOT NULL DEFAULT 'Remember to love',
      show_logo             BOOLEAN     NOT NULL DEFAULT TRUE,
      end_card_duration_s   NUMERIC     NOT NULL DEFAULT 3,

      -- Output
      output_url            TEXT,
      status                TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','processing','done','error')),
      error_msg             TEXT,

      -- Publishing
      published_tiktok      BOOLEAN     NOT NULL DEFAULT FALSE,
      published_instagram   BOOLEAN     NOT NULL DEFAULT FALSE,
      published_youtube     BOOLEAN     NOT NULL DEFAULT FALSE,
      tiktok_video_id       TEXT,
      instagram_media_id    TEXT,
      youtube_video_id      TEXT,
      tiktok_post_url       TEXT,
      instagram_post_url    TEXT,
      youtube_post_url      TEXT,

      -- Per-channel stats (refreshed on demand / scheduled)
      tiktok_views          INTEGER,
      tiktok_likes          INTEGER,
      tiktok_shares         INTEGER,
      tiktok_comments        INTEGER,
      instagram_views       INTEGER,
      instagram_likes       INTEGER,
      instagram_shares      INTEGER,
      instagram_comments    INTEGER,
      youtube_views         INTEGER,
      youtube_likes         INTEGER,
      youtube_comments      INTEGER,
      stats_refreshed_at    TIMESTAMPTZ,

      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS social_clips_status_idx   ON social_clips(status);
    CREATE INDEX IF NOT EXISTS social_clips_triplet_idx  ON social_clips(triplet_id);
    CREATE INDEX IF NOT EXISTS social_clips_concept_idx  ON social_clips(concept_id);

    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS video_overlay_text TEXT DEFAULT 'Make your own →';
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS end_card_url TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS after_image_url TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS before_y_offset INTEGER DEFAULT 0;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS after_y_offset INTEGER DEFAULT 0;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS vignette_strength INTEGER DEFAULT 75;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS published_facebook BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS facebook_post_url TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS panel_url TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS before_pct NUMERIC(5,2) DEFAULT 40;
  `);

  // ====================================================================
  // Social Tracker — merged into social_clips (2026-06-05)
  // Drop the separate tracker tables (no data) and store everything on
  // social_clips + a clip_stats time-series table.
  // ====================================================================
  await pool.query(`
    DROP TABLE IF EXISTS tracker_stats;
    DROP TABLE IF EXISTS tracker_posts;
    DROP TABLE IF EXISTS tracker_clips;

    CREATE TABLE IF NOT EXISTS clip_stats (
      id              SERIAL PRIMARY KEY,
      social_clip_id  INTEGER NOT NULL REFERENCES social_clips(id) ON DELETE CASCADE,
      platform        TEXT NOT NULL,
      stat_date       DATE NOT NULL DEFAULT CURRENT_DATE,
      views           INTEGER NOT NULL DEFAULT 0,
      likes           INTEGER NOT NULL DEFAULT 0,
      comments        INTEGER NOT NULL DEFAULT 0,
      shares          INTEGER NOT NULL DEFAULT 0,
      source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','api')),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (social_clip_id, platform, stat_date)
    );

    CREATE TABLE IF NOT EXISTS channel_daily_stats (
      id          SERIAL PRIMARY KEY,
      platform    TEXT NOT NULL,
      stat_date   DATE NOT NULL DEFAULT CURRENT_DATE,
      subscribers INTEGER NOT NULL DEFAULT 0,
      total_views BIGINT NOT NULL DEFAULT 0,
      total_likes BIGINT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (platform, stat_date)
    );

    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS subject         TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS subject_name    TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS occasion        TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS mood            TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS custom_tags     TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS ref_tag         TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS tiktok_caption  TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS tiktok_hashtags TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS tiktok_post_url TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS tiktok_posted_at DATE;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS instagram_caption  TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS instagram_hashtags TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS instagram_alt_text TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS instagram_post_url TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS instagram_posted_at DATE;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS yt_title           TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS yt_description     TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS yt_keyword_tags    TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS yt_video_id        TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS yt_post_url        TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS yt_posted_at       DATE;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS fb_caption         TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS fb_post_url        TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS fb_posted_at       DATE;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS yt_scheduled_at    TIMESTAMPTZ;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS style              TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS notes              TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS facebook_views     INTEGER;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS tiktok_video_id    TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS instagram_media_id  TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS facebook_video_id   TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS style_c_intro_url TEXT;
  `);

  // Click attribution (2026-06-10): ?ref=<clip ref_tag>&src=<yt|tt|ig|fb> on
  // inbound links from social posts. Captured by the visits middleware.
  await pool.query(`
    ALTER TABLE visits ADD COLUMN IF NOT EXISTS ref TEXT;
    ALTER TABLE visits ADD COLUMN IF NOT EXISTS src TEXT;
    ALTER TABLE visits ADD COLUMN IF NOT EXISTS scroll_pct INTEGER;
    ALTER TABLE visits ADD COLUMN IF NOT EXISTS dwell_ms INTEGER;
    CREATE INDEX IF NOT EXISTS idx_visits_ref ON visits(ref) WHERE ref IS NOT NULL;
  `);

  // Concept dimensions (2026-06-11): every concept is a coordinate in
  // subject x occasion x action space. Replaces the comma-separated
  // filter_category as the source of truth for filtering and pickers.
  await pool.query(`
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS subject  TEXT NOT NULL DEFAULT 'pet';
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS occasion TEXT NOT NULL DEFAULT 'general';
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS action   TEXT NOT NULL DEFAULT 'royal-portrait';
    ALTER TABLE concepts ADD COLUMN IF NOT EXISTS mood     TEXT NOT NULL DEFAULT 'heartfelt';
    ALTER TABLE concept_media ADD COLUMN IF NOT EXISTS subject TEXT;
  `);
  // One-time backfill from slug patterns (idempotent: only rows still on defaults)
  await pool.query(`
    UPDATE concepts SET occasion = 'fathers-day' WHERE slug ILIKE '%father%' AND occasion = 'general';
    UPDATE concepts SET occasion = 'mothers-day' WHERE slug ILIKE '%mother%' AND occasion = 'general';
    UPDATE concepts SET occasion = 'birthday'    WHERE slug ILIKE '%birthday%' AND occasion = 'general';
    UPDATE concepts SET occasion = 'christmas'   WHERE slug ILIKE '%christmas%' AND occasion = 'general';
    UPDATE concepts SET action = 'talking' WHERE (slug ILIKE '%talking%' OR name ILIKE '%talking%') AND action = 'royal-portrait';
    UPDATE concepts SET action = 'singing' WHERE (slug ILIKE '%singing%' OR name ILIKE '%singing%') AND action = 'royal-portrait';
    UPDATE concepts SET subject = 'human' WHERE slug ILIKE '%person%' OR slug ILIKE '%human%';
  `);

  // Stage 1 pipeline redesign (2026-06-11): clips carry the full dimension
  // set. `action` joins subject/subject_name/occasion/mood already present.
  // Backfill action + missing dims from the parent concept (idempotent:
  // only NULL rows are touched).
  await pool.query(`
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS action TEXT;
    UPDATE social_clips sc SET action = c.action
      FROM concepts c WHERE c.id = sc.concept_id AND sc.action IS NULL;
    UPDATE social_clips sc SET subject = c.subject
      FROM concepts c WHERE c.id = sc.concept_id AND sc.subject IS NULL;
    UPDATE social_clips sc SET occasion = c.occasion
      FROM concepts c WHERE c.id = sc.concept_id AND sc.occasion IS NULL;
  `);

  // Publish planner (2026-06-11): per-platform planned publish dates.
  // The tracker shows a "Publish today" strip for planned-but-not-posted
  // clips; the content calendar shows them as dashed ghosts.
  await pool.query(`
    ALTER TABLE visits ADD COLUMN IF NOT EXISTS asn_org TEXT;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS tiktok_planned_at    DATE;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS instagram_planned_at DATE;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS yt_planned_at        DATE;
    ALTER TABLE social_clips ADD COLUMN IF NOT EXISTS fb_planned_at        DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS holiday_country VARCHAR(10);
  `);

  // Funnel events (2026-06-11): preview/purchase stamped with the visitor's
  // attribution cookie (ts_ref/ts_src) so the tracker can show visits -> previews -> purchases.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funnel_events (
      id         SERIAL PRIMARY KEY,
      kind       TEXT NOT NULL CHECK (kind IN ('preview','purchase')),
      ref        TEXT,
      src        TEXT,
      email      TEXT,
      order_id   INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_funnel_events_ref ON funnel_events(ref) WHERE ref IS NOT NULL;
    CREATE TABLE IF NOT EXISTS holiday_cache (
      country_code VARCHAR(10) NOT NULL,
      year         INTEGER     NOT NULL,
      holidays     JSONB       NOT NULL DEFAULT '[]',
      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (country_code, year)
    );
    CREATE TABLE IF NOT EXISTS holiday_countries_cache (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      countries  JSONB       NOT NULL DEFAULT '[]',
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Platform OAuth tokens (single-admin, keyed by platform name)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_tokens (
      platform      TEXT PRIMARY KEY,
      access_token  TEXT,
      refresh_token TEXT,
      token_expiry  TIMESTAMPTZ,
      channel_id    TEXT,
      channel_title TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);


  // Waitlist — email capture for upcoming calendar print service (2026-06-19)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id            SERIAL PRIMARY KEY,
      email         VARCHAR(255) NOT NULL,
      src           TEXT,
      ref           TEXT,
      referrer      TEXT,
      user_agent    TEXT,
      country       VARCHAR(10),
      city          TEXT,
      ip            TEXT,
      discount_code VARCHAR(20),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(email)
    );
  `);

  // ====================================================================
  // Video Engine (2026-07-04) — story generator + review queue.
  // Spec: Claude_Workspace/03_Turtleandsun/01_Context/_SPEC_VIDEO_ENGINE_2026-07-04.md
  // story_elements  = recurring cast/props (component 2)
  // story_situations = growing situation list (input to component 1)
  // cta_cards       = reusable part-2 end-cards (component 3)
  // video_stories   = the story record itself (component 1)
  // All additive, all idempotent.
  // ====================================================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS story_elements (
      id                   SERIAL PRIMARY KEY,
      name                 TEXT NOT NULL,
      kind                 TEXT NOT NULL DEFAULT 'pet'
                             CHECK (kind IN ('pet','person','location','prop','product')),
      description          TEXT,
      personality          TEXT,
      reference_image_urls TEXT[] NOT NULL DEFAULT '{}',
      active               BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order           INTEGER NOT NULL DEFAULT 0,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS story_situations (
      id          SERIAL PRIMARY KEY,
      text        TEXT NOT NULL,
      occasion    TEXT,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      times_used  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cta_cards (
      id          SERIAL PRIMARY KEY,
      offer_key   TEXT NOT NULL,
      label       TEXT NOT NULL,
      cta_text    TEXT,
      video_url   TEXT,
      image_url   TEXT,
      duration_s  NUMERIC(5,2) NOT NULL DEFAULT 4,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      times_used  INTEGER NOT NULL DEFAULT 0,
      notes       TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS video_stories (
      id                SERIAL PRIMARY KEY,
      status            TEXT NOT NULL DEFAULT 'pending_review'
                          CHECK (status IN ('pending_review','accepted','rejected')),
      hook_text         TEXT,
      story_type        TEXT,
      mood              TEXT,
      situation_id      INTEGER REFERENCES story_situations(id) ON DELETE SET NULL,
      situation_text    TEXT,
      scenes            JSONB NOT NULL DEFAULT '[]',
      element_ids       INTEGER[] NOT NULL DEFAULT '{}',
      elements_snapshot JSONB NOT NULL DEFAULT '[]',
      cta_card_id       INTEGER REFERENCES cta_cards(id) ON DELETE SET NULL,
      generator         TEXT NOT NULL DEFAULT 'kling'
                          CHECK (generator IN ('kling','flow','gemini')),
      language          TEXT NOT NULL DEFAULT 'en',
      llm_model         TEXT,
      llm_cost_usd      NUMERIC(10,6),
      llm_notes         TEXT,
      review_note       TEXT,
      social_clip_id    INTEGER REFERENCES social_clips(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at       TIMESTAMPTZ,
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_video_stories_status ON video_stories (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_video_stories_cta    ON video_stories (cta_card_id);

    -- 2026-07-04 (same day, part 2): part-1 video generation from accepted
    -- stories. Kling t2v via fal, runs as a background job; row carries the
    -- video lifecycle so the queue UI can poll.
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS video_status       TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS video_url          TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS video_fal_url      TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS video_model        TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS video_duration_s   INTEGER;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS video_cost_usd     NUMERIC(10,4);
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS video_error        TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS video_started_at   TIMESTAMPTZ;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS video_completed_at TIMESTAMPTZ;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS generation_id      INTEGER REFERENCES generations(id);

    -- 2026-07-04 (part 3): assembly — part-1 clip + CTA end-card + burned hook
    -- text, joined with ffmpeg into the final publishable vertical video.
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS final_status       TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS final_url          TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS final_error        TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS final_duration_s   INTEGER;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS final_completed_at TIMESTAMPTZ;

    -- 2026-07-04 (part 4): posting texts live ON the story (auto-written at
    -- assembly, editable in the queue) and are copied to the tracker record
    -- when the story is sent there.
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS yt_title           TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS yt_description     TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS yt_keyword_tags    TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS tiktok_caption     TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS tiktok_hashtags    TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS instagram_caption  TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS instagram_hashtags TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS instagram_alt_text TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS fb_caption         TEXT;

    -- 2026-07-04 (part 6): reviewable start/end frames. The story carries the
    -- approved frame URLs; story_frames is the reusable library (e.g. the
    -- standard kitchen establishing shot, generated once, reused for free).
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS start_frame_url TEXT;
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS end_frame_url   TEXT;

    -- 2026-07-04 (part 7): auto-production chain state. idle = manual mode,
    -- running = machine working, paused_frame = waiting for frame approval,
    -- waiting_clip = Flow/Gemini manual generation step, done / error.
    ALTER TABLE video_stories ADD COLUMN IF NOT EXISTS pipeline_status TEXT NOT NULL DEFAULT 'idle';

    CREATE TABLE IF NOT EXISTS story_frames (
      id          SERIAL PRIMARY KEY,
      label       TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'any' CHECK (kind IN ('start','end','any')),
      image_url   TEXT NOT NULL,
      prompt      TEXT,
      source      TEXT NOT NULL DEFAULT 'composed' CHECK (source IN ('composed','uploaded','story')),
      times_used  INTEGER NOT NULL DEFAULT 0,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Allow the generations audit log to record video-engine runs.
  // Drop + re-add is idempotent per boot and preserves existing rows.
  await pool.query(`
    ALTER TABLE generations DROP CONSTRAINT IF EXISTS generations_source_type_check;
    ALTER TABLE generations ADD CONSTRAINT generations_source_type_check
      CHECK (source_type IN ('admin_test', 'customer_order', 'lab_batch', 'preview', 'video_story'));
  `);

  // Themes (2026-07-04 part 5): DB-driven idea themes for bulk situation
  // generation. Editable in the UI — never hardcode more here, seed only.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS story_themes (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE story_situations ADD COLUMN IF NOT EXISTS theme TEXT;
  `);
  const themeCount = await pool.query(`SELECT COUNT(*)::int AS n FROM story_themes`);
  if (themeCount.rows[0].n === 0) {
    const seedThemes = [
      'Pet becomes a royal',
      'Pet uses the fridge calendar',
      'Pet saves a forgotten birthday',
      'Pet plans a secret party',
      'Morning chaos rescued by the calendar',
      'Pets argue about calendar dates',
      'Pet silently judges the humans',
      'Holiday panic averted',
      'New calendar unboxing ceremony',
      'Pet delivers gifts exactly on time',
    ];
    for (const name of seedThemes) {
      await pool.query(`INSERT INTO story_themes (name) VALUES ($1)`, [name]);
    }
    console.log(`Seeded ${seedThemes.length} story themes`);
  }

  // Seed starter situations once (spec open item: "story situation list").
  // Only when the table is empty — Ivo edits/extends via the dashboard after.
  const sitCount = await pool.query(`SELECT COUNT(*)::int AS n FROM story_situations`);
  if (sitCount.rows[0].n === 0) {
    const seedSituations = [
      ['The dog notices TODAY is marked on the fridge calendar — and it is his birthday.', 'birthday'],
      ['Someone almost forgets grandma’s birthday; the fridge calendar saves the day at the last second.', 'birthday'],
      ['The cat sits in front of the fridge, judging the humans for forgetting a date. The calendar knows.', 'general'],
      ['Morning chaos: school, coffee, keys — one glance at the fridge calendar restores order.', 'general'],
      ['The dog "reads" the calendar and starts preparing a surprise party for the cat.', 'birthday'],
      ['A pet realises its OWN birthday is on the family calendar — pure joy.', 'birthday'],
      ['Two pets argue about whose birthday comes first; the fridge calendar settles it.', 'birthday'],
      ['Christmas panic averted: every family date was already on the fridge calendar since January.', 'christmas'],
      ['New year: the family hangs the new calendar and the pets inspect every birthday on it.', 'new-year'],
      ['The dog brings a gift to the neighbour’s door — the calendar said it was their pup’s big day.', 'birthday'],
      ['Mother’s day almost slips by; the fridge calendar quietly saved the relationship.', 'mothers-day'],
      ['A houseguest is amazed the family NEVER forgets a birthday. Camera pans to the fridge.', 'general'],
    ];
    for (const [text, occ] of seedSituations) {
      await pool.query(
        `INSERT INTO story_situations (text, occasion) VALUES ($1, $2)`,
        [text, occ]
      );
    }
    console.log(`Seeded ${seedSituations.length} story situations`);
  }

  console.log('Database tables ready');
}

const GALLERY_STYLES = [
  {
    style_id: 'renaissance-portrait',
    style_name: 'Renaissance Portrait',
    description: 'Timeless oil painting in the style of great Renaissance masters. Rich warm tones with dramatic lighting.',
    example_image_url: 'https://picsum.photos/seed/renaissance1/400/530',
    category: 'People',
    prompt_text: 'A regal Renaissance-style oil painting portrait, wearing ornate royal robes and jeweled crown, grand palace backdrop with dramatic chiaroscuro lighting. Preserve exact facial features and likeness. Museum quality, highly detailed.',
    fal_model: 'fal-ai/kling-image/v3/image-to-image',
  },
  {
    style_id: 'victorian-royalty',
    style_name: 'Victorian Royalty',
    description: 'Regal Victorian-era grandeur with ornate period costume and formal palace backdrop.',
    example_image_url: 'https://picsum.photos/seed/victorian2/400/530',
    category: 'People',
    prompt_text: 'A formal Victorian royal portrait painting, wearing elaborate period costume with jewels, sash, and orders, grand Victorian palace interior. Oil painting style, highly detailed, preserve exact face and likeness.',
    fal_model: 'fal-ai/kling-image/v3/image-to-image',
  },
  {
    style_id: 'noble-pet',
    style_name: 'Noble Animal Portrait',
    description: 'Your beloved pet reimagined as a noble aristocrat with regal attire and majestic bearing.',
    example_image_url: 'https://picsum.photos/seed/noblePet3/400/530',
    category: 'Pets',
    prompt_text: 'A majestic royal portrait of the animal wearing ornate noble attire, ruffled lace collar, small crown, seated in an aristocratic palace setting. Oil painting style, highly detailed, preserve exact animal features.',
    fal_model: 'fal-ai/kling-image/v3/image-to-image',
  },
  {
    style_id: 'royal-pet-crest',
    style_name: 'Royal Pet Crest',
    description: 'A formal heraldic-style portrait of your pet with ornate golden borders and royal insignia.',
    example_image_url: 'https://picsum.photos/seed/royalPet4/400/530',
    category: 'Pets',
    prompt_text: 'A formal heraldic royal portrait of the animal, framed with ornate golden borders, velvet curtain backdrop, wearing royal attire with crown. Oil painting style, preserve exact animal features and likeness.',
    fal_model: 'fal-ai/kling-image/v3/image-to-image',
  },
  {
    style_id: 'romantic-royals',
    style_name: 'Romantic Royals',
    description: 'A breathtaking couples portrait capturing the romance and splendor of royal court paintings.',
    example_image_url: 'https://picsum.photos/seed/romantic5/400/530',
    category: 'Couples',
    prompt_text: 'A romantic royal couples portrait painting, both wearing ornate royal attire and jeweled crowns, palatial ballroom setting with warm candlelight. Oil painting style, preserve exact faces and likenesses of both people.',
    fal_model: 'fal-ai/kling-image/v3/image-to-image',
  },
  {
    style_id: 'dynasty-couple',
    style_name: 'Dynasty Portrait',
    description: 'A grand dynasty-style painting for two with matching royal attire and palatial background.',
    example_image_url: 'https://picsum.photos/seed/dynasty6/400/530',
    category: 'Couples',
    prompt_text: 'A grand dynasty royal portrait of a couple, wearing matching imperial royal robes and jeweled crowns, throne room backdrop with royal crest. Oil painting museum quality, preserve exact faces and likenesses.',
    fal_model: 'fal-ai/kling-image/v3/image-to-image',
  },
  {
    style_id: 'royal-family-gathering',
    style_name: 'Royal Family Gathering',
    description: 'The entire family immortalized in a sweeping royal portrait with full court regalia.',
    example_image_url: 'https://picsum.photos/seed/family7/400/530',
    category: 'Families',
    prompt_text: 'A sweeping royal family portrait painting, everyone in full court regalia with crowns and royal robes, grand palace hall with marble columns. Oil painting, highly detailed, preserve exact faces and likenesses of all family members.',
    fal_model: 'fal-ai/kling-image/v3/image-to-image',
  },
  {
    style_id: 'noble-house',
    style_name: 'Noble House',
    description: 'An aristocratic family gathering portrait in the style of Old Master paintings with rich detail.',
    example_image_url: 'https://picsum.photos/seed/noble8/400/530',
    category: 'Families',
    prompt_text: 'An aristocratic Old Master style family portrait, formal noble attire with regalia, wood-panelled library backdrop. Oil painting style, museum quality, preserve exact faces and likenesses of all family members.',
    fal_model: 'fal-ai/kling-image/v3/image-to-image',
  },
];

async function seedGallery() {
  for (const style of GALLERY_STYLES) {
    await pool.query(
      `INSERT INTO prompts (style_id, style_name, description, example_image_url, category, prompt_text, fal_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (style_id) DO NOTHING`,
      [style.style_id, style.style_name, style.description, style.example_image_url,
       style.category, style.prompt_text, style.fal_model]
    );
  }
  console.log('Gallery styles seeded');
}

module.exports = { pool, initDb, seedGallery };
