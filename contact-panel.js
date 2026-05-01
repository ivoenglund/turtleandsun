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
  let _saveTimer = null;

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _injectCSS() {
    if (document.getElementById('cp-styles')) return;
    const s = document.createElement('style');
    s.id = 'cp-styles';
    s.textContent = `
.cp-empty{display:flex;align-items:center;justify-content:center;height:160px;font-size:13px;color:rgba(28,10,0,0.25);font-family:'Plus Jakarta Sans',sans-serif;font-weight:500;text-align:center;padding:24px;}

/* Name bar */
.cp-name-bar{padding:11px 16px 9px;font-family:'Plus Jakarta Sans',sans-serif;font-size:14px;font-weight:700;color:#1C0A00;display:flex;align-items:center;gap:7px;flex-wrap:wrap;border-bottom:1px solid rgba(28,10,0,0.06);}
.cp-badge{display:inline-block;padding:1px 7px;border-radius:8px;font-size:10px;font-weight:700;background:#f0ede6;color:rgba(28,10,0,0.45);}
.cp-badge-dec{background:#f5eaea;color:rgba(120,20,20,0.55);}

/* Sections */
.cp-section{border-bottom:1px solid rgba(28,10,0,0.06);}
.cp-section:last-child{border-bottom:none;}
.cp-section-hdr{padding:8px 16px 3px;font-family:'Plus Jakarta Sans',sans-serif;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(28,10,0,0.28);}

/* Two-column field table */
.cp-tbl{padding-bottom:4px;}
.cp-row{display:flex;align-items:stretch;border-bottom:1px solid rgba(28,10,0,0.04);}
.cp-row:last-child{border-bottom:none;}
.cp-lbl{width:108px;flex-shrink:0;padding:5px 10px 5px 16px;font-size:11px;font-weight:500;color:rgba(28,10,0,0.38);text-align:right;display:flex;align-items:center;justify-content:flex-end;line-height:1.3;}
.cp-inp{flex:1;padding:5px 9px;border:none;border-left:1px solid rgba(28,10,0,0.06);background:transparent;font-size:13px;font-family:'DM Sans',sans-serif;color:#1C0A00;outline:none;min-width:0;transition:background 0.12s;}
.cp-inp:focus{background:rgba(58,107,32,0.045);border-left-color:#3A6B20;}
.cp-inp:hover:not(:focus){background:rgba(28,10,0,0.02);}
.cp-check-cell{flex:1;padding:5px 9px;border-left:1px solid rgba(28,10,0,0.06);display:flex;align-items:center;}
.cp-check-cell label{display:flex;align-items:center;gap:7px;font-size:12px;color:rgba(28,10,0,0.7);cursor:pointer;}
.cp-check-cell input[type=checkbox]{width:13px;height:13px;accent-color:#3A6B20;cursor:pointer;flex-shrink:0;}

/* Save toast */
.cp-toast{margin:6px 16px 2px;padding:4px 10px;border-radius:5px;font-size:11px;font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;text-align:center;display:none;}
.cp-toast.ok{background:#e8f0e0;color:#2d5a16;display:block;}
.cp-toast.err{background:#fdecea;color:#c0392b;display:block;}

/* Group pills */
.cp-pills{display:flex;flex-wrap:wrap;gap:4px;padding:6px 16px 10px;}
.cp-pill{display:flex;align-items:center;gap:5px;padding:3px 9px;border-radius:20px;font-family:'Plus Jakarta Sans',sans-serif;font-size:11px;font-weight:600;cursor:pointer;user-select:none;border:1px solid rgba(28,10,0,0.11);color:rgba(28,10,0,0.45);background:#faf8f5;transition:all 0.12s;}
.cp-pill:hover{border-color:rgba(28,10,0,0.2);color:rgba(28,10,0,0.7);}
.cp-pill.active{background:#e8f0e0;border-color:#3A6B20;color:#2d5a16;}
.cp-pill input[type=checkbox]{width:12px;height:12px;accent-color:#3A6B20;cursor:pointer;}
.cp-pill-sub{font-size:10px;padding:2px 8px;}
.cp-pills-empty{padding:6px 16px 10px;font-size:12px;color:rgba(28,10,0,0.3);}

/* Compact list rows (rels, occasions, loveograms) */
.cp-list{padding:2px 16px 6px;}
.cp-list-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(28,10,0,0.04);font-size:12px;}
.cp-list-row:last-child{border-bottom:none;}
.cp-list-primary{flex:1;font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;color:#1C0A00;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cp-list-secondary{color:rgba(28,10,0,0.42);font-size:11px;white-space:nowrap;}
.cp-list-tag{font-size:10px;padding:1px 6px;border-radius:8px;background:#f0ede6;color:rgba(28,10,0,0.45);white-space:nowrap;}
.cp-list-empty{padding:8px 16px 10px;font-size:12px;color:rgba(28,10,0,0.28);font-style:italic;}

/* Status tags */
.cp-status-done{background:#c8e6c9;color:#1b5e20;}
.cp-status-pending{background:#fff3cd;color:#856404;}
.cp-status-failed{background:#fdecea;color:#c0392b;}

/* Compact add forms */
.cp-add-row{display:flex;gap:5px;padding:4px 16px 8px;flex-wrap:wrap;}
.cp-add-inp{flex:1;min-width:80px;padding:4px 7px;border:1px solid #e0dcd4;border-radius:5px;font-size:12px;font-family:'DM Sans',sans-serif;color:#1C0A00;background:#fff;outline:none;}
.cp-add-inp:focus{border-color:#3A6B20;}
.cp-add-sel{flex:1;min-width:90px;padding:4px 7px;border:1px solid #e0dcd4;border-radius:5px;font-size:12px;font-family:'DM Sans',sans-serif;color:#1C0A00;background:#fff;outline:none;}
.cp-add-sel:focus{border-color:#3A6B20;}
.cp-btn-add{padding:4px 11px;background:#3A6B20;color:#fff;border:none;border-radius:5px;font-family:'Plus Jakarta Sans',sans-serif;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;}
.cp-btn-add:hover{background:#1C0A00;}
.cp-btn-del{padding:2px 7px;background:none;border:1px solid rgba(28,10,0,0.13);border-radius:4px;font-size:10px;cursor:pointer;color:rgba(28,10,0,0.38);font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;flex-shrink:0;}
.cp-btn-del:hover{border-color:#c0392b;color:#c0392b;}
.cp-form-msg{font-size:11px;padding:0 16px 4px;min-height:14px;color:#c0392b;}

@media(max-width:1000px){.cp-lbl{width:86px;font-size:10px;}}
    `;
    document.head.appendChild(s);
  }

  const _HTML = `
<div class="cp-empty" id="cpEmpty">Select a contact to see details.</div>
<div id="cpContent" style="display:none;overflow-y:auto;flex:1;">

  <div class="cp-name-bar">
    <span id="cpNameDisplay"></span>
    <span id="cpPetIcon" style="display:none;">🐾</span>
    <span class="cp-badge" id="cpPhBadge" style="display:none;">Manual</span>
    <span class="cp-badge cp-badge-dec" id="cpDeceasedBadge" style="display:none;">† Deceased</span>
  </div>

  <div class="cp-toast" id="cpSaveMsg"></div>

  <div class="cp-section">
    <div class="cp-section-hdr">Personal</div>
    <div class="cp-tbl">
      <div class="cp-row"><span class="cp-lbl">Name</span><input class="cp-inp" type="text" id="cpFName" data-field="name" onblur="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">Email</span><input class="cp-inp" type="email" id="cpFEmail" data-field="email" onblur="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">Phone</span><input class="cp-inp" type="tel" id="cpFPhone" data-field="phone" onblur="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">Birthday</span><input class="cp-inp" type="date" id="cpFBirthday" data-field="birthday" onchange="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">Died on</span><input class="cp-inp" type="date" id="cpFDiedOn" data-field="died_on" onchange="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">Pet</span><div class="cp-check-cell"><label><input type="checkbox" id="cpFIsPet" onchange="CP._scheduleSave()"> This is a pet</label></div></div>
    </div>
  </div>

  <div class="cp-section">
    <div class="cp-section-hdr">Address</div>
    <div class="cp-tbl">
      <div class="cp-row"><span class="cp-lbl">Street</span><input class="cp-inp" type="text" id="cpFStreet" data-field="street" onblur="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">City</span><input class="cp-inp" type="text" id="cpFCity" data-field="city" onblur="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">Country</span><input class="cp-inp" type="text" id="cpFCountry" data-field="country" onblur="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">Postal code</span><input class="cp-inp" type="text" id="cpFPostal" data-field="postal_code" onblur="CP._scheduleSave()"></div>
    </div>
  </div>

  <div class="cp-section">
    <div class="cp-section-hdr">Groups</div>
    <div id="cpGroupsCheckboxes"></div>
  </div>

  <div class="cp-section" id="cpFamilyCard" style="display:none;">
    <div class="cp-section-hdr">Family relationships</div>
    <div id="cpRelBody"></div>
    <div class="cp-add-row">
      <select class="cp-add-sel" id="cpRelContact"><option value="">— person —</option></select>
      <select class="cp-add-sel" id="cpRelType"><option value="">— relationship —</option></select>
      <button class="cp-btn-add" onclick="CP._addRelationship()">Add</button>
    </div>
    <div class="cp-form-msg" id="cpRelMsg"></div>
  </div>

  <div class="cp-section">
    <div class="cp-section-hdr">Occasions</div>
    <div id="cpOccBody"></div>
    <div class="cp-add-row">
      <input class="cp-add-inp" type="text" id="cpOccName" placeholder="Occasion name">
      <input class="cp-add-inp" type="date" id="cpOccDate" style="max-width:130px;">
      <select class="cp-add-sel" id="cpOccFreq" style="max-width:90px;">
        <option value="yearly">Yearly</option>
        <option value="milestone">Milestone</option>
        <option value="one-time">One-time</option>
      </select>
      <button class="cp-btn-add" onclick="CP._addOccasion()">Add</button>
    </div>
    <div class="cp-form-msg" id="cpOccMsg"></div>
  </div>

  <div class="cp-section">
    <div class="cp-section-hdr">Loveogram history</div>
    <div id="cpLovBody"></div>
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
    clearTimeout(_saveTimer);
    document.getElementById('cpEmpty').style.display = 'none';
    document.getElementById('cpContent').style.display = 'block';
    _hideToast();

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
    clearTimeout(_saveTimer);
    const empty = document.getElementById('cpEmpty');
    const content = document.getElementById('cpContent');
    if (empty) empty.style.display = '';
    if (content) content.style.display = 'none';
  }

  function _hideToast() {
    const t = document.getElementById('cpSaveMsg');
    if (t) { t.className = 'cp-toast'; t.textContent = ''; }
  }

  function _showToast(msg, isOk) {
    const t = document.getElementById('cpSaveMsg');
    if (!t) return;
    t.className = 'cp-toast ' + (isOk ? 'ok' : 'err');
    t.textContent = msg;
    if (isOk) setTimeout(_hideToast, 1800);
  }

  function _scheduleSave() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_doSave, 500);
  }

  async function _doSave() {
    if (!_currentId) return;
    const body = {
      name: document.getElementById('cpFName').value,
      email: document.getElementById('cpFEmail').value,
      phone: document.getElementById('cpFPhone').value,
      street: document.getElementById('cpFStreet').value,
      city: document.getElementById('cpFCity').value,
      country: document.getElementById('cpFCountry').value,
      postal_code: document.getElementById('cpFPostal').value,
      birthday: document.getElementById('cpFBirthday').value || null,
      died_on: document.getElementById('cpFDiedOn').value || null,
      is_pet: document.getElementById('cpFIsPet').checked,
    };
    try {
      const res = await fetch(`/api/contacts/${_currentId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.ok) {
        _showToast('Saved', true);
        document.getElementById('cpNameDisplay').textContent = body.name || 'Unnamed';
        document.getElementById('cpPetIcon').style.display = body.is_pet ? 'inline' : 'none';
        document.getElementById('cpDeceasedBadge').style.display = body.died_on ? 'inline-block' : 'none';
        if (typeof CP.onSaved === 'function') CP.onSaved({ id: _currentId, ...body });
      } else {
        const d = await res.json();
        _showToast(d.error || 'Failed to save', false);
      }
    } catch { _showToast('Network error', false); }
  }

  // Keep as public alias for backward compat
  function _saveContact() { return _doSave(); }

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
      el.innerHTML = '<div class="cp-pills-empty">No groups yet.</div>';
      return;
    }
    let html = '<div class="cp-pills">';
    for (const g of _allGroups) {
      const checked = _contactGroupIds.has(g.id);
      html += `<label class="cp-pill${checked ? ' active' : ''}" id="cpgcb-${g.id}">
        <input type="checkbox" ${checked ? 'checked' : ''} onchange="CP._toggleGroupMembership(${g.id},this)">
        ${_esc(g.name)}
      </label>`;
      for (const s of (g.subgroups || [])) {
        const sc = _contactGroupIds.has(s.id);
        html += `<label class="cp-pill cp-pill-sub${sc ? ' active' : ''}" id="cpgcb-${s.id}">
          <input type="checkbox" ${sc ? 'checked' : ''} onchange="CP._toggleGroupMembership(${s.id},this)">
          ↳ ${_esc(s.name)}
        </label>`;
      }
    }
    html += '</div>';
    el.innerHTML = html;
  }

  async function _toggleGroupMembership(groupId, cb) {
    const label = document.getElementById(`cpgcb-${groupId}`);
    if (cb.checked) _contactGroupIds.add(groupId);
    else _contactGroupIds.delete(groupId);
    if (label) label.classList.toggle('active', cb.checked);

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

  function _renderRelationships(rels) {
    const el = document.getElementById('cpRelBody');
    if (!rels.length) {
      el.innerHTML = '<div class="cp-list-empty">No family relationships yet.</div>';
      return;
    }
    el.innerHTML = '<div class="cp-list">' + rels.map(r => `
      <div class="cp-list-row">
        <span class="cp-list-primary">${_esc(r.related_name || 'Unknown')}</span>
        <span class="cp-list-secondary">${_esc(r.relationship_name)}</span>
        <button class="cp-btn-del" onclick="CP._deleteRelationship(${r.id})">Remove</button>
      </div>`).join('') + '</div>';
  }

  async function _deleteRelationship(id) {
    await fetch(`/api/contact-relationships/${id}`, { method: 'DELETE' });
    open(_currentId);
  }

  async function _addRelationship() {
    const contactId = document.getElementById('cpRelContact').value;
    const typeId = document.getElementById('cpRelType').value;
    const msg = document.getElementById('cpRelMsg');
    if (!contactId || !typeId) { msg.textContent = 'Select both a person and a relationship type.'; return; }
    msg.textContent = '';
    const res = await fetch('/api/contact-relationships', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_a_id: _currentId, contact_b_id: +contactId, relationship_type_id: +typeId }),
    });
    if (res.ok) {
      document.getElementById('cpRelContact').value = '';
      document.getElementById('cpRelType').value = '';
      open(_currentId);
    } else { const d = await res.json(); msg.textContent = d.error || 'Failed.'; }
  }

  function _populateRelSelects(currentId) {
    const sel = document.getElementById('cpRelContact');
    sel.innerHTML = '<option value="">— person —</option>' +
      _contacts.filter(c => c.id !== currentId).map(c => `<option value="${c.id}">${_esc(c.name || 'Unnamed')}</option>`).join('');
    const familyTypes = _relTypes.filter(t => t.group_name === 'Family');
    const tsel = document.getElementById('cpRelType');
    tsel.innerHTML = familyTypes.length
      ? '<option value="">— relationship —</option>' + familyTypes.map(t => `<option value="${t.id}">${_esc(t.name)}</option>`).join('')
      : '<option value="">— no types —</option>';
  }

  function _renderOccasions(occs) {
    const el = document.getElementById('cpOccBody');
    if (!occs.length) {
      el.innerHTML = '<div class="cp-list-empty">No occasions yet.</div>';
      return;
    }
    el.innerHTML = '<div class="cp-list">' + occs.map(o => {
      const d = (o.start_date || '').split('T')[0];
      const [y, m, day] = d.split('-');
      const dateStr = d ? new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '—';
      return `<div class="cp-list-row">
        <span class="cp-list-primary">${_esc(o.name)}</span>
        <span class="cp-list-secondary">${dateStr}</span>
        <span class="cp-list-tag">${_esc(o.frequency)}</span>
        <button class="cp-btn-del" onclick="CP._deleteOccasion(${o.id})">Remove</button>
      </div>`;
    }).join('') + '</div>';
  }

  async function _addOccasion() {
    const name = document.getElementById('cpOccName').value.trim();
    const date = document.getElementById('cpOccDate').value;
    const freq = document.getElementById('cpOccFreq').value;
    const msg = document.getElementById('cpOccMsg');
    if (!name || !date) { msg.textContent = 'Name and date are required.'; return; }
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
    } else { const d = await res.json(); msg.textContent = d.error || 'Failed.'; }
  }

  async function _deleteOccasion(id) {
    await fetch(`/api/occasions/${id}`, { method: 'DELETE' });
    const newOccs = await (await fetch(`/api/contacts/${_currentId}/occasions`)).json();
    _renderOccasions(newOccs);
  }

  function _renderLoveograms(lovs) {
    const el = document.getElementById('cpLovBody');
    if (!lovs.length) {
      el.innerHTML = '<div class="cp-list-empty">No Loveograms sent yet.</div>';
      return;
    }
    el.innerHTML = '<div class="cp-list">' + lovs.map(o => {
      const cls = (o.status === 'paid' || o.status === 'delivered') ? 'done' : o.status === 'failed' ? 'failed' : 'pending';
      const date = new Date(o.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
      return `<div class="cp-list-row">
        <span class="cp-list-secondary" style="width:80px;flex-shrink:0;">${date}</span>
        <span class="cp-list-primary">${_esc(o.product)}</span>
        <span class="cp-list-secondary">$${parseFloat(o.amount).toFixed(2)}</span>
        <span class="cp-list-tag cp-status-${cls}">${_esc(o.status)}</span>
      </div>`;
    }).join('') + '</div>';
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
    _scheduleSave,
    _toggleGroupMembership,
    _addRelationship,
    _deleteRelationship,
    _addOccasion,
    _deleteOccasion,
  };
})();
