// contact-panel.js — shared editable contact detail panel
// Usage:
//   CP.init('containerId')          inject HTML into element
//   CP.open(contactId)              load and show full record
//   CP.close()                      show empty state
//   CP.contacts = arr               set for relationship dropdowns
//   CP.allGroups = arr              set for group checkboxes
//   CP.relTypes = arr               set for relationship type dropdown
//   CP.onSaved = fn(updatedContact) called after successful save

const CP = (() => {
  let _currentId = null;
  let _contacts = [];
  let _allGroups = [];
  let _relTypes = [];
  let _contactGroupIds = new Set();
  let _inFamilyGroup = false;

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _injectCSS() {
    if (document.getElementById('cp-styles')) return;
    const s = document.createElement('style');
    s.id = 'cp-styles';
    s.textContent = `
.cp-empty{display:flex;align-items:center;justify-content:center;height:160px;font-size:14px;color:rgba(28,10,0,0.25);font-family:'Plus Jakarta Sans',sans-serif;font-weight:500;text-align:center;padding:24px;}
.cp-inner{max-width:680px;margin:0 auto;padding:24px 28px 80px;}
.cp-header{margin-bottom:20px;}
.cp-name-display{font-family:'Plus Jakarta Sans',sans-serif;font-size:20px;font-weight:800;line-height:1.2;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.cp-ph-badge{display:inline-block;padding:3px 9px;border-radius:10px;font-size:11px;font-weight:700;background:#f0ede6;color:rgba(28,10,0,0.45);}
.cp-deceased-badge{display:inline-block;padding:3px 9px;border-radius:10px;font-size:11px;font-weight:700;background:#f0ede6;color:rgba(28,10,0,0.55);}
.cp-card{background:#fff;border-radius:12px;padding:20px 22px;margin-bottom:14px;box-shadow:0 1px 6px rgba(0,0,0,0.06);}
.cp-card-title{font-family:'Plus Jakarta Sans',sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:rgba(28,10,0,0.32);margin-bottom:14px;}
.cp-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.cp-field{display:flex;flex-direction:column;gap:5px;}
.cp-field label{font-size:11px;font-weight:600;color:rgba(28,10,0,0.42);text-transform:uppercase;letter-spacing:0.04em;}
.cp-field input[type=text],.cp-field input[type=email],.cp-field input[type=tel],.cp-field input[type=date]{padding:8px 10px;border:1.5px solid #e0dcd4;border-radius:7px;font-size:13px;font-family:'DM Sans',sans-serif;color:#1C0A00;background:#fff;outline:none;transition:border-color 0.15s;}
.cp-field input:focus{border-color:#3A6B20;}
.cp-field-full{grid-column:1/-1;}
.cp-field-check{flex-direction:row;align-items:center;gap:8px;padding-top:18px;}
.cp-field-check label{font-size:13px;font-weight:500;color:#1C0A00;text-transform:none;letter-spacing:0;cursor:pointer;display:flex;align-items:center;gap:6px;}
.cp-field-check input[type=checkbox]{width:16px;height:16px;accent-color:#3A6B20;cursor:pointer;}
.cp-save-row{margin-top:14px;display:flex;align-items:center;gap:12px;}
.cp-btn-save{padding:9px 22px;background:#3A6B20;color:#fff;border:none;border-radius:8px;font-family:'Plus Jakarta Sans',sans-serif;font-size:13px;font-weight:700;cursor:pointer;transition:background 0.15s;}
.cp-btn-save:hover{background:#1C0A00;}
.cp-btn-save:disabled{opacity:0.5;cursor:not-allowed;}
.cp-save-msg{font-size:12px;}
.cp-save-msg.ok{color:#3A6B20;} .cp-save-msg.err{color:#c0392b;}
.cp-groups-list{display:flex;flex-direction:column;gap:5px;}
.cp-group-row{display:flex;align-items:center;gap:6px;padding:7px 12px;background:#f9f7f2;border:1.5px solid #e0dcd4;border-radius:8px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-size:13px;font-weight:600;color:#1C0A00;user-select:none;transition:border-color 0.15s,background 0.15s;}
.cp-group-row:hover{border-color:#3A6B20;}
.cp-group-row input[type=checkbox]{width:14px;height:14px;accent-color:#3A6B20;cursor:pointer;flex-shrink:0;}
.cp-group-row.checked{background:#e8f0e0;border-color:#3A6B20;}
.cp-group-children{padding-left:20px;display:flex;flex-direction:column;gap:3px;margin-top:2px;}
.cp-group-row.cp-group-sub{font-size:12px;padding:5px 10px;border-radius:6px;}
.cp-table-wrap{overflow-x:auto;}
.cp-table-wrap table{width:100%;border-collapse:collapse;font-size:13px;}
.cp-table-wrap th{text-align:left;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:rgba(28,10,0,0.32);border-bottom:1.5px solid #f0ede6;}
.cp-table-wrap td{padding:9px 10px;border-bottom:1px solid #f5f2ea;vertical-align:middle;}
.cp-table-wrap tr:last-child td{border-bottom:none;}
.cp-empty-row td{text-align:center;color:rgba(28,10,0,0.28);padding:20px 10px;font-size:13px;}
.cp-btn-del{padding:3px 9px;background:none;border:1px solid #e0dcd4;border-radius:5px;font-size:11px;cursor:pointer;color:rgba(28,10,0,0.42);font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;}
.cp-btn-del:hover{border-color:#c0392b;color:#c0392b;}
.cp-add-form{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;}
.cp-add-form select,.cp-add-form input{flex:1;min-width:110px;padding:8px 10px;border:1.5px solid #e0dcd4;border-radius:7px;font-size:13px;color:#1C0A00;background:#fff;outline:none;font-family:'DM Sans',sans-serif;}
.cp-add-form select:focus,.cp-add-form input:focus{border-color:#3A6B20;}
.cp-btn-add{padding:8px 16px;background:#3A6B20;color:#fff;border:none;border-radius:7px;font-family:'Plus Jakarta Sans',sans-serif;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;}
.cp-btn-add:hover{background:#1C0A00;}
.cp-form-msg{font-size:12px;margin-top:8px;min-height:16px;}
.cp-form-msg.err{color:#c0392b;}
.cp-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle;}
.cp-dot.done{background:#3A6B20;} .cp-dot.pending{background:#f0a500;} .cp-dot.failed{background:#c0392b;}
@media(max-width:1000px){.cp-inner{padding:20px 16px 60px;}.cp-grid{grid-template-columns:1fr;}}
    `;
    document.head.appendChild(s);
  }

  const _HTML = `
<div class="cp-empty" id="cpEmpty">Select a contact to see details.</div>
<div id="cpContent" style="display:none;overflow-y:auto;flex:1;">
  <div class="cp-inner">
    <div class="cp-header">
      <div class="cp-name-display">
        <span id="cpNameDisplay"></span>
        <span id="cpPetIcon" style="display:none;">🐾</span>
        <span class="cp-ph-badge" id="cpPhBadge" style="display:none;">Manual</span>
        <span class="cp-deceased-badge" id="cpDeceasedBadge" style="display:none;">Deceased</span>
      </div>
    </div>

    <div class="cp-card">
      <div class="cp-card-title">Contact details</div>
      <div class="cp-grid">
        <div class="cp-field cp-field-full"><label>Name</label><input type="text" id="cpFName"></div>
        <div class="cp-field"><label>Email</label><input type="email" id="cpFEmail"></div>
        <div class="cp-field"><label>Phone</label><input type="tel" id="cpFPhone"></div>
        <div class="cp-field"><label>Birthday</label><input type="date" id="cpFBirthday"></div>
        <div class="cp-field"><label>Died on</label><input type="date" id="cpFDiedOn"></div>
        <div class="cp-field"><label>Street</label><input type="text" id="cpFStreet"></div>
        <div class="cp-field"><label>City</label><input type="text" id="cpFCity"></div>
        <div class="cp-field"><label>Country</label><input type="text" id="cpFCountry"></div>
        <div class="cp-field"><label>Postal code</label><input type="text" id="cpFPostal"></div>
        <div class="cp-field cp-field-check">
          <label><input type="checkbox" id="cpFIsPet"> 🐾 This is a pet</label>
        </div>
      </div>
      <div class="cp-save-row">
        <button class="cp-btn-save" id="cpBtnSave" onclick="CP._saveContact()">Save</button>
        <span class="cp-save-msg" id="cpSaveMsg"></span>
      </div>
    </div>

    <div class="cp-card">
      <div class="cp-card-title">Groups</div>
      <div class="cp-groups-list" id="cpGroupsCheckboxes">
        <span style="font-size:13px;color:rgba(28,10,0,0.35);">Loading…</span>
      </div>
    </div>

    <div class="cp-card" id="cpFamilyCard" style="display:none;">
      <div class="cp-card-title">Family relationships</div>
      <div class="cp-table-wrap">
        <table>
          <thead><tr><th>Person</th><th>Relationship</th><th></th></tr></thead>
          <tbody id="cpRelBody"></tbody>
        </table>
      </div>
      <div class="cp-add-form">
        <select id="cpRelContact"><option value="">— Select person —</option></select>
        <select id="cpRelType"><option value="">— Relationship —</option></select>
        <button class="cp-btn-add" onclick="CP._addRelationship()">Add</button>
      </div>
      <div class="cp-form-msg" id="cpRelMsg"></div>
    </div>

    <div class="cp-card">
      <div class="cp-card-title">Occasions</div>
      <div class="cp-table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Date</th><th>Frequency</th><th></th></tr></thead>
          <tbody id="cpOccBody"></tbody>
        </table>
      </div>
      <div class="cp-add-form">
        <input type="text" id="cpOccName" placeholder="e.g. Wedding anniversary">
        <input type="date" id="cpOccDate">
        <select id="cpOccFreq">
          <option value="yearly">Yearly</option>
          <option value="milestone">Milestone</option>
          <option value="one-time">One-time</option>
        </select>
        <button class="cp-btn-add" onclick="CP._addOccasion()">Add</button>
      </div>
      <div class="cp-form-msg" id="cpOccMsg"></div>
    </div>

    <div class="cp-card">
      <div class="cp-card-title">Loveogram history</div>
      <div class="cp-table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Product</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody id="cpLovBody"></tbody>
        </table>
      </div>
    </div>

  </div>
</div>
  `;

  function init(containerId) {
    _injectCSS();
    const el = document.getElementById(containerId);
    if (el) el.innerHTML = _HTML;
  }

  async function open(id) {
    _currentId = id;
    document.getElementById('cpEmpty').style.display = 'none';
    document.getElementById('cpContent').style.display = 'block';
    document.getElementById('cpSaveMsg').textContent = '';

    const [cRes, cgRes, occRes] = await Promise.all([
      fetch(`/api/contacts/${id}`),
      fetch(`/api/contacts/${id}/groups`),
      fetch(`/api/contacts/${id}/occasions`),
    ]);
    if (!cRes.ok) return;
    const c = await cRes.json();
    const contactGroups = cgRes.ok ? await cgRes.json() : [];
    const occasions = occRes.ok ? await occRes.json() : [];

    _contactGroupIds = new Set(contactGroups.map(g => g.id));
    _inFamilyGroup = contactGroups.some(g => g.name === 'Family');

    document.getElementById('cpNameDisplay').textContent = c.name || 'Unnamed';
    document.getElementById('cpPetIcon').style.display = c.is_pet ? 'inline' : 'none';
    document.getElementById('cpPhBadge').style.display = c.is_placeholder ? 'inline-block' : 'none';
    document.getElementById('cpDeceasedBadge').style.display = c.died_on ? 'inline-block' : 'none';

    document.getElementById('cpFName').value = c.name || '';
    document.getElementById('cpFEmail').value = c.email || '';
    document.getElementById('cpFPhone').value = c.phone || '';
    document.getElementById('cpFBirthday').value = c.birthday ? c.birthday.split('T')[0] : '';
    document.getElementById('cpFDiedOn').value = c.died_on ? c.died_on.split('T')[0] : '';
    document.getElementById('cpFStreet').value = c.street || '';
    document.getElementById('cpFCity').value = c.city || '';
    document.getElementById('cpFCountry').value = c.country || '';
    document.getElementById('cpFPostal').value = c.postal_code || '';
    document.getElementById('cpFIsPet').checked = !!c.is_pet;

    _renderGroupCheckboxes();
    document.getElementById('cpFamilyCard').style.display = _inFamilyGroup ? '' : 'none';
    if (_inFamilyGroup) {
      _renderRelationships(c.relationships || []);
      _populateRelSelects(id);
    }
    _renderOccasions(occasions);
    _renderLoveograms(c.loveograms || []);
  }

  function close() {
    _currentId = null;
    const empty = document.getElementById('cpEmpty');
    const content = document.getElementById('cpContent');
    if (empty) empty.style.display = '';
    if (content) content.style.display = 'none';
  }

  function _allGroupsFlat() {
    const flat = [];
    for (const g of _allGroups) {
      flat.push(g);
      for (const s of (g.subgroups || [])) {
        flat.push(s);
        for (const s2 of (s.subgroups || [])) flat.push(s2);
      }
    }
    return flat;
  }

  function _renderGroupCheckboxes() {
    const el = document.getElementById('cpGroupsCheckboxes');
    if (!_allGroups.length) {
      el.innerHTML = '<span style="font-size:13px;color:rgba(28,10,0,0.35);">No groups yet.</span>';
      return;
    }
    let html = '';
    for (const g of _allGroups) {
      const checked = _contactGroupIds.has(g.id);
      html += `<div>
        <label class="cp-group-row${checked ? ' checked' : ''}" id="cpgcb-${g.id}">
          <input type="checkbox" ${checked ? 'checked' : ''} onchange="CP._toggleGroupMembership(${g.id},this)">
          ${_esc(g.name)}
        </label>`;
      if (g.subgroups && g.subgroups.length) {
        html += '<div class="cp-group-children">';
        for (const s of g.subgroups) {
          const sc = _contactGroupIds.has(s.id);
          html += `<label class="cp-group-row cp-group-sub${sc ? ' checked' : ''}" id="cpgcb-${s.id}">
            <input type="checkbox" ${sc ? 'checked' : ''} onchange="CP._toggleGroupMembership(${s.id},this)">
            ↳ ${_esc(s.name)}
          </label>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }
    el.innerHTML = html;
  }

  async function _toggleGroupMembership(groupId, cb) {
    const label = document.getElementById(`cpgcb-${groupId}`);
    if (cb.checked) _contactGroupIds.add(groupId);
    else _contactGroupIds.delete(groupId);
    if (label) label.classList.toggle('checked', cb.checked);

    const familyGroup = _allGroupsFlat().find(g => g.name === 'Family');
    const nowInFamily = familyGroup ? _contactGroupIds.has(familyGroup.id) : false;
    if (nowInFamily !== _inFamilyGroup) {
      _inFamilyGroup = nowInFamily;
      document.getElementById('cpFamilyCard').style.display = _inFamilyGroup ? '' : 'none';
      if (_inFamilyGroup) _populateRelSelects(_currentId);
    }

    await fetch(`/api/contacts/${_currentId}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_ids: [..._contactGroupIds] }),
    });
  }

  async function _saveContact() {
    const btn = document.getElementById('cpBtnSave');
    const msg = document.getElementById('cpSaveMsg');
    btn.disabled = true;
    const body = {
      name: document.getElementById('cpFName').value,
      email: document.getElementById('cpFEmail').value,
      phone: document.getElementById('cpFPhone').value,
      street: document.getElementById('cpFStreet').value,
      city: document.getElementById('cpFCity').value,
      country: document.getElementById('cpFCountry').value,
      postal_code: document.getElementById('cpFPostal').value,
      birthday: document.getElementById('cpFBirthday').value,
      died_on: document.getElementById('cpFDiedOn').value,
      is_pet: document.getElementById('cpFIsPet').checked,
    };
    try {
      const res = await fetch(`/api/contacts/${_currentId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.ok) {
        msg.className = 'cp-save-msg ok'; msg.textContent = 'Saved.';
        document.getElementById('cpNameDisplay').textContent = body.name || 'Unnamed';
        document.getElementById('cpPetIcon').style.display = body.is_pet ? 'inline' : 'none';
        document.getElementById('cpDeceasedBadge').style.display = body.died_on ? 'inline-block' : 'none';
        if (typeof CP.onSaved === 'function') CP.onSaved({ id: _currentId, ...body });
        setTimeout(() => { msg.textContent = ''; }, 2500);
      } else {
        const d = await res.json();
        msg.className = 'cp-save-msg err'; msg.textContent = d.error || 'Failed to save.';
      }
    } catch { msg.className = 'cp-save-msg err'; msg.textContent = 'Network error.'; }
    btn.disabled = false;
  }

  function _renderRelationships(rels) {
    const tbody = document.getElementById('cpRelBody');
    if (!rels.length) { tbody.innerHTML = '<tr class="cp-empty-row"><td colspan="3">No family relationships yet.</td></tr>'; return; }
    tbody.innerHTML = rels.map(r => `<tr>
      <td>${_esc(r.related_name || 'Unknown')}</td>
      <td>${_esc(r.relationship_name)}</td>
      <td><button class="cp-btn-del" onclick="CP._deleteRelationship(${r.id})">Remove</button></td>
    </tr>`).join('');
  }

  async function _deleteRelationship(id) {
    await fetch(`/api/contact-relationships/${id}`, { method: 'DELETE' });
    open(_currentId);
  }

  async function _addRelationship() {
    const contactId = document.getElementById('cpRelContact').value;
    const typeId = document.getElementById('cpRelType').value;
    const msg = document.getElementById('cpRelMsg');
    if (!contactId || !typeId) { msg.className = 'cp-form-msg err'; msg.textContent = 'Select both a person and a relationship type.'; return; }
    msg.textContent = '';
    const res = await fetch('/api/contact-relationships', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_a_id: _currentId, contact_b_id: +contactId, relationship_type_id: +typeId }),
    });
    if (res.ok) {
      document.getElementById('cpRelContact').value = '';
      document.getElementById('cpRelType').value = '';
      open(_currentId);
    } else { const d = await res.json(); msg.className = 'cp-form-msg err'; msg.textContent = d.error || 'Failed.'; }
  }

  function _populateRelSelects(currentId) {
    const sel = document.getElementById('cpRelContact');
    sel.innerHTML = '<option value="">— Select person —</option>' +
      _contacts.filter(c => c.id !== currentId).map(c => `<option value="${c.id}">${_esc(c.name || 'Unnamed')}</option>`).join('');
    const familyTypes = _relTypes.filter(t => t.group_name === 'Family');
    const tsel = document.getElementById('cpRelType');
    tsel.innerHTML = familyTypes.length
      ? '<option value="">— Relationship —</option>' + familyTypes.map(t => `<option value="${t.id}">${_esc(t.name)}</option>`).join('')
      : '<option value="">— No types —</option>';
  }

  function _renderOccasions(occs) {
    const tbody = document.getElementById('cpOccBody');
    if (!occs.length) { tbody.innerHTML = '<tr class="cp-empty-row"><td colspan="4">No occasions yet.</td></tr>'; return; }
    tbody.innerHTML = occs.map(o => `<tr>
      <td>${_esc(o.name)}</td><td>${_esc((o.start_date || '').split('T')[0])}</td>
      <td>${_esc(o.frequency)}</td>
      <td><button class="cp-btn-del" onclick="CP._deleteOccasion(${o.id})">Remove</button></td>
    </tr>`).join('');
  }

  async function _addOccasion() {
    const name = document.getElementById('cpOccName').value.trim();
    const date = document.getElementById('cpOccDate').value;
    const freq = document.getElementById('cpOccFreq').value;
    const msg = document.getElementById('cpOccMsg');
    if (!name || !date) { msg.className = 'cp-form-msg err'; msg.textContent = 'Name and date are required.'; return; }
    msg.textContent = '';
    const res = await fetch(`/api/contacts/${_currentId}/occasions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, start_date: date, frequency: freq }),
    });
    if (res.ok) {
      document.getElementById('cpOccName').value = '';
      document.getElementById('cpOccDate').value = '';
      const newOccs = await (await fetch(`/api/contacts/${_currentId}/occasions`)).json();
      _renderOccasions(newOccs);
    } else { const d = await res.json(); msg.className = 'cp-form-msg err'; msg.textContent = d.error || 'Failed.'; }
  }

  async function _deleteOccasion(id) {
    await fetch(`/api/occasions/${id}`, { method: 'DELETE' });
    const newOccs = await (await fetch(`/api/contacts/${_currentId}/occasions`)).json();
    _renderOccasions(newOccs);
  }

  function _renderLoveograms(lovs) {
    const tbody = document.getElementById('cpLovBody');
    if (!lovs.length) { tbody.innerHTML = '<tr class="cp-empty-row"><td colspan="4">No Loveograms sent yet.</td></tr>'; return; }
    tbody.innerHTML = lovs.map(o => {
      const dotCls = (o.status === 'paid' || o.status === 'delivered') ? 'done' : o.status === 'failed' ? 'failed' : 'pending';
      const date = new Date(o.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return `<tr><td>${date}</td><td>${_esc(o.product)}</td><td>$${parseFloat(o.amount).toFixed(2)}</td><td><span class="cp-dot ${dotCls}"></span>${_esc(o.status)}</td></tr>`;
    }).join('');
  }

  return {
    init,
    open,
    close,
    get currentId() { return _currentId; },
    set contacts(v) { _contacts = v; },
    set allGroups(v) { _allGroups = v; },
    set relTypes(v) { _relTypes = v; },
    onSaved: null,
    _saveContact,
    _toggleGroupMembership,
    _addRelationship,
    _deleteRelationship,
    _addOccasion,
    _deleteOccasion,
  };
})();
