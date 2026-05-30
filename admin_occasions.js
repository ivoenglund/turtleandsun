// ===========================================================================
// Occasions engine admin (2026-05-30)
// View + edit national gifting occasions (holiday_occasions) and view the
// campaign queue (campaign_queue). Mounted from server.js via:
//   require('./admin_occasions').register(app, { requireRole, escapeHtml, conceptAdminPage });
// Schema + seed: migrations/occasions_engine.sql. Agent spec: _POST_LAUNCH_FEATURES.md #22
// ===========================================================================
const { pool } = require('./db');

const COUNTRY = { US:'United States', CA:'Canada', AU:'Australia', GB:'United Kingdom', IE:'Ireland',
  AL:'Albania', AD:'Andorra', AT:'Austria', BY:'Belarus', BE:'Belgium', BA:'Bosnia & Herzegovina',
  BG:'Bulgaria', HR:'Croatia', CY:'Cyprus', CZ:'Czechia', DK:'Denmark', EE:'Estonia', FI:'Finland',
  FR:'France', DE:'Germany', GR:'Greece', HU:'Hungary', IS:'Iceland', IT:'Italy', XK:'Kosovo',
  LV:'Latvia', LI:'Liechtenstein', LT:'Lithuania', LU:'Luxembourg', MT:'Malta', MD:'Moldova',
  MC:'Monaco', ME:'Montenegro', NL:'Netherlands', MK:'North Macedonia', NO:'Norway', PL:'Poland',
  PT:'Portugal', RO:'Romania', RU:'Russia', SM:'San Marino', RS:'Serbia', SK:'Slovakia',
  SI:'Slovenia', ES:'Spain', SE:'Sweden', CH:'Switzerland', TR:'Turkey', UA:'Ukraine', VA:'Vatican City' };

const RULE_TYPES = ['fixed', 'nth_weekday', 'last_weekday', 'easter_offset'];
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function easter(y){
  const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),
    g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,
    l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),
    mo=Math.floor((h+l-7*m+114)/31),da=((h+l-7*m+114)%31)+1;
  return new Date(y, mo-1, da);
}
function nthwd(y,m,wd,n){ const d=new Date(y,m-1,1); while(d.getDay()!==wd) d.setDate(d.getDate()+1); d.setDate(d.getDate()+7*(n-1)); return d; }
function lastwd(y,m,wd){ const d=new Date(y,m,0); while(d.getDay()!==wd) d.setDate(d.getDate()-1); return d; }
function resolveYear(rt,p,y){
  try{
    if(rt==='nth_weekday') return nthwd(y,p.month,p.weekday,p.nth);
    if(rt==='last_weekday') return lastwd(y,p.month,p.weekday);
    if(rt==='fixed') return new Date(y,p.month-1,p.day);
    if(rt==='easter_offset'){ const e=easter(y); e.setDate(e.getDate()+p.days); return e; }
  }catch(e){}
  return null;
}
function nextDate(rt,p){
  const t=new Date(); t.setHours(0,0,0,0); const y=t.getFullYear();
  for(let yy=y; yy<=y+1; yy++){ const d=resolveYear(rt,p,yy); if(d && d>=t) return d; }
  return resolveYear(rt,p,y+1);
}
function fmtDate(d){ return d ? `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}` : '—'; }
function daysUntil(d){ if(!d) return null; const t=new Date(); t.setHours(0,0,0,0); return Math.round((d-t)/86400000); }
function marketNames(codes){ return (codes||[]).map(c => COUNTRY[c] || c); }

