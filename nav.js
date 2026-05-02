(function () {
  'use strict';

  var CSS =
    '.ts-nav-bar{background:#FFF9E6;border-bottom:1px solid rgba(28,10,0,0.08);flex-shrink:0;position:relative;z-index:100;}' +
    '.ts-nav-wrap{max-width:1200px;margin:0 auto;padding:0 32px;}' +
    '.ts-nav{display:flex;align-items:center;justify-content:space-between;padding:16px 0 18px;}' +
    '.ts-nav a img{height:72px;width:auto;margin-top:-42px;display:block;}' +
    '.ts-nav-links{display:flex;gap:28px;align-items:center;}' +
    '.ts-nav-link{font-family:\'Plus Jakarta Sans\',sans-serif;font-size:14px;font-weight:500;color:#1C0A00;text-decoration:none;opacity:0.7;}' +
    '.ts-nav-link:hover{opacity:1;}' +
    '.ts-nav-account-wrap{position:relative;}' +
    '.ts-nav-account-btn{font-family:\'Plus Jakarta Sans\',sans-serif;font-size:14px;font-weight:500;color:#1C0A00;cursor:pointer;background:none;border:none;padding:0;opacity:0.7;}' +
    '.ts-nav-account-btn:hover{opacity:1;}' +
    '.ts-nav-hamburger{display:none;background:none;border:none;font-size:22px;cursor:pointer;color:#1C0A00;padding:4px;line-height:1;}' +
    '.ts-nav-dd{visibility:hidden;opacity:0;transform:translateY(-6px);transition:opacity 0.15s,transform 0.15s,visibility 0s 0.15s;position:absolute;top:calc(100% + 10px);right:0;background:#fff;border-radius:12px;box-shadow:0 8px 36px rgba(0,0,0,0.16);padding:14px 18px;width:220px;z-index:300;}' +
    '.ts-nav-dd.open{visibility:visible;opacity:1;transform:translateY(0);transition:opacity 0.15s,transform 0.15s,visibility 0s 0s;}' +
    '.ts-nav-dd-email{font-size:11px;color:rgba(60,20,0,0.5);padding-bottom:8px;border-bottom:1px solid #f0ede6;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.ts-nav-dd-link{display:block;padding:6px 0;font-family:\'Plus Jakarta Sans\',sans-serif;font-size:13px;font-weight:500;color:#1C0A00;text-decoration:none;opacity:0.75;}' +
    '.ts-nav-dd-link:hover{opacity:1;color:#3A6B20;}' +
    '.ts-nav-dd-link.ts-active{color:#3A6B20;font-weight:700;opacity:1;}' +
    '.ts-nav-dd-logout{color:#c0392b!important;opacity:1!important;}' +
    '.ts-nav-dd-sep{height:1px;background:rgba(28,10,0,0.07);margin:6px 0;}' +
    '.ts-nav-drawer-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:1000;}' +
    '.ts-nav-drawer-overlay.open{display:block;}' +
    '.ts-nav-drawer{position:fixed;top:0;right:0;bottom:0;width:280px;background:#FFF9E6;z-index:1001;transform:translateX(100%);transition:transform 0.25s ease;overflow-y:auto;padding:16px 0;box-shadow:-4px 0 24px rgba(0,0,0,0.12);}' +
    '.ts-nav-drawer.open{transform:translateX(0);}' +
    '.ts-nav-drawer-header{display:flex;align-items:center;justify-content:space-between;padding:8px 20px 12px;border-bottom:1px solid rgba(28,10,0,0.08);margin-bottom:8px;}' +
    '.ts-nav-drawer-email{font-size:12px;color:rgba(28,10,0,0.5);font-family:\'Plus Jakarta Sans\',sans-serif;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.ts-nav-drawer-close{background:none;border:none;font-size:22px;cursor:pointer;color:rgba(28,10,0,0.4);padding:0;line-height:1;}' +
    '.ts-nav-drawer-link{display:block;padding:10px 20px;font-family:\'Plus Jakarta Sans\',sans-serif;font-size:14px;font-weight:500;color:#1C0A00;text-decoration:none;opacity:0.75;}' +
    '.ts-nav-drawer-link:hover{opacity:1;background:rgba(28,10,0,0.04);}' +
    '.ts-nav-drawer-link.ts-active{color:#3A6B20;font-weight:700;opacity:1;}' +
    '.ts-nav-drawer-logout{color:#c0392b!important;opacity:1!important;}' +
    '.ts-nav-drawer-sep{height:1px;background:rgba(28,10,0,0.08);margin:6px 20px;}' +
    '@media(max-width:1000px){.ts-nav-links .ts-nav-link{display:none;}.ts-nav-account-wrap{display:none;}.ts-nav-hamburger{display:block;}}';

  function buildHTML() {
    var dd =
      '<div class="ts-nav-dd" id="ts-nav-dd">' +
        '<div class="ts-nav-dd-email" id="ts-nav-dd-email"></div>' +
        '<a class="ts-nav-dd-link ts-pg-contacts" href="/account/contacts">Contacts</a>' +
        '<a class="ts-nav-dd-link ts-pg-network" href="/account/network?view=network">Network</a>' +
        '<a class="ts-nav-dd-link ts-pg-outline" href="/account/network?view=outline">Outline</a>' +
        '<a class="ts-nav-dd-link ts-pg-calendar" href="/account/network?view=calendar">Calendar</a>' +
        '<a class="ts-nav-dd-link ts-pg-occasions" href="/account/occasions">Occasions</a>' +
        '<div class="ts-nav-dd-sep"></div>' +
        '<a class="ts-nav-dd-link" href="/auth/google/contacts">↻ Sync Google contacts</a>' +
        '<a class="ts-nav-dd-link" href="/print/labels">Print address labels</a>' +
        '<a class="ts-nav-dd-link" href="/account/occasions">Print occasion list</a>' +
        '<a class="ts-nav-dd-link" href="/print/calendar">Print calendar</a>' +
        '<div class="ts-nav-dd-sep"></div>' +
        '<a class="ts-nav-dd-link ts-pg-account" href="/account">Account settings</a>' +
        '<a class="ts-nav-dd-link ts-nav-dd-logout" href="/auth/logout">Log out</a>' +
      '</div>';

    var drawer =
      '<div class="ts-nav-drawer" id="ts-nav-drawer">' +
        '<div class="ts-nav-drawer-header">' +
          '<span class="ts-nav-drawer-email" id="ts-nav-drawer-email"></span>' +
          '<button class="ts-nav-drawer-close" id="ts-nav-drawer-close">&times;</button>' +
        '</div>' +
        '<a class="ts-nav-drawer-link" href="/">Home</a>' +
        '<a class="ts-nav-drawer-link" href="/pricing">Pricing</a>' +
        '<a class="ts-nav-drawer-link" href="/faq">FAQ</a>' +
        '<div class="ts-nav-drawer-sep"></div>' +
        '<a class="ts-nav-drawer-link ts-pg-contacts" href="/account/contacts">Contacts</a>' +
        '<a class="ts-nav-drawer-link ts-pg-network" href="/account/network?view=network">Network</a>' +
        '<a class="ts-nav-drawer-link ts-pg-outline" href="/account/network?view=outline">Outline</a>' +
        '<a class="ts-nav-drawer-link ts-pg-calendar" href="/account/network?view=calendar">Calendar</a>' +
        '<a class="ts-nav-drawer-link ts-pg-occasions" href="/account/occasions">Occasions</a>' +
        '<div class="ts-nav-drawer-sep"></div>' +
        '<a class="ts-nav-drawer-link" href="/auth/google/contacts">↻ Sync Google contacts</a>' +
        '<a class="ts-nav-drawer-link" href="/print/labels">Print address labels</a>' +
        '<a class="ts-nav-drawer-link" href="/account/occasions">Print occasion list</a>' +
        '<a class="ts-nav-drawer-link" href="/print/calendar">Print calendar</a>' +
        '<div class="ts-nav-drawer-sep"></div>' +
        '<a class="ts-nav-drawer-link ts-pg-account" href="/account">Account settings</a>' +
        '<a class="ts-nav-drawer-link ts-nav-drawer-logout" href="/auth/logout">Log out</a>' +
      '</div>';

    return (
      '<div class="ts-nav-bar" id="ts-nav-bar">' +
        '<div class="ts-nav-wrap">' +
          '<div class="ts-nav">' +
            '<a href="/"><img src="/logo.png" alt="Turtle and Sun"></a>' +
            '<div class="ts-nav-links">' +
              '<a href="/" class="ts-nav-link">Home</a>' +
              '<a href="/pricing" class="ts-nav-link">Pricing</a>' +
              '<a href="/faq" class="ts-nav-link">FAQ</a>' +
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
  }

  function detectPage() {
    var p = window.location.pathname;
    var view = new URLSearchParams(window.location.search).get('view');
    if (p === '/account/contacts') return 'contacts';
    if (p === '/account/network') return view === 'outline' ? 'outline' : view === 'calendar' ? 'calendar' : 'network';
    if (p === '/account/occasions') return 'occasions';
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

  window.NavBar = {
    init: async function (opts) {
      var requireAuth = opts && opts.requireAuth;
      injectCSS();
      injectHTML();
      highlightActivePage();
      setupEvents();

      var status = null;
      try {
        var res = await fetch('/api/auth/status');
        status = res.ok ? await res.json() : null;
      } catch (e) {
        status = null;
      }

      if (requireAuth && (!status || !status.loggedIn)) {
        window.location.href = '/login';
        return null;
      }

      if (status && status.loggedIn) {
        var email = status.email || '';
        var ddEmail = document.getElementById('ts-nav-dd-email');
        if (ddEmail) ddEmail.textContent = email;
        var drawerEmail = document.getElementById('ts-nav-drawer-email');
        if (drawerEmail) drawerEmail.textContent = email;

        if (status.isAdmin) {
          document.querySelectorAll('.ts-pg-account').forEach(function (el) {
            el.href = '/admin';
            el.textContent = 'Admin dashboard';
          });
        }
      }

      return status;
    }
  };
})();
