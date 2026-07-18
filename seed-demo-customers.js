// Seed ~100 demo customers (Swedish companies + contact person) into a group.
//
//   node seed-demo-customers.js [email] [groupName] [count]
//
// Also exposed as /api/admin/seed-demo-customers (see server.js). Contacts are
// marked with google_id 'demo-kund-N' so a re-run replaces them and never
// touches real contacts.

const { pool } = require('./db');

const EMAIL = process.argv[2] || 'ivo.englund@3doc.se';
const GROUP = process.argv[3] || 'Kunder';
const COUNT = parseInt(process.argv[4] || '100', 10);

const FIRST = ['Erik','Lars','Johan','Anders','Magnus','Karl','Mikael','Peter','Björn','Niklas','Oscar','Henrik','Mattias','Daniel','Marcus','Jonas','David','Fredrik','Per','Stefan',
  'Anna','Maria','Karin','Sara','Lisa','Eva','Kristina','Emma','Johanna','Lena','Linda','Sofia','Hanna','Elin','Malin','Jenny','Ida','Frida','Camilla','Åsa'];
const LAST = ['Andersson','Johansson','Karlsson','Nilsson','Eriksson','Larsson','Olsson','Persson','Svensson','Gustafsson','Lindqvist','Magnusson','Lindström','Bergström','Hansson',
  'Lindberg','Bergman','Holm','Björk','Sandberg','Lund','Sjöberg','Wallin','Engström','Forsberg','Åberg','Ek','Norén','Dahl','Öberg'];
const TITLES = ['VD','Ekonomichef','Grundare','Delägare','Kontorschef','Inköpschef','Marknadschef','Projektledare','Ägare','Verksamhetschef','Försäljningschef','Administrativ chef'];
const CO_A = ['Nord','Berg','Svea','Mälar','Kungs','Söder','Väster','Öster','Lind','Björk','Gran','Ek','Sten','Strand','Sjö','Alvik','Vasa','Solna','Delta','Prima'];
const CO_B = ['bygg','el','måleri','plåt','redovisning','konsult','fastigheter','logistik','design','data','miljö','energi','transport','kök','trädgård','glas','tryck','juridik','rekrytering','städ'];
const CO_S = ['AB','AB','AB','HB','Group AB','Partners AB'];
const STREETS = ['Storgatan','Kungsgatan','Sveavägen','Hornsgatan','Vasagatan','Götgatan','Drottninggatan','Ringvägen','Folkungagatan','Birger Jarlsgatan','Odengatan','Karlavägen','Fleminggatan','Södermannagatan','Norrtullsgatan'];
const CITIES = [['Stockholm','11'],['Solna','16'],['Sundbyberg','17'],['Nacka','13'],['Täby','18'],['Bromma','16'],['Huddinge','14'],['Sollentuna','19'],['Lidingö','18'],['Danderyd','18']];

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function ascii(s) { return s.toLowerCase().replace(/å/g,'a').replace(/ä/g,'a').replace(/ö/g,'o').replace(/é/g,'e').replace(/[^a-z]/g,''); }

async function seedDemoCustomers(db, { email, group = 'Kunder', count = 100 } = {}) {
  const userRes = await db.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
  if (!userRes.rows.length) throw new Error('No user with email ' + email);
  const userId = userRes.rows[0].id;

  // Group: find or create.
  let grp = await db.query(`SELECT id FROM groups WHERE user_id = $1 AND LOWER(name) = LOWER($2)`, [userId, group]);
  let groupId = grp.rows[0]?.id;
  if (!groupId) {
    const ins = await db.query(`INSERT INTO groups (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, group]);
    groupId = ins.rows[0].id;
  }

  // Remove earlier demo customers (memberships + occasions first).
  const old = await db.query(`SELECT id FROM contacts WHERE user_id = $1 AND google_id LIKE 'demo-kund-%'`, [userId]);
  const oldIds = old.rows.map(r => r.id);
  if (oldIds.length) {
    await db.query(`DELETE FROM contact_group_memberships WHERE user_id = $1 AND contact_id = ANY($2)`, [userId, oldIds]);
    await db.query(`DELETE FROM occasions WHERE user_id = $1 AND contact_id = ANY($2)`, [userId, oldIds]);
    await db.query(`DELETE FROM contacts WHERE user_id = $1 AND id = ANY($2)`, [userId, oldIds]);
  }

  // Build unique company names.
  const companies = new Set();
  while (companies.size < count) {
    const name = pick(CO_A) + pick(CO_B) + ' ' + pick(CO_S);
    companies.add(name.charAt(0).toUpperCase() + name.slice(1));
  }

  let inserted = 0;
  for (const company of companies) {
    const first = pick(FIRST), last = pick(LAST);
    const name = first + ' ' + last;
    const domain = ascii(company.replace(/\s*(AB|HB|Group AB|Partners AB)$/,'')) + '.se';
    const emailAddr = ascii(first) + '.' + ascii(last) + '@' + domain;
    const phone = '070-' + rand(200,799) + ' ' + String(rand(10,99)) + ' ' + String(rand(10,99));
    const [city, postPrefix] = pick(CITIES);
    const street = pick(STREETS) + ' ' + rand(1, 95);
    const postal = postPrefix + ' ' + rand(10, 69) + ' ' + rand(10, 99);
    const birthday = `${rand(1961, 1996)}-${String(rand(1,12)).padStart(2,'0')}-${String(rand(1,28)).padStart(2,'0')}`;
    const photo = (inserted % 3 !== 2) ? `https://i.pravatar.cc/300?u=demo-kund-${inserted+1}` : null;

    const c = await db.query(
      `INSERT INTO contacts (user_id, google_id, name, email, phone, company, job_title, street, city, country, postal_code, birthday, photo_url, is_placeholder)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Sverige',$10,$11,$12,FALSE)
       ON CONFLICT (user_id, google_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [userId, 'demo-kund-' + (inserted+1), name, emailAddr, phone, company, pick(TITLES), street, city, postal, birthday, photo]
    );
    await db.query(
      `INSERT INTO contact_group_memberships (user_id, contact_id, group_id, from_date, status)
       VALUES ($1,$2,$3,CURRENT_DATE,'active')
       ON CONFLICT (user_id, contact_id, group_id) DO NOTHING`,
      [userId, c.rows[0].id, groupId]
    );
    inserted++;
  }

  return { removed: oldIds.length, inserted, group, groupId, email };
}

module.exports = { seedDemoCustomers };

if (require.main === module) {
  seedDemoCustomers(pool, { email: EMAIL, group: GROUP, count: COUNT })
    .then(out => { console.log(`Removed ${out.removed} old, inserted ${out.inserted} demo customers into "${out.group}" for ${out.email}.`); return pool.end(); })
    .catch(e => { console.error(e); process.exit(1); });
}
