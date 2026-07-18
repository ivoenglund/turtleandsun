// Seed ~50 demo blog posts (family-life themed) for the timeline + group website.
//
//   node seed-demo-posts.js [email] [groupTag] [count]
//
// Defaults: ivo.englund@3doc.se, "Family", all 50. Posts are tagged with the group
// name (so they follow the group in the timeline and on the public site) plus
// 'demo' so a re-run can clean them up first. Photos come from picsum.photos
// (stable seeded URLs, no account needed).

const { pool } = require('./db');

const EMAIL = process.argv[2] || 'ivo.englund@3doc.se';
const GROUP_TAG = process.argv[3] || 'Family';
const COUNT = parseInt(process.argv[4] || '50', 10);

// month = preferred month (season-correct dates); paras join with blank lines.
const POSTS = [
  { t: 'Midsummer at the lake house', m: 6, tags: ['midsummer', 'summer'], paras: [
    'We made it out to the lake house again for midsummer, all seventeen of us plus two dogs. The strawberries were late this year but Grandma Karin still managed three cakes.',
    'Uncle Lars raised the maypole with the kids hanging off both sides of it, and somehow it stayed up through the whole evening. The frog dance had four generations in the ring at once.',
    'It rained at nine, exactly like every year, and exactly like every year nobody cared.' ] },
  { t: 'Elsa lost her first tooth', m: 3, tags: ['kids'], paras: [
    'It finally happened — the wiggly tooth gave up during breakfast, in the middle of a cinnamon bun. Elsa was more proud than surprised.',
    'The tooth fairy pays twenty kronor these days, apparently. Inflation has reached the pillow.' ] },
  { t: 'Hugo\'s first day of school', m: 8, tags: ['kids', 'school'], paras: [
    'Backpack bigger than the boy. Hugo marched into class 1B without looking back once, which was harder on us than on him.',
    'His teacher says the first week is mostly about finding your peg and your chair. He came home full of facts about dinosaurs, so something more must be happening.',
    'We celebrated with tacos, his choice. Everything is tacos right now.' ] },
  { t: 'Bella turned ten', m: 4, tags: ['pets', 'birthday'], paras: [
    'Our old girl turned ten today. Ten years of stolen socks, guarded doorsteps and unconditional joy at the sound of the treat drawer.',
    'She got a liver cake with a single candle she was not allowed near, and a longer walk than her hips probably wanted. She would disagree.' ] },
  { t: 'Sunday dinner is back', m: 9, tags: ['food', 'tradition'], paras: [
    'After a scattered summer we restarted the first-Sunday-of-the-month dinner. Twelve chairs, eleven people, one dog under the table pretending to be invisible.',
    'Mum made her meatballs with the cream sauce nobody can replicate, though Sara got closest last spring and has not been allowed to forget it.',
    'Next month it is at our place. The bar is unfairly high.' ] },
  { t: 'The apple harvest got out of hand', m: 9, tags: ['garden', 'autumn'], paras: [
    'The old tree behind the shed decided this was its year. We have filled every bowl, bucket and bathtub-adjacent container in the house.',
    'Grandma\'s apple cake recipe has now been made four times in nine days. We are becoming the people who bring apples to gatherings uninvited.',
    'If you are reading this and know us personally: come get apples.' ] },
  { t: 'Skiing week in Sälen', m: 2, tags: ['winter', 'travel'], paras: [
    'Five days in Sälen with both families sharing one cabin, which is either brave or foolish depending on the hour of the day.',
    'Elsa graduated from the children\'s slope to the blue runs and told everyone at dinner, twice. Hugo remains loyal to the sledge.',
    'Lars claims he has not fallen once. There is video evidence to the contrary, and it will be shown at Christmas.' ] },
  { t: 'Grandpa\'s tools found a new home', m: 5, tags: ['memory'], paras: [
    'We finally sorted the garage shelves that still had Grandpa\'s tools on them. Nobody wanted to be the one to do it, and then somehow it became a nice afternoon.',
    'Every chisel had a story. The plane he built the summer house steps with is going to Marcus, who inherited both the interest and the patience.',
    'The rest is cleaned, oiled and labelled — one box per grandchild, for whenever they get their first place.' ] },
  { t: 'First snow', m: 11, tags: ['winter'], paras: [
    'It arrived overnight, quietly, the way the best snow does. By seven the garden was unrecognizable and by half past the kids were in it.',
    'The snowman is called Roland. We do not know why. His carrot lasted forty minutes before Bella found it.' ] },
  { t: 'Crayfish party on the balcony', m: 8, tags: ['tradition', 'summer'], paras: [
    'Paper lanterns, silly hats, and the annual argument about whether the songs come before or after the first crayfish. (Before. It is settled. Stop.)',
    'The balcony fits eight comfortably, so naturally we were eleven.' ] },
  { t: 'Elsa\'s dance recital', m: 5, tags: ['kids'], paras: [
    'Two months of rehearsals came down to four minutes on stage, and she nailed it. Front row, second from the left, the one grinning through the entire routine.',
    'Flowers after, ice cream after that. She slept in her costume.' ] },
  { t: 'The great kitchen renovation begins', m: 1, tags: ['house'], paras: [
    'We have talked about it for three years and today the first cabinet came off the wall. There is no going back now.',
    'Current kitchen: a kettle, a microwave and a folding table in the living room. Estimated survival time: four weeks. The contractor says six. We will report from the field.',
    'The old cabinets are going to the summer house, where they will be received as luxury.' ] },
  { t: 'Kitchen renovation, week five', m: 2, tags: ['house'], paras: [
    'The contractor was right and we were naive. But — the countertop is in, the tap works, and we cooked actual food on an actual stove last night.',
    'First meal in the new kitchen: pancakes, by unanimous vote. Grandma came to inspect and approved, which is the only certification that matters.' ] },
  { t: 'Autumn walk in the nature reserve', m: 10, tags: ['autumn', 'outdoors'], paras: [
    'The whole gang, thermoses and all, out among the maples. The kids collected exactly one hundred leaves for a school project and we counted every single one.',
    'Bella flushed a deer and briefly believed she was a wolf. The deer disagreed.' ] },
  { t: 'Lucia morning', m: 12, tags: ['tradition', 'winter'], paras: [
    'Up at six, saffron buns at half past, and Elsa in the Lucia crown she has been practicing wearing since November.',
    'The procession at school was equal parts beautiful and chaotic, which is to say it was perfect. Hugo was a gingerbread man and took the role very seriously.',
    'Home before dark, which this time of year means home before three.' ] },
  { t: 'New potatoes and pickled herring', m: 6, tags: ['food', 'summer'], paras: [
    'First new potatoes of the year from Lars\'s patch, boiled with dill, eaten with herring and far too much butter. Summer officially exists now.' ] },
  { t: 'Maja passed her driving test', m: 4, tags: ['milestone'], paras: [
    'First try! The family fleet gains a driver and every future gathering gains a designated one, as she pointed out within the hour.',
    'Her first solo trip was to Grandma\'s, unprompted, with cinnamon buns. Raised right.' ] },
  { t: 'The summer house opening weekend', m: 5, tags: ['summer house', 'tradition'], paras: [
    'Shutters off, water on, mouse situation assessed (two, deceased, dignified funeral behind the woodshed by Hugo\'s insistence).',
    'The jetty survived the winter. The rowing boat needs paint, which has been true since 2019 and will be true forever.',
    'Evening ended the way opening weekend always ends: sausages on the grill, blankets, and someone saying "we should come out here more often." We should.' ] },
  { t: 'Closing the summer house', m: 10, tags: ['summer house', 'autumn'], paras: [
    'Water off, shutters on, the little ritual walk through every room to say goodnight to the house. Elsa does the talking now; she inherited the job from her mother without either of them deciding it.',
    'Last swim of the year went to Lars, obviously. Eleven degrees. He said it was refreshing. His face said other things.' ] },
  { t: 'A cake for ninety years', m: 3, tags: ['birthday', 'milestone'], paras: [
    'Ninety years of Grandma Karin, celebrated with four generations, one enormous princess cake and a speech from her that had the whole room laughing and then quiet.',
    'She says the secret is coffee, stubbornness and never watching the news after eight.',
    'Ninety candles is a fire hazard, so we did nine big ones. She blew them out in one go and raised an eyebrow at all of us.' ] },
  { t: 'Bike trip around the island', m: 7, tags: ['summer', 'outdoors'], paras: [
    'Forty kilometres, six bikes, two ice cream stops and one dramatic chain repair performed by Maja while the rest of us held things and offered opinions.',
    'The wind was against us both directions, which everyone agreed was impossible and true.' ] },
  { t: 'Hugo\'s dinosaur phase reaches new heights', m: 1, tags: ['kids'], paras: [
    'He can now pronounce Parasaurolophus but not Wednesday. He has ranked all aunts and uncles by which dinosaur they would be. Lars is not happy about being a Diplodocus.',
    'The library called: we have reached the borrowing limit on dinosaur books. We did not know there was one.' ] },
  { t: 'Homemade pizza night became a competition', m: 2, tags: ['food'], paras: [
    'What started as a normal Friday escalated into a judged event with score cards. Sara won on presentation, Marcus on ambition (calzone, structurally unsound), Elsa on pure confidence.',
    'The oven has been forgiven for the smoke alarm incident.' ] },
  { t: 'Spring came to the allotment', m: 4, tags: ['garden', 'spring'], paras: [
    'First proper day at the allotment. Beds turned, radishes and carrots in, and the rhubarb is already showing off.',
    'Grandma supervised from the good chair with coffee, issuing corrections. Her hit rate remains one hundred percent.',
    'Sweet peas along the fence this year, her request. Nobody says no to the good chair.' ] },
  { t: 'The boat finally floats again', m: 6, tags: ['summer house'], paras: [
    'Three weekends of scraping and painting and the rowing boat is back in the water where she belongs. She still leaks a little. So do we all.',
    'Maiden voyage crew: Hugo (captain, by volume), Elsa (first mate), Bella (morale). They made it to the reeds and back.' ] },
  { t: 'A quiet one', m: 11, tags: ['everyday'], paras: [
    'No occasion this week. Soup on the stove, rain on the window, everyone home and nowhere to be. Writing it down because these are the days we will miss the most and photograph the least.' ] },
  { t: 'Elsa\'s first swimming badge', m: 7, tags: ['kids', 'milestone'], paras: [
    'Two hundred metres, no floaties, one very proud seven-year-old. The badge is sewn on the towel already because it could not wait for the washing machine cycle.',
    'Celebration ice cream was the big cone. Some milestones demand the big cone.' ] },
  { t: 'Chanterelle luck', m: 9, tags: ['autumn', 'food', 'outdoors'], paras: [
    'The secret spot delivered. Two baskets in an hour, and the location remains classified — Lars made everyone leave their phones in the car, half as a joke.',
    'Chanterelle toast for dinner, chanterelle risotto planned, the rest frozen for the darkest week of January when we will need it most.' ] },
  { t: 'Games night got competitive again', m: 1, tags: ['tradition'], paras: [
    'Monopoly is banned since the incident of 2023, so we played cards. It did not help. Grandma won three rounds in a row and has started referring to herself as the house.',
    'Next month: the return of the puzzle. One thousand pieces, mostly sky. Pray for us.' ] },
  { t: 'The graduation cap fits', m: 6, tags: ['milestone'], paras: [
    'Maja graduated! Three years flew past and suddenly there she was on the school steps, cap on, roses everywhere, the truck with the sound system waiting.',
    'Grandpa\'s old student cap from 1962 made the trip in Grandma\'s handbag, and the two caps got a photo together. Sixty-something years apart, same grin.',
    'The party went on long after the official part. The photo album from it is already thick.' ] },
  { t: 'Baking day before Christmas', m: 12, tags: ['tradition', 'food', 'winter'], paras: [
    'Annual gingerbread day: four kinds of cookies, two kitchens running in parallel, flour in places flour should not reach.',
    'The gingerbread house is architecture this year — Marcus brought a ruler and lost the room immediately. The kids\' free-form cottage won the vote, as it should.',
    'Saffron buns count: ninety. Remaining by evening: seventy-one. The investigation continues.' ] },
  { t: 'Christmas Eve', m: 12, tags: ['tradition', 'winter'], paras: [
    'Donald Duck at three, ham and prinskorv and Jansson\'s at five, presents after — the order of operations is not up for discussion and never has been.',
    'Hugo got the LEGO set he has been circling in the catalogue since October. Elsa got skates. Grandma got socks and pretended to be surprised, then teared up at the photo book, which was the real present.',
    'A quiet moment by the candles for the ones who are not at the table anymore. Then more cake, because that is what they would have wanted.' ] },
  { t: 'New Year at the summer house', m: 12, tags: ['tradition', 'winter'], paras: [
    'We opened the summer house just for the night — freezing, wonderful, completely worth it. Fireworks over the ice and hot chocolate with a splash of something for the grown-ups.',
    'Resolutions were declared and immediately doubted. Lars is going to run a marathon. Sure, Lars.' ] },
  { t: 'The puzzle is finished', m: 2, tags: ['everyday'], paras: [
    'One thousand pieces, thirty-one days, four contributors and one piece missing until Bella\'s bed was searched. It is done. It is glued. It is going on the wall of the summer house next to the 2022 one.',
    'Grandma placed the final piece, by right and by tradition.' ] },
  { t: 'Semlor season opened early', m: 2, tags: ['food', 'tradition'], paras: [
    'The bakery started in January, which sparked the annual ethics debate, which we resolved by buying six.',
    'Family ranking remains: cream first, then almond paste, and cardamom in the bun is non-negotiable. Hugo eats only the lid. More for him, less sense.' ] },
  { t: 'Easter egg hunt, extended edition', m: 4, tags: ['tradition', 'spring'], paras: [
    'Uncle Lars hid the eggs this year, which meant a difficulty spike nobody consented to. One egg required moving the wheelbarrow. One was in the mailbox. One has not been found and he will not tell.',
    'The kids ate their weight in candy and the adults ate the kids\' rejects, as is the natural order.' ] },
  { t: 'Walpurgis bonfire down by the field', m: 4, tags: ['tradition', 'spring'], paras: [
    'The village bonfire was tall as a house this year. We sang the songs about spring while wearing winter jackets, which is the most Swedish sentence ever written.',
    'Sausages after, of course. The kids stayed up too late, of course. Worth it, of course.' ] },
  { t: 'Elsa and Hugo built a den', m: 7, tags: ['kids', 'summer', 'outdoors'], paras: [
    'Three days of construction behind the summer house: branches, string, an old blanket and a NO GROWN-UPS sign with the S backwards.',
    'Grown-ups are, however, permitted to deliver sandwiches to the border. There is a system. We respect the system.' ] },
  { t: 'Grandma taught the kids cinnamon buns', m: 10, tags: ['food', 'tradition'], paras: [
    'The recipe is in her head and only in her head, so this was an important day. Elsa measured, Hugo folded (his word; the buns disagreed), and the kitchen smelled like every good memory at once.',
    'The recipe is now written down in Elsa\'s best handwriting and stored in the tin with the photos. Mission accomplished, twenty years ahead of schedule.' ] },
  { t: 'A new cousin has arrived', m: 3, tags: ['milestone', 'kids'], paras: [
    'Welcome little Vera, 3.4 kilos of instant family celebrity. Mother and daughter both doing great, father doing his best.',
    'Elsa has appointed herself head of cousin orientation and is preparing a welcome tour of the summer house for someone who cannot yet hold her own head up. Planning ahead runs in the family.' ] },
  { t: 'Vera\'s christening', m: 6, tags: ['milestone', 'tradition'], paras: [
    'The little white dress has now been worn by four generations, which the priest said might be a parish record.',
    'Vera slept through the entire ceremony and woke up exactly when the cake appeared. She knows what matters.' ] },
  { t: 'The herring debate of the summer', m: 7, tags: ['food', 'summer'], paras: [
    'Mustard herring versus onion herring, an argument older than some of the participants. This year it was settled by blind taste test, organized by Maja with scorecards and everything.',
    'Mustard won. Recounts were demanded. The committee has dissolved amid controversy and will reconvene next July.' ] },
  { t: 'Autumn holiday at the museum', m: 10, tags: ['kids', 'autumn'], paras: [
    'Rainy autumn break, so: the natural history museum, aka Hugo\'s cathedral. He guided us. He had opinions about the placard text. He was right about one of them, which is frankly alarming.',
    'Elsa preferred the space section and has updated her career plan accordingly. Astronaut-veterinarian, part time.' ] },
  { t: 'The leaf-raking championship', m: 11, tags: ['garden', 'autumn'], paras: [
    'Seven bags of leaves, one very big pile first, obviously. You do not rake a pile that size and not jump in it. Even Grandma had a go, and her form was excellent.',
    'Bella\'s contribution was redistribution. We have discussed it. She has heard our position.' ] },
  { t: 'Movie night: the projector era begins', m: 1, tags: ['everyday'], paras: [
    'Marcus arrived with a projector and a bedsheet and suddenly the living room is a cinema. First screening was decided by the kids, so we all know the singing snowman by heart now.',
    'Popcorn machine next, apparently. This escalates.' ] },
  { t: 'Fishing morning with Grandpa Per', m: 6, tags: ['summer house', 'outdoors'], paras: [
    'Per took the kids out at six in the rowing boat, which meant coffee on the jetty for the rest of us watching the fog lift.',
    'Catch report: two perch (Hugo), one perch (Elsa), zero (Per, who insists he was coaching). All released except the story, which will only grow.' ] },
  { t: 'The family recipe book project', m: 2, tags: ['food', 'memory'], paras: [
    'We started collecting everyone\'s recipes into one book — Grandma\'s buns, Mum\'s meatballs, Lars\'s herring marinade, the pancake ratios that took a decade to perfect.',
    'Old handwritten cards are being photographed as they are, stains and all. The stains are the proof they were loved.',
    'Target: printed copies for everyone by Christmas. This blog post is the public commitment so we cannot back out.' ] },
  { t: 'Elsa\'s loose tooth economy expands', m: 9, tags: ['kids'], paras: [
    'Tooth number four. She has started a savings jar labelled HORSE. We have started a conversation labelled NOT A HORSE. Current standings: unclear.' ] },
  { t: 'Winter swim, and the sauna that saved it', m: 1, tags: ['winter', 'summer house'], paras: [
    'Lars talked four of us into the ice hole. The sauna talked us into staying alive afterwards. Photos exist of the exact moment each person regretted everything.',
    'Grandma watched from the window with coffee and the expression of someone whose generation did this without a sauna. Point taken.' ] },
  { t: 'The big family photo, finally', m: 8, tags: ['milestone', 'memory'], paras: [
    'All of us. Same place, same time, dressed and smiling — a logistical miracle three years in the making. Twenty-two people, one timer, eleven attempts.',
    'The winning frame has Bella mid-yawn and Hugo mid-jump and it is perfect precisely because of that. It is already framed at Grandma\'s, biggest size the shop had.',
    'Next one in five years. Calendar invites have gone out. There will be no escape.' ] },
  { t: 'Soup Saturday and the first frost', m: 11, tags: ['food', 'everyday'], paras: [
    'First frost on the grass this morning, so the big pot came out: yellow pea soup, pancakes after, thin ones with jam, rolled by the kids into what they call cigars and we call chaos.',
    'The house smelled like Thursday at Grandma\'s in 1995, which was the whole point.' ] },
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function main() {
  const userRes = await pool.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [EMAIL]);
  if (!userRes.rows.length) { console.error('No user with email ' + EMAIL); process.exit(1); }
  const userId = userRes.rows[0].id;

  const grp = await pool.query(`SELECT id FROM groups WHERE user_id = $1 AND LOWER(name) = LOWER($2)`, [userId, GROUP_TAG]);
  if (!grp.rows.length) console.warn(`Note: no group named "${GROUP_TAG}" for this user — posts are tagged "${GROUP_TAG}" anyway.`);

  const cleaned = await pool.query(
    `DELETE FROM blog_posts WHERE user_id = $1 AND tags @> '["demo"]'::jsonb`, [userId]
  );
  if (cleaned.rowCount) console.log(`Removed ${cleaned.rowCount} earlier demo posts.`);

  const now = new Date();
  const posts = POSTS.slice(0, COUNT);
  let inserted = 0;

  for (const p of posts) {
    // Season-correct date in a random recent year, never in the future.
    let year = 2026 - rand(0, 3);
    if (year === now.getFullYear() && p.m > now.getMonth() + 1) year -= 1;
    const day = rand(1, 28);
    const post_date = `${year}-${String(p.m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const photoCount = p.paras.length >= 3 ? rand(1, 2) : rand(0, 1);
    const photos = [];
    for (let i = 0; i < photoCount; i++) {
      const seed = p.t.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) + '-' + i;
      photos.push(`https://picsum.photos/seed/${seed}/900/600`);
    }

    const tags = [GROUP_TAG, 'demo', ...p.tags];

    await pool.query(
      `INSERT INTO blog_posts (user_id, title, body, post_date, tags, photos)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [userId, p.t, p.paras.join('\n\n'), post_date, JSON.stringify(tags), JSON.stringify(photos)]
    );
    inserted++;
  }

  console.log(`Inserted ${inserted} demo posts for ${EMAIL}, tagged "${GROUP_TAG}".`);
  console.log(`They appear in the studio timeline and on the group's public site.`);
  console.log(`Remove them anytime with: DELETE FROM blog_posts WHERE tags @> '["demo"]'::jsonb;`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
