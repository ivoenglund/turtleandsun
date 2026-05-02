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
.cp-name-bar{padding:5px 14px 4px;display:flex;flex-direction:column;gap:1px;border-bottom:1px solid rgba(28,10,0,0.06);}
.cp-name-lbl{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:rgba(28,10,0,0.32);font-family:'Plus Jakarta Sans',sans-serif;}
.cp-name-row{display:flex;align-items:center;gap:7px;flex-wrap:nowrap;}
.cp-name-inp{flex:1;min-width:0;font-family:'Plus Jakarta Sans',sans-serif;font-size:14px;font-weight:800;color:#1C0A00;background:transparent;border:none;border-bottom:1.5px solid transparent;outline:none;padding:0;line-height:1.2;transition:border-color 0.12s;cursor:text;}
.cp-name-inp:focus{border-bottom-color:#3A6B20;}
.cp-name-inp::placeholder{color:rgba(28,10,0,0.28);}
.cp-close-btn{margin-left:auto;border:none;background:none;cursor:pointer;font-size:16px;color:rgba(28,10,0,0.35);line-height:1;padding:0;flex-shrink:0;display:flex;align-items:center;}
.cp-close-btn:hover{color:#1C0A00;}
.cp-badge{display:inline-block;padding:1px 7px;border-radius:8px;font-size:10px;font-weight:700;background:#f0ede6;color:rgba(28,10,0,0.45);}
.cp-badge-dec{background:#f5eaea;color:rgba(120,20,20,0.55);}

/* Sections */
.cp-section{border-bottom:1px solid rgba(28,10,0,0.06);}
.cp-section:last-child{border-bottom:none;}
.cp-section-hdr{padding:8px 16px 3px;font-family:'Plus Jakarta Sans',sans-serif;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(28,10,0,0.28);}

/* Stacked field layout — maximum vertical compactness */
.cp-tbl{padding-bottom:3px;}
.cp-row{display:flex;flex-direction:column;padding:1px 14px 1px;}
.cp-lbl{font-size:10px;font-weight:500;color:rgba(28,10,0,0.35);text-align:left;line-height:1.2;margin-bottom:0;}
.cp-inp{width:100%;padding:0 0 2px;border:none;border-bottom:1px solid rgba(28,10,0,0.08);background:transparent;font-size:12px;font-family:'DM Sans',sans-serif;color:#1C0A00;outline:none;line-height:1.2;transition:background 0.12s;}
.cp-inp:focus{background:rgba(58,107,32,0.04);border-bottom-color:#3A6B20;}
.cp-inp:hover:not(:focus){background:rgba(28,10,0,0.02);}
.cp-check-cell{padding:0;border:none;display:flex;align-items:center;}
.cp-check-cell label{display:flex;align-items:center;gap:7px;font-size:11px;color:rgba(28,10,0,0.7);cursor:pointer;}
.cp-check-cell input[type=checkbox]{width:12px;height:12px;accent-color:#3A6B20;cursor:pointer;flex-shrink:0;}

/* Save toast */
.cp-toast{margin:2px 14px 1px;padding:2px 8px;border-radius:4px;font-size:11px;font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;text-align:center;display:none;}
.cp-toast.ok{background:#e8f0e0;color:#2d5a16;display:block;}
.cp-toast.err{background:#fdecea;color:#c0392b;display:block;}

/* Group pills */
.cp-pills{display:flex;flex-wrap:wrap;gap:3px;padding:3px 14px 4px;}
.cp-pill{display:flex;align-items:center;gap:4px;padding:1px 7px;border-radius:20px;font-family:'Plus Jakarta Sans',sans-serif;font-size:10px;font-weight:600;cursor:pointer;user-select:none;border:1px solid rgba(28,10,0,0.11);color:rgba(28,10,0,0.45);background:#faf8f5;transition:all 0.12s;}
.cp-pill:hover{border-color:rgba(28,10,0,0.2);color:rgba(28,10,0,0.7);}
.cp-pill.active{background:#e8f0e0;border-color:#3A6B20;color:#2d5a16;}
.cp-pill input[type=checkbox]{width:11px;height:11px;accent-color:#3A6B20;cursor:pointer;}
.cp-pill-sub{font-size:9px;padding:1px 6px;}
.cp-pills-empty{padding:3px 14px 4px;font-size:11px;color:rgba(28,10,0,0.3);}
.cp-group-add-btn{display:flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1.5px dashed rgba(28,10,0,0.25);background:none;cursor:pointer;font-size:13px;line-height:1;color:rgba(28,10,0,0.4);flex-shrink:0;padding:0;}
.cp-group-add-btn:hover{border-color:rgba(28,10,0,0.5);color:rgba(28,10,0,0.7);}
.cp-pill-remove{border:none;background:none;cursor:pointer;font-size:11px;line-height:1;color:rgba(28,10,0,0.35);padding:0 0 0 2px;flex-shrink:0;}
.cp-pill-remove:hover{color:#c0392b;}
.cp-group-dropdown{padding:2px 12px 4px;}
.cp-group-dd-item{display:flex;align-items:center;gap:6px;padding:2px 0;font-size:11px;font-family:'DM Sans',sans-serif;color:rgba(28,10,0,0.7);cursor:pointer;line-height:1.3;}
.cp-group-dd-item input[type=checkbox]{width:12px;height:12px;accent-color:#3A6B20;cursor:pointer;flex-shrink:0;}
.cp-group-dd-sub{padding-left:10px;font-size:10px;color:rgba(28,10,0,0.5);}

/* Compact list rows (rels, occasions, loveograms) */
.cp-list{padding:1px 14px 3px;}
.cp-list-row{display:flex;align-items:center;gap:6px;padding:2px 0;border-bottom:1px solid rgba(28,10,0,0.04);font-size:11px;}
.cp-list-row:last-child{border-bottom:none;}
.cp-list-primary{flex:1;font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;color:#1C0A00;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cp-list-secondary{color:rgba(28,10,0,0.42);font-size:10px;white-space:nowrap;}
.cp-list-tag{font-size:9px;padding:1px 5px;border-radius:6px;background:#f0ede6;color:rgba(28,10,0,0.45);white-space:nowrap;}
.cp-list-empty{padding:3px 14px 4px;font-size:11px;color:rgba(28,10,0,0.28);font-style:italic;}

/* Status tags */
.cp-status-done{background:#c8e6c9;color:#1b5e20;}
.cp-status-pending{background:#fff3cd;color:#856404;}
.cp-status-failed{background:#fdecea;color:#c0392b;}

/* Compact add forms */
.cp-add-row{display:flex;gap:4px;padding:2px 14px 4px;flex-wrap:wrap;}
.cp-add-inp{flex:1;min-width:80px;padding:2px 6px;border:1px solid #e0dcd4;border-radius:4px;font-size:11px;font-family:'DM Sans',sans-serif;color:#1C0A00;background:#fff;outline:none;line-height:1.2;}
.cp-add-inp:focus{border-color:#3A6B20;}
.cp-add-sel{flex:1;min-width:90px;padding:2px 6px;border:1px solid #e0dcd4;border-radius:4px;font-size:11px;font-family:'DM Sans',sans-serif;color:#1C0A00;background:#fff;outline:none;line-height:1.2;}
.cp-add-sel:focus{border-color:#3A6B20;}
.cp-btn-add{padding:2px 9px;background:#3A6B20;color:#fff;border:none;border-radius:4px;font-family:'Plus Jakarta Sans',sans-serif;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;line-height:1.5;}
.cp-btn-add:hover{background:#1C0A00;}
.cp-btn-del{padding:1px 6px;background:none;border:1px solid rgba(28,10,0,0.13);border-radius:3px;font-size:9px;cursor:pointer;color:rgba(28,10,0,0.38);font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;flex-shrink:0;}
.cp-btn-del:hover{border-color:#c0392b;color:#c0392b;}
.cp-form-msg{font-size:10px;padding:0 14px 2px;min-height:12px;color:#c0392b;}

@media(max-width:1000px){.cp-lbl{font-size:10px;}}

/* Suppress browser autofill/contact icons in all inputs */
input::-webkit-contacts-auto-fill-button,
input::-webkit-credentials-auto-fill-button{display:none!important;width:0!important;height:0!important;}

/* Overlay: hard-cap all children to panel width */
.fo-detail *{max-width:100%;box-sizing:border-box;}
.fo-detail .cp-add-inp,.fo-detail .cp-add-sel{min-width:0;}
.fo-detail .cp-list-primary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fo-detail .cp-pills{overflow:hidden;}

/* Overlay mode: transparent bg, text-shadow for legibility */
.fo-detail .cp-name-lbl{text-shadow:0 0 8px rgba(255,249,230,1),0 0 4px rgba(255,249,230,0.8);}
.fo-detail .cp-name-inp{text-shadow:0 0 8px rgba(255,249,230,0.95);color:#1C0A00;}
.fo-detail .cp-close-btn{text-shadow:0 0 8px rgba(255,249,230,1);}
.fo-detail .cp-name-bar{border-bottom:none;}
.fo-detail .cp-group-add-btn{color:rgba(28,10,0,0.45);text-shadow:0 0 8px rgba(255,249,230,1);}
.fo-detail .cp-group-dropdown{background:rgba(255,249,230,0.93);border-radius:6px;margin:0 8px 4px;}
.fo-detail .cp-group-dd-item{text-shadow:0 0 6px rgba(255,249,230,0.8);}
.fo-detail .cp-section{border-bottom:none;}
.fo-detail .cp-row{border-bottom:none;}
.fo-detail .cp-list-row{border-bottom:none;}
.fo-detail .cp-lbl{text-shadow:0 0 8px rgba(255,249,230,1),0 0 4px rgba(255,249,230,0.8);}
.fo-detail .cp-section-hdr{text-shadow:0 0 8px rgba(255,249,230,1);}
.fo-detail .cp-inp{background:transparent!important;border-bottom-color:transparent;}
.fo-detail .cp-inp:focus{background:rgba(255,249,230,0.75)!important;border-bottom-color:#3A6B20;}
.fo-detail .cp-list-primary{text-shadow:0 0 6px rgba(255,249,230,0.8);}
.fo-detail .cp-list-secondary{text-shadow:0 0 6px rgba(255,249,230,0.8);}
.fo-detail .cp-badge{background:rgba(240,237,230,0.75);}
.fo-detail .cp-badge-dec{background:rgba(245,234,234,0.75);}
.fo-detail .cp-toast.ok{background:rgba(232,240,224,0.88);}
.fo-detail .cp-toast.err{background:rgba(253,236,234,0.88);}
.fo-detail .cp-pill{background:rgba(250,248,245,0.75);}
.fo-detail .cp-pill.active{background:rgba(232,240,224,0.88);}
.fo-detail .cp-name-bar,.fo-detail .cp-name-row,.fo-detail .cp-section,.fo-detail .cp-tbl,.fo-detail .cp-row,.fo-detail .cp-pills,.fo-detail .cp-list,.fo-detail .cp-list-row,.fo-detail .cp-add-row,.fo-detail .cp-form-msg,.fo-detail .cp-toast,.fo-detail .cp-empty,.fo-detail .cp-group-dropdown{max-width:100%;box-sizing:border-box;}
.fo-detail .cp-pill{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    `;
    document.head.appendChild(s);
  }

  const _HTML = `
<div class="cp-empty" id="cpEmpty">Select a contact to see details.</div>
<div id="cpContent" style="display:none;overflow-y:auto;flex:1;min-height:0;">

  <div class="cp-name-bar">
    <span class="cp-name-lbl">Contact name</span>
    <div class="cp-name-row">
      <input class="cp-name-inp" id="cpFName" type="text" data-field="name" onblur="CP._scheduleSave()" placeholder="Name">
      <span id="cpPetIcon" style="display:none;">🐾</span>
      <span class="cp-badge" id="cpPhBadge" style="display:none;">Manual</span>
      <span class="cp-badge cp-badge-dec" id="cpDeceasedBadge" style="display:none;">† Deceased</span>
      <button class="cp-close-btn" onclick="window.hideDetail&&hideDetail()" aria-label="Close">×</button>
    </div>
  </div>

  <div class="cp-toast" id="cpSaveMsg"></div>

  <div class="cp-section">
    <div class="cp-tbl">
      <div class="cp-row"><span class="cp-lbl">Email</span><input class="cp-inp" type="text" inputmode="email" autocomplete="email" id="cpFEmail" data-field="email" onblur="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">Phone</span><input class="cp-inp" type="tel" id="cpFPhone" data-field="phone" onblur="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">Birthday</span><input class="cp-inp" type="date" id="cpFBirthday" data-field="birthday" onchange="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">Died on</span><input class="cp-inp" type="date" id="cpFDiedOn" data-field="died_on" onchange="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">Pet</span><div class="cp-check-cell"><input type="checkbox" id="cpFIsPet" onchange="CP._scheduleSave()"></div></div>
    </div>
  </div>

  <div class="cp-section">
    <div class="cp-tbl">
      <div class="cp-row"><span class="cp-lbl">Street</span><input class="cp-inp" type="text" id="cpFStreet" data-field="street" onblur="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">City</span><input class="cp-inp" type="text" id="cpFCity" data-field="city" onblur="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">Country</span><input class="cp-inp" type="text" id="cpFCountry" data-field="country" onblur="CP._scheduleSave()"></div>
      <div class="cp-row"><span class="cp-lbl">Po code</span><input class="cp-inp" type="text" id="cpFPostal" data-field="postal_code" onblur="CP._scheduleSave()"></div>
    </div>
  </div>

  <div class="cp-section">
    <div id="cpGroupsCheckboxes"></div>
  </div>

  <div class="cp-section" id="cpFamilyCard" style="display:none;">
    <div id="cpRelBody"></div>
    <div class="cp-add-row">
      <select class="cp-add-sel" id="cpRelContact"><option value="">— person —</option></select>
      <select class="cp-add-sel" id="cpRelType"><option value="">— relationship —</option></select>
      <button class="cp-btn-add" onclick="CP._addRelationship()">Add</button>
    </div>
    <div class="cp-form-msg" id="cpRelMsg"></div>
  </div>

  <div class="cp-section">
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

  function _renderGroupCheckboxes(keepDropdownOpen) {
    const el = document.getElementById('cpGroupsCheckboxes');
    const flat = _allGroupsFlat();
    const topIds = new Set(_allGroups.map(g => g.id));

    let html = '<div class="cp-pills">';
    const activeGroups = flat.filter(g => _contactGroupIds.has(g.id));
    for (const g of activeGroups) {
      const prefix = topIds.has(g.id) ? '' : '↳ ';
      html += `<span class="cp-pill active">${_esc(prefix + g.name)}<button class="cp-pill-remove" onclick="CP._removeFromGroup(${g.id})" title="Remove">×</button></span>`;
    }
    if (flat.length > 0) {
      html += `<button class="cp-group-add-btn" onclick="CP._toggleGroupDropdown()" title="Add group">+</button>`;
    }
    html += '</div>';

    if (flat.length > 0) {
      const ddDisplay = keepDropdownOpen ? '' : 'none';
      html += `<div class="cp-group-dropdown" id="cpGroupDropdown" style="display:${ddDisplay};">`;
      for (const g of _allGroups) {
        const checked = _contactGroupIds.has(g.id);
        html += `<label class="cp-group-dd-item"><input type="checkbox" ${checked ? 'checked' : ''} onchange="CP._toggleGroupMembership(${g.id},this)"> ${_esc(g.name)}</label>`;
        for (const s of (g.subgroups || [])) {
          const sc = _contactGroupIds.has(s.id);
          html += `<label class="cp-group-dd-item cp-group-dd-sub"><input type="checkbox" ${sc ? 'checked' : ''} onchange="CP._toggleGroupMembership(${s.id},this)"> ↳ ${_esc(s.name)}</label>`;
        }
      }
      html += '</div>';
    } else {
      html += '<div class="cp-pills-empty">No groups yet.</div>';
    }
    el.innerHTML = html;
  }

  async function _syncGroupsToServer() {
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

  async function _toggleGroupMembership(groupId, cb) {
    if (cb.checked) _contactGroupIds.add(groupId);
    else _contactGroupIds.delete(groupId);
    await _syncGroupsToServer();
    _renderGroupCheckboxes(true);
  }

  async function _removeFromGroup(groupId) {
    _contactGroupIds.delete(groupId);
    await _syncGroupsToServer();
    _renderGroupCheckboxes(false);
  }

  function _toggleGroupDropdown() {
    const dd = document.getElementById('cpGroupDropdown');
    if (dd) dd.style.display = dd.style.display === 'none' ? '' : 'none';
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
    _removeFromGroup,
    _toggleGroupDropdown,
    _addRelationship,
    _deleteRelationship,
    _addOccasion,
    _deleteOccasion,
  };
})();
