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
const PET_NAMES = ['Bella','Max','Luna','Charlie','Molly','Buddy','Daisy','Rocky','Lola','Oscar'];
const CITIES = ['Stockholm','Göteborg','Malmö','Uppsala','Linköping','Örebro','Västerås','Helsingborg'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function dateStr(year, month, day) {
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
function randomBirthday(minAge, maxAge) {
  return dateStr(2026 - rand(minAge, maxAge), rand(1,12), rand(1,28));
}
function randomDiedOn(birthYear, minAge, maxAge) {
  const deathYear = birthYear + rand(minAge, maxAge);
  if (deathYear >= 2026) return null;
  return dateStr(deathYear, rand(1,12), rand(1,28));
}

function generateHumans(n) {
  const contacts = [];
  for (let i = 0; i < n; i++) {
    const isMale = Math.random() < 0.5;
    const firstName = pick(isMale ? MALE_NAMES : FEMALE_NAMES);
    const lastName = pick(LAST_NAMES);
    contacts.push({
      name: `${firstName} ${lastName}`,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${rand(1,99)}@example.com`,
      phone: `+467${rand(10000000,99999999)}`,
      city: pick(CITIES),
      country: 'Sweden',
      birthday: randomBirthday(18, 80),
      gender: isMale ? 'M' : 'F',
      is_pet: false,
    });
  }
  return contacts;
}

async function seed() {
  const userRes = await pool.query(
    `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [DEMO_EMAIL]
  );
  const userId = userRes.rows[0].id;
  console.log(`Demo user id: ${userId}`);

  // ── Delete in correct dependency order ────────────────────────────────────────
  await pool.query(`DELETE FROM occasions WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM contact_group_memberships WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM contact_relationships WHERE user_id=$1`, [userId]);
  await pool.query(
    `UPDATE relationship_types SET mirror_id = NULL
     WHERE group_id IN (SELECT id FROM groups WHERE user_id=$1)`, [userId]
  );
  await pool.query(
    `DELETE FROM relationship_types
     WHERE group_id IN (SELECT id FROM groups WHERE user_id=$1)`, [userId]
  );
  await pool.query(`DELETE FROM groups WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM contacts WHERE user_id=$1`, [userId]);
  console.log('Old data cleared');

  // ── Family group + 6 relationship types ──────────────────────────────────────
  const famRes = await pool.query(
    `INSERT INTO groups (user_id, name) VALUES ($1, 'Family') RETURNING id`, [userId]
  );
  const famGid = famRes.rows[0].id;

  const rtPairs = [
    ['Mother of', 'Son of'],
    ['Mother of', 'Daughter of'],
    ['Father of', 'Son of'],
    ['Father of', 'Daughter of'],
    ['Spouse',    'Spouse'],
    ['Owner of',  'Pet of'],
  ];
  const rtIds = {};
  for (const [a, b] of rtPairs) {
    const aRes = await pool.query(
      `INSERT INTO relationship_types (group_id, name) VALUES ($1, $2) RETURNING id`, [famGid, a]
    );
    const aId = aRes.rows[0].id;
    rtIds[a] = aId;
    if (a === b) {
      await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$1`, [aId]);
    } else {
      const bRes = await pool.query(
        `INSERT INTO relationship_types (group_id, name) VALUES ($1, $2) RETURNING id`, [famGid, b]
      );
      const bId = bRes.rows[0].id;
      rtIds[b] = bId;
      await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$2`, [bId, aId]);
      await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$2`, [aId, bId]);
    }
  }
  console.log('Family relationship types seeded');

  // ── User-defined groups ───────────────────────────────────────────────────────
  async function makeGroup(name) {
    const r = await pool.query(
      `INSERT INTO groups (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, name]
    );
    return r.rows[0].id;
  }
  const gAcme    = await makeGroup('Acme Corp');
  const g1995    = await makeGroup('Class of 1995');
  const gChess   = await makeGroup('Chess Club');
  const gRunning = await makeGroup('Running Club');
  const gHiking  = await makeGroup('Hiking Group');
  const gBook    = await makeGroup('Book Club');
  console.log('User groups seeded');

  // ── Insert contacts ───────────────────────────────────────────────────────────
  async function insertContact(c) {
    const r = await pool.query(
      `INSERT INTO contacts (user_id, name, email, phone, city, country, birthday, died_on, is_placeholder, is_pet)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9) RETURNING id`,
      [userId, c.name, c.email || null, c.phone || null, c.city || null, c.country || null,
       c.birthday || null, c.died_on || null, !!c.is_pet]
    );
    return r.rows[0].id;
  }

  async function addRel(aId, bId, typeName) {
    const rtId = rtIds[typeName];
    if (!rtId) return;
    await pool.query(
      `INSERT INTO contact_relationships (user_id, contact_a_id, contact_b_id, relationship_type_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [userId, aId, bId, rtId]
    );
    const mirror = await pool.query(`SELECT mirror_id FROM relationship_types WHERE id=$1`, [rtId]);
    if (mirror.rows[0]?.mirror_id) {
      await pool.query(
        `INSERT INTO contact_relationships (user_id, contact_a_id, contact_b_id, relationship_type_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [userId, bId, aId, mirror.rows[0].mirror_id]
      );
    }
  }

  async function addMembership(contactId, groupId) {
    await pool.query(
      `INSERT INTO contact_group_memberships (user_id, contact_id, group_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [userId, contactId, groupId]
    );
  }

  // ── Family: 25 humans + 5 pets ────────────────────────────────────────────────
  const familyHumans = generateHumans(25);

  // Make grandparents deceased
  const grandpa = familyHumans[0];
  grandpa.birthday = randomBirthday(85, 100);
  const birthYearGrandpa = parseInt(grandpa.birthday.split('-')[0]);
  grandpa.died_on = randomDiedOn(birthYearGrandpa, 65, 85);

  const grandma = familyHumans[1];
  grandma.birthday = randomBirthday(80, 95);
  const birthYearGrandma = parseInt(grandma.birthday.split('-')[0]);
  grandma.died_on = randomDiedOn(birthYearGrandma, 70, 88);

  // Make 3 more family members deceased (uncles/aunts)
  [4, 7, 11].forEach(i => {
    familyHumans[i].birthday = randomBirthday(65, 85);
    const by = parseInt(familyHumans[i].birthday.split('-')[0]);
    familyHumans[i].died_on = randomDiedOn(by, 50, 75);
  });

  const familyIds = [];
  for (const c of familyHumans) {
    const id = await insertContact(c);
    familyIds.push({ id, gender: c.gender, died_on: c.died_on });
    await addMembership(id, famGid);
  }

  // 5 pets
  const petIds = [];
  const petSpecies = ['dog','cat','dog','rabbit','cat'];
  for (let i = 0; i < 5; i++) {
    const isDeceased = i < 2; // first two pets are deceased
    const petBirthYear = 2026 - rand(1, isDeceased ? 18 : 6);
    const bday = dateStr(petBirthYear, rand(1,12), rand(1,28));
    const id = await insertContact({
      name: pick(PET_NAMES),
      birthday: bday,
      died_on: isDeceased ? dateStr(petBirthYear + rand(8,15), rand(1,12), rand(1,28)) : null,
      is_pet: true,
    });
    petIds.push(id);
    await addMembership(id, famGid);
  }

  // Family relationships
  const dad = familyIds[2];  // parents are index 2,3 (grandparents are 0,1)
  const mum = familyIds[3];
  await addRel(familyIds[0].id, familyIds[1].id, 'Spouse');
  await addRel(dad.id, mum.id, 'Spouse');

  // Dad and Mum are children of grandparents
  await addRel(familyIds[0].id, dad.id, dad.gender === 'M' ? 'Son of' : 'Daughter of');
  await addRel(familyIds[1].id, dad.id, dad.gender === 'M' ? 'Son of' : 'Daughter of');

  // 6 children of dad+mum
  const children = familyIds.slice(4, 10);
  for (const child of children) {
    await addRel(dad.id, child.id, child.gender === 'M' ? 'Son of' : 'Daughter of');
    await addRel(mum.id, child.id, child.gender === 'M' ? 'Son of' : 'Daughter of');
  }

  // Spouse pairs from remaining family
  for (let i = 10; i < familyIds.length - 1; i += 2) {
    await addRel(familyIds[i].id, familyIds[i+1].id, 'Spouse');
  }

  // Pets owned by dad
  for (const pid of petIds) {
    await addRel(dad.id, pid, 'Owner of');
  }

  console.log('Family relationships seeded');

  // ── Other contacts ────────────────────────────────────────────────────────────
  const acmeContacts   = generateHumans(25);
  const classContacts  = generateHumans(20);
  const chessContacts  = generateHumans(15);
  const runningContacts= generateHumans(20);
  const hikingContacts = generateHumans(20);
  const bookContacts   = generateHumans(20);

  // 3 deceased in work group
  [2, 9, 18].forEach(i => {
    if (acmeContacts[i]) {
      acmeContacts[i].birthday = randomBirthday(60, 80);
      const by = parseInt(acmeContacts[i].birthday.split('-')[0]);
      acmeContacts[i].died_on = randomDiedOn(by, 45, 70);
    }
  });

  async function insertGroup(contacts, groupId) {
    const ids = [];
    for (const c of contacts) {
      const id = await insertContact(c);
      await addMembership(id, groupId);
      ids.push(id);
    }
    return ids;
  }

  await insertGroup(acmeContacts,    gAcme);
  await insertGroup(classContacts,   g1995);
  await insertGroup(chessContacts,   gChess);
  await insertGroup(runningContacts, gRunning);
  await insertGroup(hikingContacts,  gHiking);
  await insertGroup(bookContacts,    gBook);

  console.log('Group contacts and memberships seeded');

  // ── Occasions ─────────────────────────────────────────────────────────────────
  async function addOccasion(contactId, name, startDate, frequency, notes) {
    await pool.query(
      `INSERT INTO occasions (user_id, contact_id, name, start_date, frequency, notes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, contactId, name, startDate, frequency, notes || null]
    );
  }

  // Wedding anniversary for dad+mum
  const marriageYear = 2026 - rand(25, 35);
  await addOccasion(dad.id,  'Wedding anniversary', dateStr(marriageYear, rand(5,9), rand(1,28)), 'yearly', null);
  await addOccasion(mum.id,  'Wedding anniversary', dateStr(marriageYear, rand(5,9), rand(1,28)), 'yearly', null);

  // Grandparents' anniversary (milestone — 50th or 60th)
  const grandWedYear = 2026 - rand(50, 65);
  await addOccasion(familyIds[0].id, 'Wedding anniversary', dateStr(grandWedYear, rand(6,8), rand(1,28)), 'milestone', 'Golden anniversary');

  // Children graduations
  for (let i = 0; i < Math.min(3, children.length); i++) {
    const gradYear = 2026 - rand(1, 8);
    await addOccasion(children[i].id, 'University graduation', dateStr(gradYear, 6, rand(1,15)), 'milestone', null);
  }

  // Work anniversaries
  const acmeFirstId = (await pool.query(
    `SELECT id FROM contacts WHERE user_id=$1 ORDER BY created_at LIMIT 1 OFFSET $2`,
    [userId, familyIds.length + petIds.length]
  )).rows[0]?.id;
  if (acmeFirstId) {
    const workStartYear = 2026 - rand(3, 12);
    await addOccasion(acmeFirstId, 'Work anniversary', dateStr(workStartYear, rand(1,12), rand(1,28)), 'yearly', 'Joined Acme Corp');
  }

  // A few friend occasions
  const chessOffset = familyIds.length + petIds.length + acmeContacts.length + classContacts.length;
  const chessFirstId = (await pool.query(
    `SELECT id FROM contacts WHERE user_id=$1 ORDER BY created_at LIMIT 1 OFFSET $2`,
    [userId, chessOffset]
  )).rows[0]?.id;
  if (chessFirstId) {
    await addOccasion(chessFirstId, 'Chess tournament', dateStr(2024, 11, 15), 'yearly', 'Annual club championship');
    await addOccasion(chessFirstId, 'Birthday party', dateStr(2026, 7, 10), 'one-time', '40th birthday celebration');
  }

  // Spouse occasions for family pairs
  await addOccasion(familyIds[10].id, 'Wedding anniversary', dateStr(2026 - rand(15,25), rand(3,8), rand(1,28)), 'yearly', null);
  await addOccasion(familyIds[12].id, 'Wedding anniversary', dateStr(2026 - rand(5,15), rand(4,9), rand(1,28)), 'yearly', null);

  // General occasions for children
  await addOccasion(children[0].id, 'First job', dateStr(2026 - rand(2,5), rand(1,12), rand(1,28)), 'milestone', null);
  await addOccasion(children[1].id, 'New home', dateStr(2025, rand(1,12), rand(1,28)), 'one-time', 'Housewarming party');

  console.log('Occasions seeded');
  console.log(`Done! Log in as ${DEMO_EMAIL} to view the network.`);
}

module.exports = seed;

if (require.main === module) {
  require('dotenv').config();
  seed().catch(err => { console.error(err); process.exit(1); });
}
