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

  // Migrate existing tables to add new columns
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS result_url TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS result_video_url TEXT;
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
