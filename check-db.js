const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function check() {
  const { rows } = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('users', 'orders', 'prompts')
    ORDER BY table_name;
  `);
  const found = rows.map(r => r.table_name);
  const expected = ['orders', 'prompts', 'users'];
  expected.forEach(t => {
    console.log(`${found.includes(t) ? '✓' : '✗'} ${t}`);
  });
  await pool.end();
}

check().catch(err => { console.error(err.message); process.exit(1); });
