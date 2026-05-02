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
  `);

  // Migrate existing tables to add new columns
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS result_url TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS result_video_url TEXT;
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
  `);

  // Unique index on prompts.style_id for ON CONFLICT support
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS prompts_style_id_unique ON prompts (style_id);
  `);

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
