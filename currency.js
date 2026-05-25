(function () {
  'use strict';

  var SUPPORTED = ['sek', 'usd', 'eur', 'gbp'];
  var CACHE_TTL = 10 * 60 * 1000; // 10 minutes
  var listeners = [];
  var state = { code: 'sek', data: null };

  function readPref() {
    try {
      var p = localStorage.getItem('ts_currency_pref');
      return SUPPORTED.indexOf(p) >= 0 ? p : null;
    } catch (e) { return null; }
  }
  function readCache() {
    try {
      var obj = JSON.parse(sessionStorage.getItem('ts_currency_data') || 'null');
      if (!obj || !obj.ts || Date.now() - obj.ts > CACHE_TTL) return null;
      return obj.data;
    } catch (e) { return null; }
  }
  function writeCache(data) {
    try { sessionStorage.setItem('ts_currency_data', JSON.stringify({ ts: Date.now(), data: data })); } catch (e) {}
  }
  function notify() {
    listeners.forEach(function (fn) { try { fn(state.code); } catch (e) {} });
  }

  // Client-side mirror of the server's formatPrice (for computed amounts like the bundle saving).
  function fmt(amount, code) {
    var major = amount / 100;
    if (code === 'sek') return Math.round(major) + ' kr';
    if (code === 'usd') return '$' + major.toFixed(2);
    if (code === 'eur') return '€' + major.toFixed(2);
    if (code === 'gbp') return '£' + major.toFixed(2);
    return String(major);
  }

  window.tsCurrency = {
    get code() { return state.code; },
    get data() { return state.data; },
    supported: SUPPORTED.slice(),
    setCurrency: function (code) {
      if (SUPPORTED.indexOf(code) < 0 || code === state.code) return;
      state.code = code;
      try { localStorage.setItem('ts_currency_pref', code); } catch (e) {}
      notify();
    },
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    amount: function (product) {
      var d = state.data;
      if (d && d.prices && d.prices[state.code] && d.prices[state.code][product]) {
        return d.prices[state.code][product].amount;
      }
      return null;
    },
    format: function (product) {
      var d = state.data;
      if (d && d.prices && d.prices[state.code] && d.prices[state.code][product]) {
        return d.prices[state.code][product].display;
      }
      return '';
    },
    formatAmount: function (amount) { return fmt(amount, state.code); },
  };

  var pref = readPref();

  function applyData(data) {
    state.data = data;
    var code = pref || (data && data.detected) || 'sek';
    if (SUPPORTED.indexOf(code) < 0) code = 'sek';
    state.code = code;
    notify();
  }

  // Pref alone sets the active code immediately; we still need price data for display.
  if (pref) state.code = pref;

  var cached = readCache();
  if (cached) {
    applyData(cached);
    window.tsCurrency.ready = Promise.resolve();
  } else {
    window.tsCurrency.ready = fetch('/api/currency', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data) { writeCache(data); applyData(data); } })
      .catch(function () {});
  }
})();
