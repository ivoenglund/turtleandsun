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
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id SERIAL PRIMARY KEY,
      style_id VARCHAR(255),
      prompt_text TEXT NOT NULL,
      fal_model VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Database tables ready');
}

module.exports = { pool, initDb };
