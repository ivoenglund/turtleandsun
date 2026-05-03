(function () {
  'use strict';

  var PALETTE = ['#628F72','#627496','#826592','#8E715A','#62828E','#7A8E62','#996C5D','#628278'];
  var FAMILY_COLOR = '#A4636F';

  function lightenHex(hex, t) {
    var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return '#'+[r,g,b].map(function(v){ return Math.round(v+(255-v)*t).toString(16).padStart(2,'0'); }).join('');
  }

  var _colorMap = {};
  var _depthMap = {};

  function _clear() { _colorMap = {}; _depthMap = {}; }

  function _walkTree(subs, parentColor, depth) {
    (subs || []).forEach(function(s) {
      _colorMap[s.name] = parentColor;
      _depthMap[s.name] = depth;
      _walkTree(s.subgroups, parentColor, depth + 1);
    });
  }

  function _setCSSVars() {
    var root = document.documentElement;
    Object.keys(_colorMap).forEach(function(name) {
      root.style.setProperty('--group-' + name.toLowerCase().replace(/[^a-z0-9]+/g,'-'), _colorMap[name]);
    });
  }

  window.GroupColors = {
    PALETTE: PALETTE,
    FAMILY_COLOR: FAMILY_COLOR,
    lightenHex: lightenHex,

    // Accepts flat array [{id, name, parent_group_id}] — from /api/network data.groups
    initFlat: function (flatGroups) {
      _clear();
      var byId = {};
      flatGroups.forEach(function(g) { byId[g.id] = g; });
      var top = flatGroups.filter(function(g){ return !g.parent_group_id; });
      top.sort(function(a,b){ return a.name==='Family'?-1:b.name==='Family'?1:a.name.localeCompare(b.name); });
      top.forEach(function(g, i) {
        _colorMap[g.name] = g.name === 'Family' ? FAMILY_COLOR : PALETTE[i % PALETTE.length];
        _depthMap[g.name] = 0;
      });
      var q = top.map(function(g){ return g.id; });
      var vis = new Set(q);
      while (q.length) {
        var next = [];
        q.forEach(function(pid) {
          flatGroups.filter(function(g){ return g.parent_group_id === pid && !vis.has(g.id); }).forEach(function(g) {
            var par = byId[g.parent_group_id];
            _colorMap[g.name] = par ? _colorMap[par.name] : PALETTE[0];
            _depthMap[g.name] = (_depthMap[par ? par.name : ''] || 0) + 1;
            vis.add(g.id); next.push(g.id);
          });
        });
        q = next;
      }
      _setCSSVars();
    },

    // Accepts tree array [{id, name, parent_group_id, subgroups:[...]}] — from /api/groups
    initTree: function (treeGroups) {
      _clear();
      var top = (treeGroups || []).filter(function(g){ return !g.parent_group_id; });
      top.sort(function(a,b){ return a.name==='Family'?-1:b.name==='Family'?1:a.name.localeCompare(b.name); });
      top.forEach(function(g, i) {
        _colorMap[g.name] = g.name === 'Family' ? FAMILY_COLOR : PALETTE[i % PALETTE.length];
        _depthMap[g.name] = 0;
        _walkTree(g.subgroups, _colorMap[g.name], 1);
      });
      _setCSSVars();
    },

    get: function (groupName) {
      return _colorMap[groupName] || '#9aa5b4';
    },

    getDepth: function (groupName) {
      return _depthMap[groupName] || 0;
    },

    // Returns primary color for a contact given an array of group names they belong to.
    // Prefers top-level groups (depth 0) over subgroups.
    getForNames: function (groupNames) {
      if (!groupNames || !groupNames.length) return '#9aa5b4';
      var sorted = groupNames.slice().sort(function(a,b){
        return (_depthMap[a]||99) - (_depthMap[b]||99);
      });
      return _colorMap[sorted[0]] || '#9aa5b4';
    },

    getAll: function () {
      var out = {};
      Object.keys(_colorMap).forEach(function(k){ out[k] = _colorMap[k]; });
      return out;
    },
  };
})();