function register(app, deps){
  const { requireRole, escapeHtml, conceptAdminPage } = deps;
  const esc = (s) => escapeHtml(s == null ? '' : String(s));

  // ---- LIST -------------------------------------------------------------
  app.get('/admin/occasions', requireRole('admin'), async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM holiday_occasions ORDER BY name');
      const items = rows.map(r => {
        const nd = nextDate(r.rule_type, r.rule_params);
        return { r, nd, days: daysUntil(nd) };
      }).sort((a,b) => (a.nd && b.nd) ? (a.nd - b.nd) : 0);

      const typeBadge = (t) => {
        const map = { mothers_day:['#FBEAF0','#993556','Mother’s'], fathers_day:['#E6F1FB','#185FA5','Father’s'],
          couples:['#FAECE7','#993C1D','Couples'], family:['#EAF3DE','#3B6D11','Family'], seasonal:['#FAEEDA','#854F0B','Seasonal'] };
        const [bg,fg,lbl] = map[t] || ['#eee','#555',t];
        return `<span style="background:${bg};color:${fg};font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;">${lbl}</span>`;
      };
      const confBadge = (c) => c === 'verify'
        ? '<span style="background:#FFD7B0;color:#9a4a16;font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;">VERIFY</span>'
        : '<span class="muted">ok</span>';

      const renderRow = ({ r, nd, days }) => {
        const names = marketNames(r.markets);
        const mkShort = names.slice(0,3).join(', ') + (names.length > 3 ? ` +${names.length-3}` : '');
        const actions =
          `<form class="inline" method="POST" action="/admin/occasions/toggle/${r.id}" style="display:inline;"><button class="btn small" type="submit">${r.active ? 'Disable' : 'Enable'}</button></form> ` +
          `<a class="btn small" href="/admin/occasions/edit/${r.id}">Edit</a>`;
        return '<tr style="' + (r.active ? '' : 'opacity:0.5;') + '">' +
          `<td><strong>${esc(r.name)}</strong><br><span class="muted" style="font-size:11px;">${esc(r.slug)}</span></td>` +
          `<td>${typeBadge(r.occasion_type)}</td>` +
          `<td>${fmtDate(nd)}<br><span class="muted" style="font-size:11px;">${days==null?'':'in '+days+' days'}</span></td>` +
          `<td title="${esc(names.join(', '))}">${esc(mkShort)}<br><span class="muted" style="font-size:11px;">${names.length} market${names.length===1?'':'s'}</span></td>` +
          `<td>${esc(r.priority||'')}</td>` +
          `<td>${confBadge(r.confidence)}</td>` +
          `<td>${actions}</td>` +
        '</tr>';
      };

      let flash = '';
      if (req.query.saved) flash = '<div class="flash ok">Saved.</div>';
      else if (req.query.error) flash = '<div class="flash err">' + esc(req.query.error) + '</div>';

      const ruleParamsHelp = `nth_weekday: {"month":5,"weekday":0,"nth":2}  ·  last_weekday: {"month":11,"weekday":0}  ·  fixed: {"month":12,"day":25}  ·  easter_offset: {"days":-21}  (weekday 0=Sun)`;

      const body = `
        <div class="top"><h1>Gifting occasions</h1><a href="/admin">← Back to admin</a></div>
        ${flash}
        <p class="muted">National/location occasions the campaign agent works from. Dates are computed live from each rule, so they stay correct every year. <a href="/admin/occasions/queue">View campaign queue →</a></p>
        <table style="margin-top:12px;">
          <thead><tr><th>Occasion</th><th>Type</th><th>Next date</th><th>Markets</th><th>Priority</th><th>Confidence</th><th>Actions</th></tr></thead>
          <tbody>${items.map(renderRow).join('')}</tbody>
        </table>

        <h2 style="margin-top:32px;font-size:18px;">Add an occasion</h2>
        <form method="POST" action="/admin/occasions/save" style="background:#FFF9E6;border-radius:10px;padding:18px;margin-top:8px;border:1px solid rgba(0,0,0,0.08);">
          <input type="hidden" name="action" value="create">
          <div class="row">
            <div class="field"><label>Slug (unique) *</label><input type="text" name="slug" required pattern="[a-z0-9\\-]+" placeholder="md-2sun-may"></div>
            <div class="field"><label>Name *</label><input type="text" name="name" required placeholder="Mother's Day — 2nd Sun May"></div>
          </div>
          <div class="row">
            <div class="field"><label>Type *</label><select name="occasion_type">${['mothers_day','fathers_day','couples','family','seasonal'].map(t=>`<option value="${t}">${t}</option>`).join('')}</select></div>
            <div class="field"><label>Priority</label><input type="text" name="priority" placeholder="High"></div>
            <div class="field"><label>Confidence</label><select name="confidence"><option value="ok">ok</option><option value="verify">verify</option></select></div>
          </div>
          <div class="field"><label>Markets (comma-separated ISO 3166-1 alpha-2 codes)</label><input type="text" name="markets" placeholder="US, CA, AU, GB"></div>
          <div class="row">
            <div class="field"><label>Rule type *</label><select name="rule_type">${RULE_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}</select></div>
            <div class="field"><label>Rule params (JSON) *</label><input type="text" name="rule_params" placeholder='{"month":5,"weekday":0,"nth":2}'></div>
          </div>
          <div class="field"><label>Content angle</label><textarea name="content_angle" rows="2" placeholder="What to push for this occasion"></textarea></div>
          <div class="field"><label><input type="checkbox" name="active" value="on" checked> Active</label></div>
          <button type="submit" class="btn">Add occasion</button>
          <p class="muted" style="margin-top:8px;font-size:11px;">${esc(ruleParamsHelp)}</p>
        </form>
      `;
      res.send(conceptAdminPage('Gifting occasions', body));
    } catch (err) {
      console.error('[admin occasions] error:', err.message);
      res.status(500).send('Failed to load occasions: ' + esc(err.message));
    }
  });

  // ---- TOGGLE -----------------------------------------------------------
  app.post('/admin/occasions/toggle/:id', requireRole('admin'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.redirect('/admin/occasions?error=' + encodeURIComponent('Invalid id.'));
    try {
      await pool.query('UPDATE holiday_occasions SET active = NOT active WHERE id = $1', [id]);
      res.redirect('/admin/occasions?saved=1');
    } catch (err) {
      res.redirect('/admin/occasions?error=' + encodeURIComponent('Toggle failed: ' + err.message));
    }
  });

  // ---- EDIT FORM --------------------------------------------------------
  app.get('/admin/occasions/edit/:id', requireRole('admin'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const { rows } = await pool.query('SELECT * FROM holiday_occasions WHERE id = $1', [id]);
      if (!rows.length) return res.redirect('/admin/occasions?error=' + encodeURIComponent('Occasion not found.'));
      const o = rows[0];
      const v = (s) => esc(s);
      const sel = (a,b) => a === b ? ' selected' : '';
      const nd = nextDate(o.rule_type, o.rule_params);
      const body = `
        <div class="top"><h1>Edit: ${v(o.name)}</h1><a href="/admin/occasions">← Back</a></div>
        <p class="muted">Next occurrence: <strong>${fmtDate(nd)}</strong></p>
        <form method="POST" action="/admin/occasions/save" style="background:#FFF9E6;border-radius:10px;padding:18px;border:1px solid rgba(0,0,0,0.08);">
          <input type="hidden" name="action" value="update">
          <input type="hidden" name="id" value="${o.id}">
          <div class="row">
            <div class="field"><label>Slug (read-only)</label><input type="text" value="${v(o.slug)}" disabled></div>
            <div class="field"><label>Name *</label><input type="text" name="name" required value="${v(o.name)}"></div>
          </div>
          <div class="row">
            <div class="field"><label>Type *</label><select name="occasion_type">${['mothers_day','fathers_day','couples','family','seasonal'].map(t=>`<option value="${t}"${sel(t,o.occasion_type)}>${t}</option>`).join('')}</select></div>
            <div class="field"><label>Priority</label><input type="text" name="priority" value="${v(o.priority)}"></div>
            <div class="field"><label>Confidence</label><select name="confidence"><option value="ok"${sel('ok',o.confidence)}>ok</option><option value="verify"${sel('verify',o.confidence)}>verify</option></select></div>
          </div>
          <div class="field"><label>Markets (comma-separated ISO codes)</label>
            <input type="text" name="markets" value="${v((o.markets||[]).join(', '))}">
            <span class="muted">${v(marketNames(o.markets).join(', '))}</span>
          </div>
          <div class="row">
            <div class="field"><label>Rule type *</label><select name="rule_type">${RULE_TYPES.map(t=>`<option value="${t}"${sel(t,o.rule_type)}>${t}</option>`).join('')}</select></div>
            <div class="field"><label>Rule params (JSON) *</label><input type="text" name="rule_params" value="${v(JSON.stringify(o.rule_params))}"></div>
          </div>
          <div class="field"><label>Content angle</label><textarea name="content_angle" rows="2">${v(o.content_angle)}</textarea></div>
          <div class="field"><label><input type="checkbox" name="active" value="on"${o.active ? ' checked' : ''}> Active</label></div>
          <button type="submit" class="btn">Save changes</button>
        </form>
      `;
      res.send(conceptAdminPage('Edit occasion', body));
    } catch (err) {
      res.redirect('/admin/occasions?error=' + encodeURIComponent('Load failed: ' + err.message));
    }
  });

  // ---- SAVE (create / update) ------------------------------------------
  app.post('/admin/occasions/save', requireRole('admin'), async (req, res) => {
    const action = req.body.action === 'update' ? 'update' : 'create';
    const name = String(req.body.name || '').trim();
    const occasionType = String(req.body.occasion_type || '').trim();
    const priority = String(req.body.priority || '').trim();
    const confidence = req.body.confidence === 'verify' ? 'verify' : 'ok';
    const contentAngle = String(req.body.content_angle || '').trim();
    const active = req.body.active === 'on' || req.body.active === 'true' || req.body.active === '1';
    const ruleType = String(req.body.rule_type || '').trim();
    if (!name) return res.redirect('/admin/occasions?error=' + encodeURIComponent('Name is required.'));
    if (!RULE_TYPES.includes(ruleType)) return res.redirect('/admin/occasions?error=' + encodeURIComponent('Invalid rule type.'));
    const markets = String(req.body.markets || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]{2}$/.test(s));
    let ruleParams;
    try {
      ruleParams = JSON.parse(req.body.rule_params || '{}');
      if (typeof ruleParams !== 'object' || Array.isArray(ruleParams)) throw new Error('must be a JSON object');
    } catch (e) {
      return res.redirect('/admin/occasions?error=' + encodeURIComponent('Rule params must be valid JSON object: ' + e.message));
    }
    try {
      if (action === 'update') {
        const id = parseInt(req.body.id, 10);
        await pool.query(
          `UPDATE holiday_occasions SET name=$1, occasion_type=$2, markets=$3::jsonb, rule_type=$4,
             rule_params=$5::jsonb, content_angle=$6, priority=$7, confidence=$8, active=$9 WHERE id=$10`,
          [name, occasionType, JSON.stringify(markets), ruleType, JSON.stringify(ruleParams),
           contentAngle, priority, confidence, active, id]
        );
      } else {
        const slug = String(req.body.slug || '').trim().toLowerCase();
        if (!/^[a-z0-9\-]+$/.test(slug)) return res.redirect('/admin/occasions?error=' + encodeURIComponent('Slug must be lowercase letters, digits, hyphens.'));
        await pool.query(
          `INSERT INTO holiday_occasions (slug, name, occasion_type, markets, rule_type, rule_params, content_angle, priority, confidence, active)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8,$9,$10)
           ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, occasion_type=EXCLUDED.occasion_type,
             markets=EXCLUDED.markets, rule_type=EXCLUDED.rule_type, rule_params=EXCLUDED.rule_params,
             content_angle=EXCLUDED.content_angle, priority=EXCLUDED.priority, confidence=EXCLUDED.confidence, active=EXCLUDED.active`,
          [slug, name, occasionType, JSON.stringify(markets), ruleType, JSON.stringify(ruleParams),
           contentAngle, priority, confidence, active]
        );
      }
      res.redirect('/admin/occasions?saved=1');
    } catch (err) {
      console.error('[admin occasions save] error:', err.message);
      res.redirect('/admin/occasions?error=' + encodeURIComponent('Save failed: ' + err.message));
    }
  });

  // ---- CAMPAIGN QUEUE (read-only) --------------------------------------
  app.get('/admin/occasions/queue', requireRole('admin'), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT cq.*, ho.name AS occasion_name
           FROM campaign_queue cq
           LEFT JOIN holiday_occasions ho ON ho.id = cq.holiday_occasion_id
          ORDER BY cq.occasion_date NULLS LAST, cq.id
          LIMIT 500`);
      const stColor = { planned:'#888', drafted:'#854F0B', scheduled:'#185FA5', sent:'#3B6D11', skipped:'#999', failed:'#a12a1a' };
      const renderRow = (r) => {
        const c = stColor[r.status] || '#555';
        return '<tr>' +
          `<td>${r.occasion_date ? esc(new Date(r.occasion_date).toISOString().slice(0,10)) : '—'}</td>` +
          `<td>${esc(r.occasion_name || r.source_type)}</td>` +
          `<td>${esc(r.market || '')}</td>` +
          `<td>${esc(r.channel)}</td>` +
          `<td><span style="color:${c};font-weight:700;">${esc(r.status)}</span></td>` +
          `<td>${esc(r.subject || '')}</td>` +
        '</tr>';
      };
      const empty = '<p class="muted" style="margin-top:16px;">No queued campaigns yet. The campaign agent (post-launch — see roadmap #22) will populate this from upcoming occasions.</p>';
      const body = `
        <div class="top"><h1>Campaign queue</h1><a href="/admin/occasions">← Back to occasions</a></div>
        <p class="muted">What is queued to draft, print, and send. Populated by the campaign agent once it is built.</p>
        ${rows.length ? `<table style="margin-top:12px;"><thead><tr><th>Date</th><th>Occasion</th><th>Market</th><th>Channel</th><th>Status</th><th>Subject</th></tr></thead><tbody>${rows.map(renderRow).join('')}</tbody></table>` : empty}
      `;
      res.send(conceptAdminPage('Campaign queue', body));
    } catch (err) {
      console.error('[admin occasions queue] error:', err.message);
      res.status(500).send('Failed to load queue: ' + esc(err.message));
    }
  });
}

module.exports = { register };
