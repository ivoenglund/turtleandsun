(function () {
  'use strict';

  var CSS =
    'body{background:linear-gradient(175deg,#FFF5A0 0%,#FFE800 20%,#FFD000 40%,#FFC000 60%,#FFAA00 80%,#FF9500 100%);}' +
    '.sun{position:fixed;top:-238px;left:50%;transform:translateX(-50%);width:560px;height:560px;background:radial-gradient(circle,#fff 0%,rgba(255,255,245,0.92) 5%,rgba(255,255,200,0.65) 16%,rgba(255,240,80,0.28) 30%,transparent 52%);border-radius:50%;pointer-events:none;z-index:0;}' +
    '.ts-nav-bar{background:transparent;border-bottom:none;flex-shrink:0;position:relative;z-index:100;}' +
    '.ts-nav-wrap{padding:0;}' +
    '.ts-nav{display:flex;align-items:center;padding:16px 32px 18px 0;}' +
    '.ts-nav-panel-spacer{width:260px;flex-shrink:0;}' +
    '.ts-nav-gap{display:none;}' +
    '.ts-nav > a{margin-left:60px;}' +
    '.ts-nav a img{height:52px;width:auto;margin-top:-30px;display:block;}' +
    '.ts-nav-links{display:flex;gap:28px;align-items:center;margin-left:75px;}' +
    '.ts-nav-link{font-family:\'Plus Jakarta Sans\',sans-serif;font-size:14px;font-weight:500;color:#1C0A00;text-decoration:none;opacity:0.7;}' +
    '.ts-nav-link:hover{opacity:1;}' +
    '.ts-nav-account-wrap{position:relative;}' +
    '.ts-nav-account-btn{font-family:\'Plus Jakarta Sans\',sans-serif;font-size:14px;font-weight:500;color:#1C0A00;cursor:pointer;background:none;border:none;padding:0;opacity:0.7;}' +
    '.ts-nav-account-btn:hover{opacity:1;}' +
    '.ts-nav-hamburger{display:none;background:none;border:none;font-size:22px;cursor:pointer;color:#1C0A00;padding:4px;line-height:1;}' +
    '.ts-nav-dd{visibility:hidden;opacity:0;transform:translateY(-6px);transition:opacity 0.15s,transform 0.15s,visibility 0s 0.15s;position:absolute;top:calc(100% + 10px);right:0;background:#fff;border-radius:12px;box-shadow:0 8px 36px rgba(0,0,0,0.16);padding:14px 18px;width:220px;z-index:2000;}' +
    '.ts-nav-dd.open{visibility:visible;opacity:1;transform:translateY(0);transition:opacity 0.15s,transform 0.15s,visibility 0s 0s;}' +
    '.ts-nav-dd-email{font-size:11px;color:rgba(60,20,0,0.5);padding-bottom:8px;border-bottom:1px solid #f0ede6;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.ts-nav-dd-link{display:block;padding:6px 0;font-family:\'Plus Jakarta Sans\',sans-serif;font-size:13px;font-weight:500;color:#1C0A00;text-decoration:none;opacity:0.75;}' +
    '.ts-nav-dd-link:hover{opacity:1;color:#3A6B20;}' +
    '.ts-nav-dd-link.ts-active{color:#3A6B20;font-weight:700;opacity:1;}' +
    '.ts-nav-dd-logout{color:#c0392b!important;opacity:1!important;}' +
    '.ts-nav-dd-sep{height:1px;background:rgba(28,10,0,0.07);margin:6px 0;}' +
    '.ts-nav-drawer-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:1999;}' +
    '.ts-nav-drawer-overlay.open{display:block;}' +
    '.ts-nav-drawer{position:fixed;top:0;right:0;bottom:0;width:280px;background:#FFF9E6;z-index:2000;transform:translateX(100%);transition:transform 0.25s ease;overflow-y:auto;padding:16px 0;box-shadow:-4px 0 24px rgba(0,0,0,0.12);}' +
    '.ts-nav-drawer.open{transform:translateX(0);}' +
    '.ts-nav-drawer-header{display:flex;align-items:center;justify-content:space-between;padding:8px 20px 12px;border-bottom:1px solid rgba(28,10,0,0.08);margin-bottom:8px;}' +
    '.ts-nav-drawer-email{font-size:12px;color:rgba(28,10,0,0.5);font-family:\'Plus Jakarta Sans\',sans-serif;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.ts-nav-drawer-close{background:none;border:none;font-size:22px;cursor:pointer;color:rgba(28,10,0,0.4);padding:0;line-height:1;}' +
    '.ts-nav-drawer-link{display:block;padding:10px 20px;font-family:\'Plus Jakarta Sans\',sans-serif;font-size:14px;font-weight:500;color:#1C0A00;text-decoration:none;opacity:0.75;}' +
    '.ts-nav-drawer-link:hover{opacity:1;background:rgba(28,10,0,0.04);}' +
    '.ts-nav-drawer-link.ts-active{color:#3A6B20;font-weight:700;opacity:1;}' +
    '.ts-nav-drawer-logout{color:#c0392b!important;opacity:1!important;}' +
    '.ts-nav-drawer-sep{height:1px;background:rgba(28,10,0,0.08);margin:6px 20px;}' +
    '@media(max-width:1000px){.ts-nav-panel-spacer{display:none;}.ts-nav-links .ts-nav-link{display:none;}.ts-nav-account-wrap{display:none;}.ts-nav-cur{display:none;}.ts-nav-hamburger{display:block;}}' +
    'body:not(.ts-nav-admin) .ts-nav-admin-only{display:none;}' +
    'body:not(.ts-nav-loggedin) .ts-nav-auth{display:none;}' +
    'body.ts-nav-loggedin .ts-nav-guest{display:none;}' +
    '.ts-nav-cur{font-family:\'Plus Jakarta Sans\',sans-serif;font-size:13px;color:#1C0A00;background:transparent;border:1px solid rgba(28,10,0,0.22);border-radius:6px;padding:4px 6px;cursor:pointer;opacity:0.75;}' +
    '.ts-nav-cur:hover{opacity:1;}' +
    '.ts-nav-cur-drawer{display:block;width:calc(100% - 40px);margin:0 20px 10px;font-family:\'Plus Jakarta Sans\',sans-serif;font-size:14px;color:#1C0A00;background:#fff;border:1px solid rgba(28,10,0,0.22);border-radius:8px;padding:8px 10px;cursor:pointer;}';

  function buildHTML() {
    var curOptions =
      '<option value="sek">SEK · kr</option>' +
      '<option value="usd">USD · $</option>' +
      '<option value="eur">EUR · €</option>' +
      '<option value="gbp">GBP · £</option>';
    var navCur = window.tsCurrency ? '<select class="ts-nav-cur" id="ts-nav-cur" aria-label="Currency">' + curOptions + '</select>' : '';
    var drawerCur = window.tsCurrency ? '<select class="ts-nav-cur-drawer" id="ts-nav-cur-drawer" aria-label="Currency">' + curOptions + '</select>' : '';

    var dd =
      '<div class="ts-nav-dd" id="ts-nav-dd">' +
        '<div class="ts-nav-dd-email ts-nav-auth" id="ts-nav-dd-email"></div>' +
        '<a class="ts-nav-dd-link ts-nav-admin-only" href="/admin">Admin dashboard</a>' +
        '<a class="ts-nav-dd-link ts-nav-admin-only" href="/admin/concepts">↳ Concepts</a>' +
        '<a class="ts-nav-dd-link ts-nav-admin-only" href="/admin/gallery">↳ Gallery</a>' +
        '<a class="ts-nav-dd-link ts-nav-admin-only" href="/admin/visits">↳ Visits</a>' +
        '<a class="ts-nav-dd-link ts-nav-admin-only" href="/admin/failed-deliveries">↳ Deliveries</a>' +
        '<a class="ts-nav-dd-link ts-nav-auth ts-pg-contacts" href="/account/contacts">Contacts</a>' +
        '<a class="ts-nav-dd-link ts-nav-auth ts-pg-network" href="/account/network?view=network">Network</a>' +
        '<a class="ts-nav-dd-link ts-nav-auth ts-pg-outline" href="/account/network?view=outline">Outline</a>' +
        '<a class="ts-nav-dd-link ts-nav-auth ts-pg-calendar" href="/account/network?view=calendar">Calendar</a>' +
        '<a class="ts-nav-dd-link ts-nav-auth ts-pg-map" href="/account/network?view=map">Map</a>' +
        '<a class="ts-nav-dd-link ts-nav-auth ts-pg-occasions" href="/account/occasions">Occasions</a>' +
        '<a class="ts-nav-dd-link ts-nav-auth ts-pg-library" href="/account/library">Library</a>' +
        '<div class="ts-nav-dd-sep ts-nav-auth"></div>' +
        '<a class="ts-nav-dd-link ts-nav-auth" href="/auth/google/contacts">↻ Sync Google contacts</a>' +
        '<a class="ts-nav-dd-link ts-nav-auth" href="/print/labels">Print address labels</a>' +
        '<a class="ts-nav-dd-link ts-nav-auth" href="/account/occasions">Print occasion list</a>' +
        '<a class="ts-nav-dd-link ts-nav-auth" href="/print/calendar">Print calendar</a>' +
        '<div class="ts-nav-dd-sep ts-nav-auth"></div>' +
        '<a class="ts-nav-dd-link ts-nav-auth ts-pg-account" href="/account">Account settings</a>' +
        '<a class="ts-nav-dd-link ts-nav-auth ts-nav-dd-logout" href="/auth/logout">Log out</a>' +
        '<a class="ts-nav-dd-link ts-nav-guest" href="/login">Log in</a>' +
      '</div>';

    var drawer =
      '<div class="ts-nav-drawer" id="ts-nav-drawer">' +
        '<div class="ts-nav-drawer-header">' +
          '<span class="ts-nav-drawer-email" id="ts-nav-drawer-email"></span>' +
          '<button class="ts-nav-drawer-close" id="ts-nav-drawer-close">&times;</button>' +
        '</div>' +
        drawerCur +
        '<a class="ts-nav-drawer-link" href="/">Home</a>' +
        '<a class="ts-nav-drawer-link" href="/pricing">Pricing</a>' +
        '<a class="ts-nav-drawer-link" href="/faq">FAQ</a>' +
        '<div class="ts-nav-drawer-sep"></div>' +
        '<a class="ts-nav-drawer-link ts-nav-admin-only" href="/admin">Admin dashboard</a>' +
        '<a class="ts-nav-drawer-link ts-nav-admin-only" href="/admin/concepts">↳ Concepts</a>' +
        '<a class="ts-nav-drawer-link ts-nav-admin-only" href="/admin/gallery">↳ Gallery</a>' +
        '<a class="ts-nav-drawer-link ts-nav-admin-only" href="/admin/visits">↳ Visits</a>' +
        '<a class="ts-nav-drawer-link ts-nav-admin-only" href="/admin/failed-deliveries">↳ Deliveries</a>' +
        '<a class="ts-nav-drawer-link ts-nav-auth ts-pg-contacts" href="/account/contacts">Contacts</a>' +
        '<a class="ts-nav-drawer-link ts-nav-auth ts-pg-network" href="/account/network?view=network">Network</a>' +
        '<a class="ts-nav-drawer-link ts-nav-auth ts-pg-outline" href="/account/network?view=outline">Outline</a>' +
        '<a class="ts-nav-drawer-link ts-nav-auth ts-pg-calendar" href="/account/network?view=calendar">Calendar</a>' +
        '<a class="ts-nav-drawer-link ts-nav-auth ts-pg-map" href="/account/network?view=map">Map</a>' +
        '<a class="ts-nav-drawer-link ts-nav-auth ts-pg-occasions" href="/account/occasions">Occasions</a>' +
        '<a class="ts-nav-drawer-link ts-nav-auth ts-pg-library" href="/account/library">Library</a>' +
        '<div class="ts-nav-drawer-sep ts-nav-auth"></div>' +
        '<a class="ts-nav-drawer-link ts-nav-auth" href="/auth/google/contacts">↻ Sync Google contacts</a>' +
        '<a class="ts-nav-drawer-link ts-nav-auth" href="/print/labels">Print address labels</a>' +
        '<a class="ts-nav-drawer-link ts-nav-auth" href="/account/occasions">Print occasion list</a>' +
        '<a class="ts-nav-drawer-link ts-nav-auth" href="/print/calendar">Print calendar</a>' +
        '<div class="ts-nav-drawer-sep ts-nav-auth"></div>' +
        '<a class="ts-nav-drawer-link ts-nav-auth ts-pg-account" href="/account">Account settings</a>' +
        '<a class="ts-nav-drawer-link ts-nav-auth ts-nav-drawer-logout" href="/auth/logout">Log out</a>' +
        '<a class="ts-nav-drawer-link ts-nav-guest" href="/login">Log in</a>' +
      '</div>';

    return (
      '<div class="ts-nav-bar" id="ts-nav-bar">' +
        '<div class="ts-nav-wrap">' +
          '<div class="ts-nav">' +
            '<div class="ts-nav-panel-spacer"></div>' +
            '<a href="/"><img src="/logo.svg" alt="Turtle and Sun"></a>' +
            '<div class="ts-nav-gap"></div>' +
            '<div class="ts-nav-links">' +
              '<a href="/" class="ts-nav-link">Home</a>' +
              '<a href="/pricing" class="ts-nav-link">Pricing</a>' +
              '<a href="/faq" class="ts-nav-link">FAQ</a>' +
              navCur +
              '<div class="ts-nav-account-wrap">' +
                '<button class="ts-nav-account-btn" id="ts-nav-account-btn">Account</button>' +
                dd +
              '</div>' +
              '<button class="ts-nav-hamburger" id="ts-nav-hamburger">&#9776;</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ts-nav-drawer-overlay" id="ts-nav-drawer-overlay"></div>' +
      drawer
    );
  }

  function injectCSS() {
    if (document.getElementById('ts-nav-style')) return;
    var style = document.createElement('style');
    style.id = 'ts-nav-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function injectHTML() {
    if (document.getElementById('ts-nav-bar')) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = buildHTML();
    var frag = document.createDocumentFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    document.body.insertBefore(frag, document.body.firstChild);
    if (!document.querySelector('.sun')) {
      var sun = document.createElement('div');
      sun.className = 'sun';
      document.body.insertBefore(sun, document.body.firstChild);
    }
  }

  function detectPage() {
    var p = window.location.pathname;
    var view = new URLSearchParams(window.location.search).get('view');
    if (p === '/account/contacts') return 'contacts';
    if (p === '/account/network') return view === 'outline' ? 'outline' : view === 'calendar' ? 'calendar' : view === 'map' ? 'map' : 'network';
    if (p === '/account/occasions') return 'occasions';
    if (p === '/account/library') return 'library';
    if (p === '/account') return 'account';
    if (p === '/admin') return 'admin';
    return null;
  }

  function highlightActivePage() {
    var page = detectPage();
    if (!page) return;
    document.querySelectorAll('.ts-pg-' + page).forEach(function (el) { el.classList.add('ts-active'); });
  }

  function setupEvents() {
    var btn = document.getElementById('ts-nav-account-btn');
    var dd = document.getElementById('ts-nav-dd');
    var hamburger = document.getElementById('ts-nav-hamburger');
    var overlay = document.getElementById('ts-nav-drawer-overlay');
    var drawer = document.getElementById('ts-nav-drawer');
    var drawerClose = document.getElementById('ts-nav-drawer-close');

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      dd.classList.toggle('open');
    });

    document.addEventListener('click', function (e) {
      if (dd.classList.contains('open') && !btn.contains(e.target) && !dd.contains(e.target)) {
        dd.classList.remove('open');
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        dd.classList.remove('open');
        closeDrawer();
      }
    });

    function openDrawer() { overlay.classList.add('open'); drawer.classList.add('open'); }
    function closeDrawer() { overlay.classList.remove('open'); drawer.classList.remove('open'); }

    hamburger.addEventListener('click', openDrawer);
    overlay.addEventListener('click', closeDrawer);
    drawerClose.addEventListener('click', closeDrawer);
  }

  function setupCurrency() {
    if (!window.tsCurrency) return;
    var selects = [document.getElementById('ts-nav-cur'), document.getElementById('ts-nav-cur-drawer')].filter(Boolean);
    if (!selects.length) return;
    function sync(code) { selects.forEach(function (s) { if (s.value !== code) s.value = code; }); }
    sync(window.tsCurrency.code);
    selects.forEach(function (s) {
      s.addEventListener('change', function () { window.tsCurrency.setCurrency(s.value); });
    });
    window.tsCurrency.onChange(sync);
  }

  window.NavBar = {
    init: async function (opts) {
      var requireAuth = opts && opts.requireAuth;
      injectCSS();
      injectHTML();
      highlightActivePage();
      setupEvents();
      setupCurrency();

      var status = null;
      try {
        var res = await fetch('/api/auth/status', { credentials: 'same-origin' });
        status = res.ok ? await res.json() : null;
      } catch (e) {
        status = null;
      }
      console.log('[NavBar] auth status response:', status);

      if (requireAuth && (!status || !status.loggedIn)) {
        console.log('[NavBar] redirecting to /login because requireAuth is true and user is not logged in');
        window.location.href = '/login';
        return null;
      }

      if (status && status.loggedIn) {
        document.body.classList.add('ts-nav-loggedin');
        var email = status.email || '';
        var ddEmail = document.getElementById('ts-nav-dd-email');
        if (ddEmail) ddEmail.textContent = email;
        var drawerEmail = document.getElementById('ts-nav-drawer-email');
        if (drawerEmail) drawerEmail.textContent = email;

        if (status.isAdmin) {
          document.body.classList.add('ts-nav-admin');
        }
      }

      return status;
    }
  };
})();
