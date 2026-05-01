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

function generateHumans(n, minAge = 22, maxAge = 70) {
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
      birthday: randomBirthday(minAge, maxAge),
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

  // ── Delete in correct dependency order ──────────────────────────────────────
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

  // ── Family group + relationship types ────────────────────────────────────────
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
    ['Sister of', 'Brother of'],
    ['Sister of', 'Sister of'],
    ['Brother of','Brother of'],
  ];
  const rtIds = {};
  for (const [a, b] of rtPairs) {
    if (rtIds[a]) continue; // already inserted
    const aRes = await pool.query(
      `INSERT INTO relationship_types (group_id, name) VALUES ($1, $2) RETURNING id`, [famGid, a]
    );
    const aId = aRes.rows[0].id;
    rtIds[a] = aId;
    if (a === b) {
      await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$1`, [aId]);
    } else {
      if (!rtIds[b]) {
        const bRes = await pool.query(
          `INSERT INTO relationship_types (group_id, name) VALUES ($1, $2) RETURNING id`, [famGid, b]
        );
        rtIds[b] = bRes.rows[0].id;
      }
      await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$2`, [rtIds[b], aId]);
      await pool.query(`UPDATE relationship_types SET mirror_id=$1 WHERE id=$2`, [aId, rtIds[b]]);
    }
  }
  console.log('Family relationship types seeded');

  // ── Group hierarchy ───────────────────────────────────────────────────────────
  async function makeGroup(name) {
    const r = await pool.query(
      `INSERT INTO groups (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, name]
    );
    return r.rows[0].id;
  }
  async function makeSubgroup(name, parentId) {
    const r = await pool.query(
      `INSERT INTO groups (user_id, name, parent_group_id) VALUES ($1, $2, $3) RETURNING id`,
      [userId, name, parentId]
    );
    return r.rows[0].id;
  }

  // Work → Acme Corp → {My team, Engineering, Leadership}
  //       → Old colleagues
  const gWork         = await makeGroup('Work');
  const gAcme         = await makeSubgroup('Acme Corp',     gWork);
  const gMyTeam       = await makeSubgroup('My team',       gAcme);
  const gEngineering  = await makeSubgroup('Engineering',   gAcme);
  const gLeadership   = await makeSubgroup('Leadership',    gAcme);
  const gOldCol       = await makeSubgroup('Old colleagues',gWork);

  // Friends → {Class of 1995, Hiking Group, Running Club, Chess Club, Book Club, Best friends}
  const gFriends      = await makeGroup('Friends');
  const g1995         = await makeSubgroup('Class of 1995', gFriends);
  const gHiking       = await makeSubgroup('Hiking Group',  gFriends);
  const gRunning      = await makeSubgroup('Running Club',  gFriends);
  const gChess        = await makeSubgroup('Chess Club',    gFriends);
  const gBook         = await makeSubgroup('Book Club',     gFriends);
  const gBest         = await makeSubgroup('Best friends',  gFriends);

  console.log('Group hierarchy seeded');

  // ── Shared helpers ────────────────────────────────────────────────────────────
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
    if (!rtId) { console.warn('Unknown rel type:', typeName); return; }
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

  async function insertGroup(contacts, groupId) {
    const ids = [];
    for (const c of contacts) {
      const id = await insertContact(c);
      await addMembership(id, groupId);
      ids.push(id);
    }
    return ids;
  }

  // ── Family: 25 humans + 5 pets ────────────────────────────────────────────────
  const familyHumans = generateHumans(25, 20, 85);

  // Grandparents (0, 1) — deceased
  familyHumans[0].birthday = randomBirthday(88, 100);
  const gpBy = parseInt(familyHumans[0].birthday.split('-')[0]);
  familyHumans[0].died_on = randomDiedOn(gpBy, 68, 84);

  familyHumans[1].birthday = randomBirthday(85, 97);
  const gmBy = parseInt(familyHumans[1].birthday.split('-')[0]);
  familyHumans[1].died_on = randomDiedOn(gmBy, 72, 88);

  // Parents (2, 3) — middle aged, alive
  familyHumans[2].birthday = randomBirthday(52, 62);
  familyHumans[3].birthday = randomBirthday(50, 60);

  // Two more deceased (aunt/uncle) — indices 7, 14
  familyHumans[7].birthday  = randomBirthday(65, 80);
  const a1By = parseInt(familyHumans[7].birthday.split('-')[0]);
  familyHumans[7].died_on   = randomDiedOn(a1By, 55, 78);

  familyHumans[14].birthday = randomBirthday(60, 75);
  const a2By = parseInt(familyHumans[14].birthday.split('-')[0]);
  familyHumans[14].died_on  = randomDiedOn(a2By, 50, 70);

  const familyIds = [];
  for (const c of familyHumans) {
    const id = await insertContact(c);
    familyIds.push({ id, gender: c.gender, died_on: c.died_on });
    await addMembership(id, famGid);
  }

  // 5 pets (first 2 deceased)
  const petIds = [];
  for (let i = 0; i < 5; i++) {
    const isDeceased = i < 2;
    const petBirthYear = 2026 - rand(1, isDeceased ? 18 : 8);
    const bday = dateStr(petBirthYear, rand(1,12), rand(1,28));
    const id = await insertContact({
      name: pick(PET_NAMES),
      birthday: bday,
      died_on: isDeceased ? dateStr(Math.min(petBirthYear + rand(8,16), 2025), rand(1,12), rand(1,28)) : null,
      is_pet: true,
    });
    petIds.push(id);
    await addMembership(id, famGid);
  }

  // Family relationships
  const gp1 = familyIds[0], gp2 = familyIds[1];
  const dad = familyIds[2], mum = familyIds[3];

  await addRel(gp1.id, gp2.id, 'Spouse');
  await addRel(dad.id, mum.id, 'Spouse');

  // Dad is child of grandparents
  await addRel(gp1.id, dad.id, dad.gender === 'M' ? 'Son of' : 'Daughter of');
  await addRel(gp2.id, dad.id, dad.gender === 'M' ? 'Son of' : 'Daughter of');

  // 6 children of dad+mum (indices 4–9)
  const children = familyIds.slice(4, 10);
  for (const child of children) {
    const rel = child.gender === 'M' ? 'Son of' : 'Daughter of';
    await addRel(dad.id, child.id, rel);
    await addRel(mum.id, child.id, rel);
  }

  // Sibling relationships among children
  for (let i = 0; i < children.length - 1; i++) {
    for (let j = i + 1; j < children.length; j++) {
      const a = children[i], b = children[j];
      const relType = a.gender === 'M' ? 'Brother of' : 'Sister of';
      await addRel(a.id, b.id, relType);
    }
  }

  // Spouse pairs among remaining family
  for (let i = 10; i < familyIds.length - 1; i += 2) {
    await addRel(familyIds[i].id, familyIds[i + 1].id, 'Spouse');
  }

  // Pets owned by dad
  for (const pid of petIds) {
    await addRel(dad.id, pid, 'Owner of');
  }

  console.log('Family seeded');

  // ── Work: 30 contacts across 4 leaf groups ────────────────────────────────────
  // My team: 10 (1 deceased), Engineering: 10 (1 deceased), Leadership: 5, Old colleagues: 5
  const myTeamContacts   = generateHumans(10, 25, 45);
  const engContacts      = generateHumans(10, 28, 50);
  const leadContacts     = generateHumans(5,  35, 58);
  const oldColContacts   = generateHumans(5,  38, 65);

  // 1 deceased in My team (index 3)
  myTeamContacts[3].birthday = randomBirthday(55, 70);
  const mt3By = parseInt(myTeamContacts[3].birthday.split('-')[0]);
  myTeamContacts[3].died_on = randomDiedOn(mt3By, 45, 65);

  // 1 deceased in Engineering (index 6)
  engContacts[6].birthday = randomBirthday(60, 75);
  const en6By = parseInt(engContacts[6].birthday.split('-')[0]);
  engContacts[6].died_on = randomDiedOn(en6By, 48, 70);

  const myTeamIds    = await insertGroup(myTeamContacts,  gMyTeam);
  const engIds       = await insertGroup(engContacts,     gEngineering);
  const leadIds      = await insertGroup(leadContacts,    gLeadership);
  const oldColIds    = await insertGroup(oldColContacts,  gOldCol);

  console.log('Work contacts seeded');

  // ── Friends: 80 contacts across 6 leaf groups ─────────────────────────────────
  // Class of 1995: 25, Hiking: 15, Running: 12, Chess: 10, Book: 10, Best: 8
  const classContacts   = generateHumans(25, 42, 50);
  const hikingContacts  = generateHumans(15, 28, 55);
  const runningContacts = generateHumans(12, 22, 48);
  const chessContacts   = generateHumans(10, 30, 65);
  const bookContacts    = generateHumans(10, 28, 60);
  const bestContacts    = generateHumans(8,  28, 48);

  // Deceased: index 4 in Class of 1995, index 7 in Hiking, index 2 in Chess
  classContacts[4].birthday = randomBirthday(55, 68);
  const cl4By = parseInt(classContacts[4].birthday.split('-')[0]);
  classContacts[4].died_on  = randomDiedOn(cl4By, 45, 65);

  hikingContacts[7].birthday = randomBirthday(58, 72);
  const hi7By = parseInt(hikingContacts[7].birthday.split('-')[0]);
  hikingContacts[7].died_on  = randomDiedOn(hi7By, 50, 70);

  chessContacts[2].birthday = randomBirthday(62, 78);
  const ch2By = parseInt(chessContacts[2].birthday.split('-')[0]);
  chessContacts[2].died_on  = randomDiedOn(ch2By, 52, 72);

  const classIds   = await insertGroup(classContacts,   g1995);
  const hikingIds  = await insertGroup(hikingContacts,  gHiking);
  const runIds     = await insertGroup(runningContacts, gRunning);
  const chessIds   = await insertGroup(chessContacts,   gChess);
  const bookIds    = await insertGroup(bookContacts,    gBook);
  const bestIds    = await insertGroup(bestContacts,    gBest);

  console.log('Friends contacts seeded');

  // ── Occasions (15+) ───────────────────────────────────────────────────────────
  async function addOccasion(contactId, name, startDate, frequency, notes) {
    await pool.query(
      `INSERT INTO occasions (user_id, contact_id, name, start_date, frequency, notes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, contactId, name, startDate, frequency, notes || null]
    );
  }

  // Family — parents' anniversary
  const marriageYear = 2026 - rand(22, 32);
  await addOccasion(dad.id, 'Wedding anniversary', dateStr(marriageYear, rand(4,9), rand(1,28)), 'yearly', null);
  await addOccasion(mum.id, 'Wedding anniversary', dateStr(marriageYear, rand(4,9), rand(1,28)), 'yearly', null);

  // Grandparents' anniversary (milestone)
  const gpWedYear = 2026 - rand(52, 68);
  await addOccasion(gp1.id, 'Wedding anniversary', dateStr(gpWedYear, rand(5,8), rand(1,28)), 'milestone', 'Golden anniversary');

  // Children graduations
  for (let i = 0; i < 3; i++) {
    const gradYear = 2026 - rand(1, 9);
    await addOccasion(children[i].id, 'University graduation', dateStr(gradYear, 6, rand(1,15)), 'milestone', null);
  }

  // Child milestones
  await addOccasion(children[0].id, 'First job', dateStr(2026 - rand(2,6), rand(1,12), rand(1,28)), 'milestone', null);
  await addOccasion(children[1].id, 'New home',  dateStr(2025, rand(2,11), rand(1,28)), 'one-time', 'Housewarming party');

  // Spouse pairs within family (indices 10/11, 12/13)
  const spouseWed1 = 2026 - rand(12, 22);
  await addOccasion(familyIds[10].id, 'Wedding anniversary', dateStr(spouseWed1, rand(3,8), rand(1,28)), 'yearly', null);
  const spouseWed2 = 2026 - rand(4, 14);
  await addOccasion(familyIds[12].id, 'Wedding anniversary', dateStr(spouseWed2, rand(4,9), rand(1,28)), 'yearly', null);

  // Work — My team work anniversaries
  const workStartYear = 2026 - rand(3, 10);
  await addOccasion(myTeamIds[0], 'Work anniversary', dateStr(workStartYear, rand(1,12), rand(1,28)), 'yearly', 'Joined Acme Corp');
  await addOccasion(myTeamIds[2], 'Work anniversary', dateStr(2026 - rand(1,5), rand(1,12), rand(1,28)), 'yearly', null);

  // Leadership — a team off-site
  await addOccasion(leadIds[0], 'Team off-site', dateStr(2026, 9, rand(10,25)), 'yearly', 'Annual leadership retreat');

  // Friends — Chess tournament
  await addOccasion(chessIds[0], 'Chess tournament', dateStr(2024, 11, 15), 'yearly', 'Annual club championship');
  await addOccasion(chessIds[1], 'Birthday party',   dateStr(2026, 7, 10), 'one-time', '40th birthday celebration');

  // Friends — Running race
  await addOccasion(runIds[0], 'Stockholm Marathon', dateStr(2026, 6, rand(1,15)), 'yearly', null);

  // Friends — Hiking annual trip
  await addOccasion(hikingIds[0], 'Summer hike', dateStr(2026, 7, rand(1,20)), 'yearly', 'Annual mountain trek');

  // Friends — Book club
  await addOccasion(bookIds[0], 'Book club annual meet', dateStr(2026, 10, rand(1,28)), 'yearly', null);

  // Best friends — birthday
  await addOccasion(bestIds[0], 'Birthday', dateStr(2026 - rand(28,45), rand(1,12), rand(1,28)), 'yearly', null);
  await addOccasion(bestIds[1], 'Birthday', dateStr(2026 - rand(28,45), rand(1,12), rand(1,28)), 'yearly', null);

  console.log('Occasions seeded');
  console.log(`Done! 140 contacts across Family / Work / Friends. Log in as ${DEMO_EMAIL}.`);
}

module.exports = seed;

if (require.main === module) {
  require('dotenv').config();
  seed().catch(err => { console.error(err); process.exit(1); });
}
