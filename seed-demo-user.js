const { pool } = require('./db');

const DEMO_EMAIL = 'ivo.englund@3doc.se';

const MALE_NAMES = [
  'Erik','Lars','Johan','Anders','Magnus','Karl','Mikael','Stefan','Peter','Björn',
  'Niklas','Oscar','Henrik','Mattias','Daniel','Andreas','Marcus','Patrik','Jonas','Simon',
  'Filip','Axel','Viktor','Emil','Gustav','Sebastian','Linus','Tobias','Adam','Christoffer',
  'David','Alexander','William','Oliver','Noah','Lucas','Elias','Hugo','Leo','Anton',
  'Isak','Albin','Rasmus','Robin','Joakim','Hampus','Pontus','Rickard','Jesper','Per',
];
const FEMALE_NAMES = [
  'Anna','Maria','Karin','Sara','Lisa','Eva','Kristina','Emma','Johanna','Lena',
  'Linda','Maja','Sofia','Hanna','Amanda','Elin','Malin','Jenny','Ida','Frida',
  'Klara','Stella','Wilma','Alice','Ella','Ebba','Alva','Nora','Julia','Emilia',
  'Moa','Lovisa','Elsa','Isabelle','Signe','Agnes','Astrid','Vera','Matilda','Hedvig',
  'Tuva','Lova','Tilde','Cornelia','Filippa','Lea','Elvira','Olivia','Felicia','Ines',
];
const LAST_NAMES = [
  'Andersson','Johansson','Karlsson','Nilsson','Eriksson','Larsson','Olsson','Persson',
  'Svensson','Gustafsson','Petersson','Lindqvist','Magnusson','Lindström','Bergström',
  'Hansson','Danielsson','Henriksson','Martinsson','Lindberg','Bergman','Holm','Björk',
  'Sandberg','Lund','Sjöberg','Wallin','Engström','Strand','Forsberg',
];
const CITIES = ['Stockholm','Göteborg','Malmö','Uppsala','Linköping','Örebro','Västerås','Helsingborg'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function randomBirthday(minAge, maxAge) {
  const year = 2026 - rand(minAge, maxAge);
  const month = rand(1, 12);
  const day = rand(1, 28);
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function generateContacts(n) {
  const contacts = [];
  for (let i = 0; i < n; i++) {
    const isMale = Math.random() < 0.5;
    const firstName = pick(isMale ? MALE_NAMES : FEMALE_NAMES);
    const lastName = pick(LAST_NAMES);
    const name = `${firstName} ${lastName}`;
    const emailLocal = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${rand(1,99)}`;
    contacts.push({
      name,
      email: `${emailLocal}@example.com`,
      phone: `+467${rand(10000000,99999999)}`,
      city: pick(CITIES),
      country: 'Sweden',
      birthday: randomBirthday(18, 75),
      gender: isMale ? 'M' : 'F',
    });
  }
  return contacts;
}

async function seed() {
  // User
  const userRes = await pool.query(
    `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [DEMO_EMAIL]
  );
  const userId = userRes.rows[0].id;
  console.log(`Demo user id: ${userId}`);

  // Groups
  const groupNames = ['Family', 'Work', 'School', 'Friends'];
  const groupIds = {};
  for (const g of groupNames) {
    const r = await pool.query(
      `INSERT INTO groups (user_id, name) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING id`,
      [userId, g]
    );
    if (r.rows.length) {
      groupIds[g] = r.rows[0].id;
    } else {
      const existing = await pool.query(`SELECT id FROM groups WHERE user_id=$1 AND name=$2`, [userId, g]);
      groupIds[g] = existing.rows[0].id;
    }
  }
  console.log('Groups:', groupIds);

  // Relationship types with mirrors
  const rtDefs = [
    { group: 'Family', pairs: [['Mother','Son'],['Father','Son'],['Mother','Daughter'],['Father','Daughter'],['Brother','Brother'],['Sister','Sister'],['Brother','Sister'],['Spouse','Spouse']] },
    { group: 'Work',   pairs: [['Boss','Reports to'],['Colleague','Colleague']] },
    { group: 'School', pairs: [['Classmate','Classmate']] },
    { group: 'Friends',pairs: [['Friend','Friend']] },
  ];

  const rtIds = {}; // name -> id

  for (const { group, pairs } of rtDefs) {
    const gid = groupIds[group];
    for (const [a, b] of pairs) {
      // Insert a
      let aRes = await pool.query(
        `INSERT INTO relationship_types (group_id, name) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING id`,
        [gid, a]
      );
      if (!aRes.rows.length) {
        aRes = await pool.query(`SELECT id FROM relationship_types WHERE group_id=$1 AND name=$2`, [gid, a]);
      }
      const aId = aRes.rows[0].id;
      rtIds[`${group}:${a}`] = aId;

      if (a === b) {
        // Self-mirror
        await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$1`, [aId]);
      } else {
        let bRes = await pool.query(
          `INSERT INTO relationship_types (group_id, name) VALUES ($1, $2)
           ON CONFLICT DO NOTHING RETURNING id`,
          [gid, b]
        );
        if (!bRes.rows.length) {
          bRes = await pool.query(`SELECT id FROM relationship_types WHERE group_id=$1 AND name=$2`, [gid, b]);
        }
        const bId = bRes.rows[0].id;
        rtIds[`${group}:${b}`] = bId;
        await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$2`, [bId, aId]);
        await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$2`, [aId, bId]);
      }
    }
  }
  console.log('Relationship types seeded');

  // Delete old contacts for this user to avoid duplicates on re-run
  await pool.query(`DELETE FROM contact_relationships WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM contacts WHERE user_id=$1`, [userId]);

  // Generate 200 contacts
  const generated = generateContacts(200);
  const contactIds = [];
  for (const c of generated) {
    const r = await pool.query(
      `INSERT INTO contacts (user_id, name, email, phone, city, country, birthday, is_placeholder)
       VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE) RETURNING id`,
      [userId, c.name, c.email, c.phone, c.city, c.country, c.birthday]
    );
    contactIds.push({ id: r.rows[0].id, gender: c.gender });
  }
  console.log(`Inserted ${contactIds.length} contacts`);

  // Assign to groups: first 30 family, next 50 work, next 60 school, last 60 friends
  const familyIds  = contactIds.slice(0, 30);
  const workIds    = contactIds.slice(30, 80);
  const schoolIds  = contactIds.slice(80, 140);
  const friendIds  = contactIds.slice(140, 200);

  async function addRel(aId, bId, rtName, group) {
    const rtId = rtIds[`${group}:${rtName}`];
    if (!rtId) return;
    await pool.query(
      `INSERT INTO contact_relationships (user_id, contact_a_id, contact_b_id, relationship_type_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [userId, aId, bId, rtId]
    );
  }

  // Family relationships
  // First 2 = parents (1 male=Father, 1 female=Mother), rest = children/siblings
  const dad = familyIds[0];
  const mum = familyIds[1];

  // Parents are spouses
  await addRel(dad.id, mum.id, 'Spouse', 'Family');

  // 8 children
  const children = familyIds.slice(2, 10);
  for (const child of children) {
    await addRel(dad.id, child.id, child.gender === 'M' ? 'Son' : 'Daughter', 'Family');
    await addRel(mum.id, child.id, child.gender === 'M' ? 'Son' : 'Daughter', 'Family');
  }

  // Sibling pairs among children
  for (let i = 0; i < children.length - 1; i++) {
    const a = children[i], b = children[i + 1];
    const rel = a.gender === 'M' && b.gender === 'M' ? 'Brother'
              : a.gender === 'F' && b.gender === 'F' ? 'Sister'
              : 'Brother';
    await addRel(a.id, b.id, rel, 'Family');
  }

  // Remaining family: spouse pairs
  for (let i = 10; i < familyIds.length - 1; i += 2) {
    await addRel(familyIds[i].id, familyIds[i+1].id, 'Spouse', 'Family');
  }

  // Work relationships: first contact = boss, rest = colleagues/reports
  const boss = workIds[0];
  for (let i = 1; i < Math.min(8, workIds.length); i++) {
    await addRel(boss.id, workIds[i].id, 'Boss', 'Work');
  }
  for (let i = 1; i < workIds.length - 1; i++) {
    await addRel(workIds[i].id, workIds[i+1].id, 'Colleague', 'Work');
  }

  // School: all classmates in chains of 3
  for (let i = 0; i < schoolIds.length - 1; i++) {
    await addRel(schoolIds[i].id, schoolIds[i+1].id, 'Classmate', 'School');
  }

  // Friends: pairs
  for (let i = 0; i < friendIds.length - 1; i += 2) {
    await addRel(friendIds[i].id, friendIds[i+1].id, 'Friend', 'Friends');
  }
  // Cross-friend links
  for (let i = 0; i < friendIds.length - 3; i += 5) {
    await addRel(friendIds[i].id, friendIds[i+3].id, 'Friend', 'Friends');
  }

  console.log('Relationships seeded');
  console.log(`Done! Log in as ${DEMO_EMAIL} to view the network.`);
}

module.exports = seed;

if (require.main === module) {
  require('dotenv').config();
  seed().catch(err => { console.error(err); process.exit(1); });
}
