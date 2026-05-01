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

  // ── Delete all existing data in dependency order ───────────────────────────
  await pool.query(`DELETE FROM contact_group_memberships WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM contact_relationships WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM contacts WHERE user_id=$1`, [userId]);
  // relationship_types is self-referential via mirror_id — null it out first
  await pool.query(
    `UPDATE relationship_types SET mirror_id = NULL
     WHERE group_id IN (SELECT id FROM groups WHERE user_id=$1)`,
    [userId]
  );
  await pool.query(
    `DELETE FROM relationship_types
     WHERE group_id IN (SELECT id FROM groups WHERE user_id=$1)`,
    [userId]
  );
  await pool.query(`DELETE FROM groups WHERE user_id=$1`, [userId]);
  console.log('Old data cleared');

  // ── Insert groups ──────────────────────────────────────────────────────────
  const groupNames = ['Family', 'Work', 'School', 'Friends'];
  const groupIds = {};
  for (const g of groupNames) {
    const r = await pool.query(
      `INSERT INTO groups (user_id, name) VALUES ($1, $2) RETURNING id`,
      [userId, g]
    );
    groupIds[g] = r.rows[0].id;
  }
  console.log('Groups:', groupIds);

  // ── Insert relationship types with mirrors ─────────────────────────────────
  const rtDefs = [
    { group: 'Family', pairs: [['Mother','Son'],['Father','Son'],['Mother','Daughter'],['Father','Daughter'],['Brother','Brother'],['Sister','Sister'],['Brother','Sister'],['Spouse','Spouse']] },
    { group: 'Work',   pairs: [['Boss','Reports to'],['Colleague','Colleague']] },
    { group: 'School', pairs: [['Classmate','Classmate']] },
    { group: 'Friends',pairs: [['Friend','Friend']] },
  ];

  const rtIds = {};

  for (const { group, pairs } of rtDefs) {
    const gid = groupIds[group];
    for (const [a, b] of pairs) {
      const aRes = await pool.query(
        `INSERT INTO relationship_types (group_id, name) VALUES ($1, $2) RETURNING id`,
        [gid, a]
      );
      const aId = aRes.rows[0].id;
      rtIds[`${group}:${a}`] = aId;

      if (a === b) {
        await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$1`, [aId]);
      } else {
        const bRes = await pool.query(
          `INSERT INTO relationship_types (group_id, name) VALUES ($1, $2) RETURNING id`,
          [gid, b]
        );
        const bId = bRes.rows[0].id;
        rtIds[`${group}:${b}`] = bId;
        await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$2`, [bId, aId]);
        await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$2`, [aId, bId]);
      }
    }
  }
  console.log('Relationship types seeded');

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

  // Work: boss hierarchy only — colleagues connect via company group node
  const boss = workIds[0];
  for (let i = 1; i < Math.min(8, workIds.length); i++) {
    await addRel(boss.id, workIds[i].id, 'Boss', 'Work');
  }

  // School: no direct person links — classmates connect via group node only

  // Friends: 8 specific best-friend pairs crossing club boundaries
  const bestFriendPairs = [
    [friendIds[0],  friendIds[20]], // Chess × Running
    [friendIds[5],  friendIds[35]], // Chess × Book
    [friendIds[10], friendIds[50]], // Chess × Hiking
    [friendIds[15], friendIds[45]], // Running × Hiking
    [friendIds[22], friendIds[38]], // Running × Book
    [friendIds[30], friendIds[55]], // Book × Hiking
    [friendIds[3],  friendIds[48]], // Chess × Hiking
    [friendIds[18], friendIds[32]], // Running × Book
  ];
  for (const [a, b] of bestFriendPairs) {
    await addRel(a.id, b.id, 'Friend', 'Friends');
  }

  console.log('Relationships seeded');

  // ── Subgroups & group memberships ──────────────────────────────────────────
  async function createSubgroup(name, category) {
    const r = await pool.query(
      `INSERT INTO groups (user_id, name, category) VALUES ($1, $2, $3) RETURNING id`,
      [userId, name, category]
    );
    return r.rows[0].id;
  }
  async function addMembership(contactId, sgId) {
    await pool.query(
      `INSERT INTO contact_group_memberships (user_id, contact_id, group_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [userId, contactId, sgId]
    );
  }

  const sgAcme      = await createSubgroup('Acme Corp',       'Work');
  const sgBuilder   = await createSubgroup('BuilderLab',      'Work');
  const sg1995      = await createSubgroup('Class of 1995',   'School');
  const sgKTH       = await createSubgroup('KTH Engineering', 'School');
  const sgChess     = await createSubgroup('Chess Club',      'Friends');
  const sgRunning   = await createSubgroup('Running Club',    'Friends');
  const sgBook      = await createSubgroup('Book Club',       'Friends');
  const sgHiking    = await createSubgroup('Hiking Group',    'Friends');

  for (const c of workIds.slice(0, 25))   await addMembership(c.id, sgAcme);
  for (const c of workIds.slice(25))      await addMembership(c.id, sgBuilder);
  for (const c of schoolIds.slice(0, 30)) await addMembership(c.id, sg1995);
  for (const c of schoolIds.slice(30))    await addMembership(c.id, sgKTH);
  for (const c of friendIds.slice(0, 15)) await addMembership(c.id, sgChess);
  for (const c of friendIds.slice(15,30)) await addMembership(c.id, sgRunning);
  for (const c of friendIds.slice(30,45)) await addMembership(c.id, sgBook);
  for (const c of friendIds.slice(45))    await addMembership(c.id, sgHiking);

  console.log('Group memberships seeded');
  console.log(`Done! Log in as ${DEMO_EMAIL} to view the network.`);
}

module.exports = seed;

if (require.main === module) {
  require('dotenv').config();
  seed().catch(err => { console.error(err); process.exit(1); });
}
