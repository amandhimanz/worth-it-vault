/**
 * ============================================================
 * VELORA AXIS — script.js  v7 (touch snap: single-swipe rewrite)
 * ============================================================
 *
 * WHAT CHANGED FROM v6
 * ──────────────────────────────────────────────────────────
 *
 *  1. TOUCH NAVIGATION FELT HEAVY AND WAS DIRECTIONALLY UNEVEN
 *     v6's "settle then pull" model required TWO separate,
 *     discrete touches every time, by design — one to bring the
 *     content to rest at the edge (with a mandatory
 *     TOUCH_SETTLE_WAIT pause), then a brand-new second touch to
 *     confirm the pull. That's always at least two motions to
 *     leave a section, which reads as slow/heavy no matter how
 *     it's tuned. Worse, its `restingEdge` flag was reset on
 *     every panel arrival and only got set by an actual `scroll`
 *     event settling — so swiping back up immediately after
 *     arriving at a fresh panel (before any inner scroll had
 *     happened yet) had no primed resting edge to check against.
 *     That first upward swipe silently did nothing; only the
 *     small bounce it caused primed the state for a second
 *     attempt to work — exactly the "have to build momentum
 *     before going up" feel. Downward felt better only because
 *     normal reading (pausing between scrolls) happened to prime
 *     the resting state naturally along the way.
 *     FIX: removed the resting/settle state machine entirely.
 *     Each touch now judges itself: on touchend, compare how far
 *     the finger travelled (dY) to how far the content actually
 *     scrolled during that same touch (actualScroll). Once an
 *     edge is reached, the content can't absorb any more drag,
 *     so the gap between the two — the "pull" — grows in real
 *     time. Once pull crosses TOUCH_PULL_THRESHOLD while sitting
 *     at the relevant edge (or the smaller
 *     TOUCH_FLICK_PULL_THRESHOLD, if the swipe was fast), that
 *     single touch snaps immediately on release — no artificial
 *     wait, no requirement that it be a "new" touch. A confident
 *     swipe that both finishes the content and pushes past the
 *     edge now snaps in one motion; a normal reading swipe that
 *     merely reaches the edge still just comes to rest, exactly
 *     as before — it just no longer needs a specially-timed
 *     second touch to confirm.
 *
 *  2. CROSS-BROWSER TOUCH HARDENING
 *     Added a `touchcancel` listener — iOS Control Center /
 *     Notification Center swipes and Android's edge back-gesture
 *     both cancel a touch instead of ending it normally, which
 *     without this left `startY` stranded for that panel. Also
 *     clamped the scrollTop reads used in the pull calculation to
 *     the valid [0, range] span, since iOS Safari can report a
 *     brief rubber-band overshoot past 0/max mid-bounce that would
 *     otherwise skew the measurement by a few stray px right as the
 *     finger lifts.
 *
 * Everything else — PC wheel easing, panel map, paste zones,
 * dot-nav, keyboard, loader and drift guard — is unchanged.
 * Full v5→v6 history kept below for reference.
 *
 * WHAT CHANGED FROM v5
 * ──────────────────────────────────────────────────────────
 *
 *  1. TOUCH SNAPPING WAS STILL UNRELIABLE
 *     v5 counted "separate touch gestures" via touchend events,
 *     but native momentum scrolling continues well AFTER
 *     touchend fires. So a single fast flick's momentum could
 *     carry the content to the boundary after the finger had
 *     already lifted — and an unrelated next tap got counted as
 *     "gesture #2", causing a snap that looked like it happened
 *     on one touch.
 *     FIX: replaced gesture-counting with a "settle then pull"
 *     model. A native `scroll` listener (which reflects momentum
 *     too) tracks when content comes to a genuine, complete stop
 *     at the top/bottom edge — only after TOUCH_SETTLE_WAIT ms of
 *     no movement is the section considered "resting at edge".
 *     A snap can only fire if a BRAND NEW touch starts while
 *     already resting there, and drags further outward by at
 *     least TOUCH_PULL_THRESHOLD px. One continuous swipe, no
 *     matter how far/fast, can only ever bring content to rest —
 *     it can never itself trigger the snap. You can scroll with
 *     as many touches as you like inside a section; only a touch
 *     that starts already-at-rest at the true edge can advance.
 *
 *  2. PC INNER SCROLL SENSITIVITY WAS TOO AGGRESSIVE
 *     Lowered WHEEL_STEP_GAIN (0.55 → 0.35) and raised
 *     WHEEL_FRICTION (0.90 → 0.92) so a normal wheel/trackpad
 *     tick produces a gentler, more natural glide instead of a
 *     sharp jump. Added WHEEL_MAX_VELOCITY as a hard per-frame
 *     cap so one strong tick can't launch an overly fast scroll.
 *     The underlying mechanism (JS owns wheel input via a
 *     requestAnimationFrame easing loop, since CSS
 *     `scroll-behavior: smooth` never applied to wheel input in
 *     the first place) is unchanged from v5 — just retuned.
 *
 * Panel map, paste zones, dot-nav, keyboard, loader and drift
 * guard are unchanged from earlier versions.
 * ============================================================
 */

(function () {
  'use strict';

  /* ============================================================
     SCROLL ENGINE — v8 (native CSS scroll-snap rewrite)
     ──────────────────────────────────────────────────────────
     WHY THIS EXISTS
     The old engine (v5→v7) hand-rolled its own wheel/touch physics
     in JS — a rAF momentum loop for wheel, a "pull past the edge"
     gesture-delta model for touch. Both had to re-derive, by hand,
     behaviour the browser already gives for free, and both could
     land in an inconsistent state (mid-transition, half a panel
     off) if a frame was dropped, a touch got cancelled, or a resize
     landed mid-animation — exactly the "gets stuck between
     sections" bug on mobile.

     This version deletes that layer and uses native CSS scroll-snap
     (see style.css) instead: the browser itself guarantees
     #scroll-container always comes to rest exactly on a panel
     boundary, for every input type (wheel, trackpad, touch,
     keyboard, scrollbar) — the compositor, not a JS frame loop,
     owns the physics, so it can't get stuck mid-panel. Sections
     that need inner content scroll (data-smooth="true") get a
     normal native overflow:auto element nested inside the snap
     panel: the browser already scrolls the innermost scrollable
     ancestor first and only lets the gesture bubble up to the outer
     snap container once that inner element hits its own edge —
     "smooth inside, snap between sections" with zero custom code.

     JS's job now is just the surrounding UX: keep dots/keyboard/
     nav in sync with whichever panel is current, and drive
     programmatic jumps (dot clicks, nav links, back-to-top) via
     scrollIntoView. Everything downstream in this file (nav reveal,
     mobile pill, reviews carousel, counters, footer reveal, etc.)
     talks to this engine only through S.current / S.moving /
     goTo() / moveTo() / updateDots() / window.voidGoToSection —
     all of which still exist with the same signatures, so none of
     that code needed to change.
  ============================================================ */

  var CFG = {
    MOVE_LOCK        : 700,  // ms — ignore new nav input while a programmatic scroll is animating
    OVERLAY_DURATION : 150,  // ms — flash overlay visible time
  };

  /* ============================================================
     ❷  DEVICE DETECTION
  ============================================================ */
  var IS_TOUCH = (
    ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
    window.matchMedia('(hover: none) and (pointer: coarse)').matches
  );


  /* ============================================================
     ❸  DOM REFERENCES
  ============================================================ */
  var container    = document.getElementById('scroll-container');
  var panels       = Array.from(document.querySelectorAll('.panel'));
  var dotNav       = document.getElementById('dot-nav');
  var dotList      = document.getElementById('dot-list');
  var overlay      = document.getElementById('transition-overlay');
  var TOTAL        = panels.length;

  console.log('[VELORA] ' + TOTAL + ' panels — ' + (IS_TOUCH ? 'TOUCH' : 'PC') + ' mode (native snap)');


  /* ============================================================
     ❹  STATE
  ============================================================ */
  var S = {
    current      : 0,
    moving       : false,
    globalSmooth : false,   // kept for API compatibility with later code; unused by the engine itself
  };
  var moveLockTimer = null;


  /* ============================================================
     ❺  BACKGROUND ASSIGNMENT
  ============================================================ */
  function assignBackgrounds() {
    var portrait = IS_TOUCH || window.matchMedia('(orientation: portrait)').matches;
    panels.forEach(function (p) {
      var src = portrait ? p.dataset.bgPortrait : p.dataset.bgLandscape;
      if (!src) return;
      p.classList.add('loading');
      var img = new Image();
      img.onload = function () {
        p.style.backgroundImage = "url('" + src + "')";
        p.classList.remove('loading');
        p.classList.add('loaded');
      };
      img.onerror = function () {
        var fb = portrait ? p.dataset.bgLandscape : p.dataset.bgPortrait;
        if (fb) p.style.backgroundImage = "url('" + fb + "')";
        p.classList.remove('loading');
        p.classList.add('loaded');
      };
      img.src = src;
    });
  }
  window.addEventListener('orientationchange', function () {
    setTimeout(assignBackgrounds, 200);
  });


  /* ============================================================
     ❻  CORE NAVIGATION
     ──────────────────────────────────────────────────────────
     goTo/moveTo now just ask the browser to scroll the target
     panel into view; native CSS scroll-snap (see style.css) takes
     it from there and guarantees it lands exactly on the panel
     boundary. S.moving is only used to stop nav double-fires
     (dot double-click, keyboard repeat) while that animation runs.
  ============================================================ */
  function flashOverlay() {
    if (!overlay) return;
    overlay.classList.add('flash');
    setTimeout(function () { overlay.classList.remove('flash'); }, CFG.OVERLAY_DURATION);
  }

  function goTo(index) {
    if (index < 0 || index >= TOTAL) return;
    if (index === S.current && !S.moving) return;
    var panel = panels[index];
    if (!panel) return;

    S.moving  = true;
    S.current = index;
    flashOverlay();
    updateDots(index);
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

    clearTimeout(moveLockTimer);
    moveLockTimer = setTimeout(function () { S.moving = false; }, CFG.MOVE_LOCK);
  }

  function moveTo(direction) {
    var next = S.current + direction;
    if (next < 0 || next >= TOTAL) return false;
    goTo(next);
    return true;
  }

  window.voidGoToSection = goTo;


  /* ============================================================
     ❼  CURRENT-SECTION TRACKING  (IntersectionObserver)
     ──────────────────────────────────────────────────────────
     As the user scrolls natively (wheel, touch, trackpad,
     scrollbar) — not via goTo() — S.current still needs to stay
     accurate so dots/keyboard/nav know where we are. An
     IntersectionObserver watching each panel is the reliable way
     to do that: it fires only when a panel actually becomes the
     dominant one in view, immune to the mid-scroll rounding issues
     that plagued the old scrollTop-comparison approach.
  ============================================================ */
  function initSectionObserver() {
    if (!('IntersectionObserver' in window) || !container) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.55) return;
        var idx = panels.indexOf(entry.target);
        if (idx === -1 || idx === S.current) return;
        S.current = idx;
        updateDots(idx);
      });
    }, { root: container, threshold: [0.55] });
    panels.forEach(function (p) { io.observe(p); });
  }

  /* ============================================================
     ⓭  KEYBOARD — Skips when user is typing in forms
  ============================================================ */
  function onKeydown(e) {
    if (S.moving) return;

    // ═══════════════ IGNORE IF USER IS TYPING IN A FORM ═══════════════
    var activeEl = document.activeElement;
    if (activeEl) {
      var tag = activeEl.tagName;
      var isInput = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
      var isContentEditable = activeEl.isContentEditable;

      if (isInput || isContentEditable) {
        // User is typing in a form field — don't hijack their keys
        return;
      }
    }

    switch (e.key) {
      case 'ArrowDown': case 'ArrowRight': case 'PageDown':
        e.preventDefault(); moveTo(1); break;
      case 'ArrowUp': case 'ArrowLeft': case 'PageUp':
        e.preventDefault(); moveTo(-1); break;
      case ' ': case 'Space':
        e.preventDefault(); moveTo(1); break;
      case 'Home':
        e.preventDefault(); goTo(0); break;
      case 'End':
        e.preventDefault(); goTo(TOTAL - 1); break;
    }
  }


  /* ============================================================
     ⓮  DOT NAVIGATION
  ============================================================ */
  // Update DOT_LABELS to match your actual sections
  var DOT_LABELS = [
    'HOME',          // 0: #section-landing
    'ABOUT',         // 1: #section-about
    'SERVICES',      // 2: #section-services
    'REVIEWS',       // 3: #section-reviews
    'COVERAGE',      // 4: #section-coverage
    'FAQ',           // 5: #section-faq
    'CONTACT',       // 6: #footer
  ];
  function updateDots(index) {
    if (!dotList) return;
    dotList.querySelectorAll('li').forEach(function (li, i) {
      li.classList.toggle('active', i === index);
      li.setAttribute('aria-current', i === index ? 'true' : 'false');
    });
  }

  function buildDots() {
    if (!dotList) return;
    dotList.innerHTML = '';
    panels.forEach(function (_, i) {
      var li   = document.createElement('li');
      var span = document.createElement('span');
      var lbl  = DOT_LABELS[i] || ('Panel ' + (i + 1));
      li.setAttribute('role', 'button');
      li.setAttribute('tabindex', '0');
      li.setAttribute('aria-label', 'Go to ' + lbl);
      li.setAttribute('aria-current', i === 0 ? 'true' : 'false');
      li.dataset.label = lbl;
      if (i === 0) li.classList.add('active');
      li.appendChild(span);
      li.addEventListener('pointerup', function (e) {
        e.preventDefault();
        goTo(i);
      });
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goTo(i);
        }
      });
      dotList.appendChild(li);
    });
    if (dotNav) dotNav.classList.add('visible');
  }


  /* ============================================================
     ⓱  RESIZE
     ──────────────────────────────────────────────────────────
     Native scroll-snap re-settles on its own when the layout
     changes size (address-bar show/hide, rotation, keyboard open),
     so there's no drift to correct here — just refresh backgrounds
     for the new orientation/aspect ratio.
  ============================================================ */
  var resizeTimer;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      assignBackgrounds();
    }, 150);
  }


  /* ============================================================
     ⓲  LOADER SAFETY NET
  ============================================================ */
  function ensureLoaderDismisses() {
    var loader = document.getElementById('site-loader');
    if (!loader || loader.classList.contains('loaded')) return;
    var bar = loader.querySelector('.loader__bar');
    if (bar) bar.style.width = '100%';
    setTimeout(function () {
      loader.classList.add('loaded');
      document.body.classList.add('is-loaded');
      loader.setAttribute('aria-hidden', 'true');
      loader.style.display = 'none';
    }, 300);
  }
  setTimeout(ensureLoaderDismisses, 5000);


  /* ============================================================
     ──────────────────────────────────────────────────────────
     SECTION PASTE ZONES  (unchanged — same names as before)
     ──────────────────────────────────────────────────────────
  ============================================================ */

  // ── PASTE UTILITIES BELOW ──

  // ── END UTILITIES ──

  // ── PASTE LOADER BELOW ──

  // ── END LOADER ──

  function initLoader() { /* stub */ }
 // ── navbar start ──
 // ── navbar start ──
// ── PASTE NAVBAR BELOW ──

(function () {
  'use strict';

  var nav = document.getElementById('wh-nav');
  var navLinks = document.getElementById('wh-nav-links');
  var toggle = document.getElementById('wh-nav-toggle');
  var allLinkEls = navLinks ? navLinks.querySelectorAll('a') : [];
  var brand = nav ? nav.querySelector('.wh-nav__brand') : null;
  var pill = document.getElementById('wh-pill');

  if (!nav || !navLinks) return;

  /* ── Config ── */
  var HERO_SECTION_IDS = [
  'section-landing', 
  'section-about', 
  'section-services', 
  'section-reviews', 
  'section-coverage', 
  'section-faq', 
  'footer'
];
  var MOBILE_BREAKPOINT = 860;
  var HOVER_ZONE_HEIGHT = 80;
  var PILL_AUTOSHOW_MS = 3000;
  var DESKTOP_HIDE_DELAY_MS = 2500;

  function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  function getCurrentPage() {
    var path = window.location.pathname;
    if (path.includes('index.html') || path === '/' || path.endsWith('/')) {
      return 'landing';
    } else if (path.includes('contact.html')) {
      return 'contact-form';
    } else if (path.includes('book.html')) {
      return 'booking';
    }
    return 'landing';
  }

  function isDifferentPage(href) {
    if (!href || href === '#') return false;
    var currentPath = window.location.pathname;
    var linkPath = '';
    try {
      if (href.startsWith('file:///')) {
        linkPath = href.replace('file:///', '/');
      } else if (href.startsWith('http')) {
        var url = new URL(href);
        linkPath = url.pathname;
      } else {
        linkPath = href;
      }
      currentPath = currentPath.replace(/\\/g, '/');
      linkPath = linkPath.replace(/\\/g, '/');
      var currentFile = currentPath.split('/').pop() || 'index.html';
      var linkFile = linkPath.split('/').pop() || 'index.html';
      return currentFile !== linkFile;
    } catch (e) {
      return false;
    }
  }

  function getHashFromHref(href) {
    if (!href) return '';
    var hashIndex = href.indexOf('#');
    return hashIndex >= 0 ? href.substring(hashIndex) : '';
  }

  var HOME_URL = 'index.html';

  if (brand) {
    brand.addEventListener('click', function (e) {
      e.preventDefault();
      window.location.href = HOME_URL;
    });
  }

  allLinkEls.forEach(function (link) {
    var href = link.getAttribute('href');
    if (isDifferentPage(href)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  });

  var menuOpen = false;

  function openMenu() {
    menuOpen = true;
    navLinks.classList.add('wh-nav__links--open');
    toggle.classList.add('wh-nav__toggle--open');
    toggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }

  function closeMenu() {
    menuOpen = false;
    navLinks.classList.remove('wh-nav__links--open');
    toggle.classList.remove('wh-nav__toggle--open');
    toggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  if (toggle) {
    toggle.addEventListener('click', function () {
      if (menuOpen) { closeMenu(); } else { openMenu(); }
    });
    toggle.addEventListener('touchend', function (e) {
      e.preventDefault();
      if (menuOpen) { closeMenu(); } else { openMenu(); }
    });
  }

  /* ── Handle link clicks ── */
  allLinkEls.forEach(function (link) {
    link.addEventListener('click', function (e) {
      var href = this.getAttribute('href');
      var navKey = this.getAttribute('data-nav');
      var hash = getHashFromHref(href);
      
      if (menuOpen) closeMenu();
      
      if (isDifferentPage(href)) {
        return;
      }
      
      if (hash) {
        e.preventDefault();
        var targetId = hash.substring(1);
        var target = document.getElementById(targetId);
        if (target) {
          var panel = target.closest('.panel') || target;
          var panels = Array.from(document.querySelectorAll('.panel'));
          var idx = panels.indexOf(panel);
          if (idx >= 0 && typeof window.voidGoToSection === 'function') {
            window.voidGoToSection(idx);
          }
        }
        return;
      }
      
      if (!isDifferentPage(href) && navKey) {
        e.preventDefault();
       var sectionMap = {
  'landing': 'section-landing',
  'about': 'section-about',
  'services': 'section-services',
  'reviews': 'section-reviews',
  'coverage': 'section-coverage',
  'faq': 'section-faq',
  'footer': 'footer'
};
        var targetId = sectionMap[navKey];
        if (!targetId) return;
        var target = document.getElementById(targetId);
        if (!target) return;
        var panels = Array.from(document.querySelectorAll('.panel'));
        var idx = panels.indexOf(target);
        if (idx >= 0 && typeof window.voidGoToSection === 'function') {
          window.voidGoToSection(idx);
        }
      }
    });
  });

  document.addEventListener('click', function (e) {
    if (menuOpen && !nav.contains(e.target) && (!pill || !pill.contains(e.target))) {
      closeMenu();
      collapseMobilePillNav();
    }
  });

  var inHero = true;
  var pillTimer = null;
  var desktopHideTimer = null;
  var mobileNavExpanded = false;
  var mobileNavExpandedTimer = null;

  function revealNav() {
    nav.classList.remove('wh-nav--hidden');
    nav.classList.add('wh-nav--revealed');
  }

  function hideNav() {
    if (inHero || menuOpen) return;
    nav.classList.remove('wh-nav--revealed');
    nav.classList.add('wh-nav--hidden');
  }

  function revealNavWithAutoHide() {
    revealNav();
    clearTimeout(desktopHideTimer);
    desktopHideTimer = setTimeout(function () {
      if (nav.matches(':hover')) return;
      hideNav();
    }, DESKTOP_HIDE_DELAY_MS);
  }

  function setHeroState(isHero) {
    inHero = isHero;
    if (isHero) {
      clearTimeout(pillTimer);
      clearTimeout(desktopHideTimer);
      clearTimeout(mobileNavExpandedTimer);
      hidePill();
      mobileNavExpanded = false;
      revealNav();
      document.removeEventListener('mousemove', handleMouseMove);
    } else {
      clearTimeout(desktopHideTimer);
      hideNav();
      if (isMobile()) {
        document.removeEventListener('mousemove', handleMouseMove);
        triggerPillAutoShow();
      } else {
        document.addEventListener('mousemove', handleMouseMove);
      }
    }
  }

  function handleMouseMove(e) {
    if (inHero || isMobile()) return;
    if (e.clientY <= HOVER_ZONE_HEIGHT || nav.contains(e.target)) {
      revealNavWithAutoHide();
    }
  }

  nav.addEventListener('mouseenter', function () {
    if (!inHero && !isMobile()) revealNavWithAutoHide();
  });

  function showPill() {
    if (!pill) return;
    pill.classList.add('wh-pill--enabled');
    pill.classList.remove('wh-pill--visible');
    void pill.offsetWidth;
    pill.classList.add('wh-pill--visible');
  }

  function hidePill() {
    if (!pill) return;
    pill.classList.remove('wh-pill--visible');
  }

  function triggerPillAutoShow() {
    if (inHero || !isMobile()) return;
    clearTimeout(pillTimer);
    if (mobileNavExpanded) return;
    showPill();
    pillTimer = setTimeout(function () {
      hidePill();
    }, PILL_AUTOSHOW_MS);
  }

  function expandMobilePillNav() {
    mobileNavExpanded = true;
    clearTimeout(pillTimer);
    pill.classList.remove('wh-pill--visible');
    pill.classList.add('wh-pill--expanded');
    pill.setAttribute('aria-expanded', 'true');
    pill.setAttribute('aria-label', 'Close navigation');
    revealNav();
    armMobileNavExpandedTimer();
  }

  function armMobileNavExpandedTimer() {
    clearTimeout(mobileNavExpandedTimer);
    mobileNavExpandedTimer = setTimeout(function () {
      if (mobileNavExpanded) collapseMobilePillNav();
    }, PILL_AUTOSHOW_MS);
  }

  function collapseMobilePillNav() {
    if (!mobileNavExpanded) return;
    mobileNavExpanded = false;
    clearTimeout(mobileNavExpandedTimer);
    if (pill) {
      pill.classList.remove('wh-pill--expanded');
      pill.setAttribute('aria-expanded', 'false');
      pill.setAttribute('aria-label', 'Open navigation');
    }
    if (!inHero) {
      hideNav();
      if (isMobile()) triggerPillAutoShow();
    }
  }

  if (pill) {
    pill.addEventListener('click', function (e) {
      e.stopPropagation();
      if (mobileNavExpanded) {
        collapseMobilePillNav();
      } else {
        expandMobilePillNav();
      }
    });
  }

  document.addEventListener('click', function (e) {
    if (mobileNavExpanded && !inHero && isMobile() && !nav.contains(e.target) && !(pill && pill.contains(e.target))) {
      collapseMobilePillNav();
    }
  });

  nav.addEventListener('touchstart', function () {
    if (mobileNavExpanded && isMobile()) armMobileNavExpandedTimer();
  }, { passive: true });
  
  navLinks.addEventListener('scroll', function () {
    if (mobileNavExpanded && isMobile()) armMobileNavExpandedTimer();
  }, { passive: true });

  var container = document.getElementById('scroll-container');
  if (container) {
    container.addEventListener('scroll', function () {
      if (container.scrollTop > 30) {
        nav.classList.add('wh-nav--scrolled');
      } else {
        nav.classList.remove('wh-nav--scrolled');
      }
    }, { passive: true });
  }

  var sectionMap = {
    'landing': 'section-landing',
    'landing-bc': 'section-landing-bc',
    'contact-form': 'section-contact-form',
    'email': 'section-email',
    'booking': 'section-booking',
    'careers': 'section-careers',
    'process': 'section-process',
    'office': 'section-office',
    'footer': 'footer'
  };

  var lastActiveKey = null;
  var lastPillScrollTop = null;
  var PILL_REARM_SCROLL_PX = 60;

  function updateActive() {
    if (!container) return;
    var scrollTop = container.scrollTop;
    var panels = Array.from(document.querySelectorAll('.panel'));
    var activeKey = null;
    var activeEl = null;

    panels.forEach(function (p) {
      if (scrollTop >= p.offsetTop - 80) {
        Object.keys(sectionMap).forEach(function (k) {
          if (sectionMap[k] === p.id) {
            activeKey = k;
            activeEl = p;
          }
        });
      }
    });

    allLinkEls.forEach(function (link) {
      if (link.getAttribute('data-nav') === activeKey) {
        link.classList.add('wh-nav__link--active');
      } else {
        link.classList.remove('wh-nav__link--active');
      }
    });

    var nowInHero = activeEl ? HERO_SECTION_IDS.includes(activeEl.id) : (scrollTop < 80);

    if (nowInHero !== inHero) {
      setHeroState(nowInHero);
    }

    if (activeKey !== lastActiveKey) {
      lastActiveKey = activeKey;
      if (!nowInHero && mobileNavExpanded) {
        collapseMobilePillNav();
      }
    }

    if (!nowInHero && isMobile() && !mobileNavExpanded) {
      if (lastPillScrollTop === null || Math.abs(scrollTop - lastPillScrollTop) >= PILL_REARM_SCROLL_PX) {
        lastPillScrollTop = scrollTop;
        triggerPillAutoShow();
      }
    } else {
      lastPillScrollTop = scrollTop;
    }
  }

  if (container) {
    container.addEventListener('scroll', updateActive, { passive: true });
  }

  function handleInitialHash() {
    var hash = window.location.hash;
    if (hash) {
      var targetId = hash.substring(1);
      var attempts = 0;
      var tryNav = setInterval(function () {
        attempts++;
        if (typeof window.voidGoToSection === 'function') {
          clearInterval(tryNav);
          var target = document.getElementById(targetId);
          if (target) {
            var panel = target.closest('.panel') || target;
            var panels = Array.from(document.querySelectorAll('.panel'));
            var idx = panels.indexOf(panel);
            if (idx >= 0) {
              window.voidGoToSection(idx);
            }
          }
        }
        if (attempts > 50) clearInterval(tryNav);
      }, 50);
    }
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!inHero) {
        setHeroState(false);
      }
    }, 200);
  });

  setHeroState(true);
  updateActive();
  handleInitialHash();

})();

// ── END NAVBAR ──
// ── END NAVBAR ──


 // ── navbar end ──
// ── navbar end ──
  // ── navbar end ──
// ── FIX INTERNAL HASH LINKS ──
(function() {
  'use strict';
  
  // Wait for Velora to be ready
  function fixHashLinks() {
    if (typeof window.voidGoToSection !== 'function') {
      setTimeout(fixHashLinks, 100);
      return;
    }
    
    // Find all links that point to a hash on the same page
    document.addEventListener('click', function(e) {
      var link = e.target.closest('a');
      if (!link) return;
      
      var href = link.getAttribute('href');
      if (!href) return;
      
      // Only handle same-page hash links (starts with #)
      if (href.startsWith('#') && href.length > 1) {
        e.preventDefault();
        e.stopPropagation();
        
        var targetId = href.substring(1);
        var target = document.getElementById(targetId);
        
        if (target) {
          var panel = target.closest('.panel') || target;
          var panels = Array.from(document.querySelectorAll('.panel'));
          var idx = panels.indexOf(panel);
          
          if (idx >= 0) {
            window.voidGoToSection(idx);
          }
        }
      }
      
      // Also handle full path with hash (same page)
      if (href.includes('#') && !href.startsWith('#')) {
        var parts = href.split('#');
        var hashPart = parts[parts.length - 1];
        var pathPart = parts[0];
        
        // Check if it's the same page
        var currentPath = window.location.pathname.replace(/\\/g, '/');
        var linkPath = pathPart.replace(/\\/g, '/');
        
        if (!linkPath || currentPath.endsWith(linkPath.split('/').pop())) {
          e.preventDefault();
          e.stopPropagation();
          
          var target = document.getElementById(hashPart);
          if (target) {
            var panel = target.closest('.panel') || target;
            var panels = Array.from(document.querySelectorAll('.panel'));
            var idx = panels.indexOf(panel);
            
            if (idx >= 0) {
              window.voidGoToSection(idx);
            }
          }
        }
      }
    });
    
    console.log('[HASH FIX] Internal hash links now use Velora navigation');
  }
  
  fixHashLinks();
})();
// ── END FIX INTERNAL HASH LINKS ──
  // ── PASTE SECTION BUTTONS BELOW ──

  // ── END SECTION BUTTONS ──

  function initSectionButtons() {
    document.querySelectorAll('[data-next]').forEach(function (el) {
      el.addEventListener('click', function () { moveTo(1); });
    });
    document.querySelectorAll('[data-prev]').forEach(function (el) {
      el.addEventListener('click', function () { moveTo(-1); });
    });
  }

  // ── PASTE STATS COUNTER BELOW ──

  // ── END STATS COUNTER ──

  function initStatCounters() { /* stub */ }

  // ── PASTE DEEP LINK BELOW ──

  // ── END DEEP LINK ──

  function handleDeepLink() {
    var hash = window.location.hash.replace('#', '');
    if (!hash) return;
    var target = document.getElementById(hash);
    if (!target) return;
    var idx = panels.indexOf(target.closest ? target.closest('.panel') : null);
    if (idx > 0) setTimeout(function () { goTo(idx); }, 400);
  }

  // ── PASTE HERO (#section-1) BELOW ──







// ── PASTE SECTION-HERO BELOW ──

(function () {
  'use strict';

  var section = document.getElementById('section-landing');
  if (!section) {
    console.warn('[WH Hero] #section-landing not found');
    return;
  }

  var content = document.getElementById('hero-content');
  var scrollInd = document.getElementById('hero-scroll-ind');

  /* ── Reveal content on load ── */
  if (content) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        content.classList.add('h-content--visible');
      });
    });
  }

  /* ── Scroll indicator auto-hide ── */
  if (scrollInd) {
    var hidden = false;
    function hideInd() {
      if (hidden) return;
      hidden = true;
      scrollInd.classList.add('h-scroll-ind--hidden');
    }
    window.addEventListener('wheel', hideInd, { once: true, passive: true });
    window.addEventListener('touchmove', hideInd, { once: true, passive: true });
    window.addEventListener('keydown', function (e) {
      if ([' ', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].indexOf(e.key) > -1) hideInd();
    }, { once: true });
    setTimeout(hideInd, 9000);
  }

  /* ── Entrance / Exit ── */
  function enter() { section.classList.add('is-visible'); }
  function exit() { section.classList.remove('is-visible'); }

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (entry.isIntersecting) enter();
        else exit();
      });
    }, { threshold: 0.15 });
    io.observe(section);
  }

  /* ── Patch engine ── */
  (function patchGoTo() {
    var attempts = 0;
    var poll = setInterval(function () {
      attempts++;
      if (typeof window.voidGoToSection === 'function') {
        var orig = window.voidGoToSection;
        var panels = null;
        window.voidGoToSection = function (idx) {
          if (!panels) panels = Array.from(document.querySelectorAll('.panel'));
          var ours = panels.indexOf(section);
          if (idx !== ours && section.classList.contains('is-visible')) exit();
          orig(idx);
          if (idx === ours) setTimeout(enter, 60);
        };
        clearInterval(poll);
      }
      if (attempts > 30) clearInterval(poll);
    }, 80);
  }());

})();

// ── END SECTION-HERO ──


// ── PASTE SECTION-ABOUT BELOW ──

(function () {
  'use strict';

  var section = document.querySelector('.whs-services');
  if (!section) return;

  /* ── Easing ── */
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  /* ── Counter animation ── */
  function animateCounter(el, target, duration) {
    var start  = performance.now();
    var suffix = el.dataset.suffix || '';

    function tick(now) {
      var progress = Math.min((now - start) / duration, 1);
      var val = Math.round(easeOutCubic(progress) * target);
      el.textContent = val.toLocaleString() + suffix;
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function runCounters() {
    section.querySelectorAll('.whs-proof__value').forEach(function (el) {
      var target = parseInt(el.dataset.target, 10);
      if (isNaN(target)) return;
      animateCounter(el, target, 1000);
    });
  }

  function resetCounters() {
    section.querySelectorAll('.whs-proof__value').forEach(function (el) {
      var suffix = el.dataset.suffix || '';
      el.textContent = '0' + suffix;
    });
  }

  /* ── Entrance / exit — replay every visit ── */
  function enter() {
    section.classList.add('is-visible');
    setTimeout(runCounters, 520);
  }

  function exit() {
    section.classList.remove('is-visible');
    resetCounters();
  }

  /* ── Detection ── */
  var scrollContainer = document.getElementById('scroll-container');
  var TOLERANCE = 80;

  function checkActive() {
    if (!scrollContainer) return;
    var diff   = Math.abs(scrollContainer.scrollTop - section.offsetTop);
    var active = diff <= TOLERANCE;
    if (active && !section.classList.contains('is-visible')) enter();
    if (!active && section.classList.contains('is-visible')) exit();
  }

  if (scrollContainer) {
    scrollContainer.addEventListener('scroll', checkActive, { passive: true });
  }

  /* ── Patch engine's voidGoToSection ── */
  (function patchGoTo() {
    var attempts = 0;
    var poll = setInterval(function () {
      attempts++;
      if (typeof window.voidGoToSection === 'function') {
        var orig = window.voidGoToSection;
        window.voidGoToSection = function (idx) {
          var panels  = Array.from(document.querySelectorAll('.panel'));
          var ourIdx  = panels.indexOf(section);
          if (idx !== ourIdx && section.classList.contains('is-visible')) exit();
          orig(idx);
          if (idx === ourIdx) setTimeout(enter, 60);
        };
        clearInterval(poll);
      }
      if (attempts > 30) clearInterval(poll);
    }, 80);
  }());

  /* ── Load safety ── */
  window.addEventListener('load', checkActive);

  /* ── Resize ── */
  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(checkActive, 200);
  });

}());

// ── END SECTION-ABOUT ──

// ── PASTE SECTION-SERVICES BELOW ──

(function () {
  'use strict';

  var section = document.getElementById('section-services');
  if (!section) return;

  var inner     = section.querySelector('.section-content');
  var routeLine = section.querySelector('.ab-route-line');
  var cards     = Array.from(section.querySelectorAll('.ab-card'));
  var stats     = Array.from(section.querySelectorAll('.ab-stats__item'));

  if (!inner) {
    console.warn('[Services] .section-content not found inside #section-services');
    return;
  }

  /* ── CONFIG ── */
  var CFG_SERVICES = {
    IN_DURATION : 0.85,
    IN_STAGGER  : 0.10,
    OUT_DURATION: 0.38,
    EASING_IN   : 'cubic-bezier(0.19, 1, 0.22, 1)',
    EASING_OUT  : 'cubic-bezier(0.55, 0, 1, 0.45)',
    SNAP_TOLERANCE : 30,
  };

  /* ── STATE ── */
  var _isActive    = false;
  var _inTimers    = [];
  var _outTimer    = null;

  /* ── HELPERS ── */
  function clearAllTimers() {
    _inTimers.forEach(function (t) { clearTimeout(t); });
    _inTimers = [];
    if (_outTimer) { clearTimeout(_outTimer); _outTimer = null; }
  }

  /* ── RESET all cards to hidden ── */
  function resetToHidden() {
    cards.forEach(function (card) {
      card.style.transition = 'none';
      card.classList.remove('ab-card--in');

      if (card.classList.contains('ab-card--left')) {
        card.style.opacity   = '0';
        card.style.transform = 'translateX(-90px) scale(0.96)';
      } else {
        card.style.opacity   = '0';
        card.style.transform = 'translateX(90px) scale(0.96)';
      }
      card.style.filter = 'blur(10px)';
      void card.offsetHeight;
    });

    if (routeLine) {
      routeLine.style.transition = 'none';
      routeLine.classList.remove('ab-route-line--active');
      routeLine.style.height  = '0';
      routeLine.style.opacity = '0';
      void routeLine.offsetHeight;
    }

    stats.forEach(function (s) {
      s.style.transition = 'none';
      s.style.opacity    = '0';
      s.style.transform  = 'translateY(20px)';
      void s.offsetHeight;
    });
  }

  /* ── ANIMATE IN (reveal cards as user scrolls) ── */
  function animateIn() {
    clearAllTimers();
    resetToHidden();

    var _revealed = [];
    cards.forEach(function () { _revealed.push(false); });
    var _revealedStats = false;

    function revealCard(card) {
      card.style.transition = [
        'opacity '   + CFG_SERVICES.IN_DURATION + 's ' + CFG_SERVICES.EASING_IN,
        'transform ' + CFG_SERVICES.IN_DURATION + 's ' + CFG_SERVICES.EASING_IN,
        'filter '    + CFG_SERVICES.IN_DURATION + 's ' + CFG_SERVICES.EASING_IN,
      ].join(', ');
      card.style.opacity   = '1';
      card.style.transform = 'translateX(0) scale(1)';
      card.style.filter    = 'blur(0)';
      card.classList.add('ab-card--in');
    }

    function checkCardsInView() {
      var scrollTop = inner.scrollTop;
      var clientHeight = inner.clientHeight;
      var allDone = true;

      var triggerLine = scrollTop + clientHeight * 0.85;

      cards.forEach(function (card, i) {
        if (_revealed[i]) return;

        var cardRect = card.getBoundingClientRect();
        var innerRect = inner.getBoundingClientRect();
        var cardRelativeTop = cardRect.top - innerRect.top + scrollTop;

        if (cardRelativeTop < triggerLine) {
          _revealed[i] = true;
          revealCard(card);
        } else {
          allDone = false;
        }
      });

      if (_revealed[0] && routeLine && !routeLine.classList.contains('ab-route-line--active')) {
        var rt = setTimeout(function () {
          routeLine.style.transition = 'height 1.3s ' + CFG_SERVICES.EASING_IN + ', opacity 0.8s ease';
          routeLine.classList.add('ab-route-line--active');
        }, 200);
        _inTimers.push(rt);
      }

      if (allDone && !_revealedStats) {
        _revealedStats = true;
        stats.forEach(function (s, i) {
          var st = setTimeout(function () {
            s.style.transition = 'opacity 0.75s ' + CFG_SERVICES.EASING_IN + ', transform 0.75s ' + CFG_SERVICES.EASING_IN;
            s.style.opacity    = '1';
            s.style.transform  = 'translateY(0)';
          }, (0.25 + i * 0.08) * 1000);
          _inTimers.push(st);
        });
        inner.removeEventListener('scroll', onInnerScroll);
      }
    }

    function onInnerScroll() {
      checkCardsInView();
    }

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        inner.addEventListener('scroll', onInnerScroll, { passive: true });
        checkCardsInView();
      });
    });
  }

  /* ── ANIMATE OUT ── */
  function animateOut() {
    clearAllTimers();
    inner.removeEventListener('scroll', onInnerScroll);

    cards.forEach(function (card, i) {
      var isLeft = card.classList.contains('ab-card--left');
      var exitX  = isLeft ? -40 : 40;
      var delay  = i * 0.04;

      card.style.transition = [
        'opacity '   + CFG_SERVICES.OUT_DURATION + 's ' + CFG_SERVICES.EASING_OUT + ' ' + delay + 's',
        'transform ' + CFG_SERVICES.OUT_DURATION + 's ' + CFG_SERVICES.EASING_OUT + ' ' + delay + 's',
        'filter '    + CFG_SERVICES.OUT_DURATION + 's ease ' + delay + 's',
      ].join(', ');
      card.style.opacity   = '0';
      card.style.transform = 'translateX(' + exitX + 'px) scale(0.97)';
      card.style.filter    = 'blur(4px)';
      card.classList.remove('ab-card--in');
    });

    if (routeLine) {
      routeLine.style.transition = 'opacity 0.3s ease';
      routeLine.style.opacity    = '0';
      routeLine.classList.remove('ab-route-line--active');
    }

    stats.forEach(function (s, i) {
      s.style.transition = 'opacity 0.3s ease ' + (i * 0.04) + 's, transform 0.3s ease ' + (i * 0.04) + 's';
      s.style.opacity    = '0';
      s.style.transform  = 'translateY(12px)';
    });
  }

  /* ── ENTRY / EXIT handlers ── */
  var servicesPanelIndex = -1;
  var allPanels = Array.from(document.querySelectorAll('.panel'));
  allPanels.forEach(function (p, i) {
    if (p.id === 'section-services') servicesPanelIndex = i;
  });

  function onSectionEnter() {
    if (_isActive) return;
    _isActive = true;
    if (inner) inner.scrollTop = 0;
    animateIn();
  }

  function onSectionExit() {
    if (!_isActive) return;
    _isActive = false;
    animateOut();
  }

  /* ── DETECTION ── */
  var container = document.getElementById('scroll-container');

  function checkActivePanel() {
    if (!container || servicesPanelIndex < 0) return;
    var servicesPanel = allPanels[servicesPanelIndex];
    if (!servicesPanel) return;

    var diff = Math.abs(container.scrollTop - servicesPanel.offsetTop);
    var isNowActive = diff <= CFG_SERVICES.SNAP_TOLERANCE;

    if (isNowActive && !_isActive) {
      onSectionEnter();
    } else if (!isNowActive && _isActive) {
      onSectionExit();
    }
  }

  if (container) {
    container.addEventListener('scroll', checkActivePanel, { passive: true });
  }

  /* ── PATCH voidGoToSection ── */
  (function patchGoTo() {
    var attempts = 0;
    var poller = setInterval(function () {
      attempts++;
      if (typeof window.voidGoToSection === 'function') {
        var orig = window.voidGoToSection;
        window.voidGoToSection = function (index) {
          if (index !== servicesPanelIndex && _isActive) {
            onSectionExit();
          }
          orig(index);
          if (index === servicesPanelIndex) {
            setTimeout(onSectionEnter, 50);
          }
        };
        clearInterval(poller);
      }
      if (attempts > 20) clearInterval(poller);
    }, 100);
  })();

  /* ── LOAD SAFETY ── */
  window.addEventListener('load', function () {
    checkActivePanel();
  });

  /* ── RESIZE ── */
  var _resizeT;
  window.addEventListener('resize', function () {
    clearTimeout(_resizeT);
    _resizeT = setTimeout(checkActivePanel, 220);
  });

  /* ── Initial hidden state ── */
  (function () {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', resetToHidden);
    } else {
      resetToHidden();
    }
  })();

})();

// ── END SECTION-SERVICES ──


// ── PASTE SECTION-REVIEWS BELOW ──

(function () {
  'use strict';

  var section = document.getElementById('section-reviews');
  if (!section) return;

  var track   = document.getElementById('whr-track');
  var cards   = Array.from(track.querySelectorAll('.whr-card'));
  var dots    = Array.from(document.querySelectorAll('.whr-dot'));
  var btnPrev = document.getElementById('whr-prev');
  var btnNext = document.getElementById('whr-next');
  var ctrEl   = document.getElementById('whr-current');
  var barEl   = document.getElementById('whr-bar-fill');

  var total    = cards.length;
  var current  = 0;
  var timer    = null;
  var rafId    = null;
  var t0       = null;
  var locked   = false;
  var paused   = false;

  function posFor(rel) {
    if (rel === 0)                        return 'center';
    if (rel === 1 || rel === -(total-1)) return 'right';
    if (rel === total-1 || rel === -1)   return 'left';
    if (rel === 2 || rel === -(total-2)) return 'far-right';
    if (rel === total-2 || rel === -2)   return 'far-left';
    return 'hidden';
  }

  function render(idx) {
    var i = ((idx % total) + total) % total;
    current = i;

    cards.forEach(function (card, c) {
      var rel = ((c - i) % total + total) % total;
      if (rel > Math.floor(total / 2)) rel -= total;
      var pos = posFor(rel);
      card.setAttribute('data-pos', pos);
      card.setAttribute('aria-hidden', pos !== 'center' ? 'true' : 'false');
    });

    dots.forEach(function (dot, d) {
      var on = d === i;
      dot.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    if (ctrEl) ctrEl.textContent = String(i + 1).padStart(2, '0');
  }

  function goTo(idx, byUser) {
    if (locked) return;
    locked = true;
    setTimeout(function () { locked = false; }, 700);
    render(idx);
    if (byUser) resetAuto();
  }
  function next(byUser) { goTo(current + 1, byUser); }
  function prev(byUser) { goTo(current - 1, byUser); }

  function startBar() {
    cancelAnimationFrame(rafId);
    t0 = performance.now();
    (function tick(now) {
      var pct = Math.min((now - t0) / 6000 * 100, 100);
      if (barEl) barEl.style.width = pct + '%';
      if (pct < 100) rafId = requestAnimationFrame(tick);
    })(t0);
  }
  function stopBar() {
    cancelAnimationFrame(rafId);
    if (barEl) barEl.style.width = '0%';
  }

  function startAuto() {
    clearInterval(timer);
    timer = setInterval(function () {
      if (!paused) { next(false); startBar(); }
    }, 6000);
    startBar();
  }
  function resetAuto() {
    clearInterval(timer);
    stopBar();
    if (!paused) startAuto();
  }
  function pause()  { paused = true;  clearInterval(timer); cancelAnimationFrame(rafId); }
  function resume() { paused = false; startAuto(); }

  var tx = null, ty = null;
  section.addEventListener('touchstart', function (e) {
    tx = e.touches[0].clientX;
    ty = e.touches[0].clientY;
    pause();
  }, { passive: true });
  section.addEventListener('touchend', function (e) {
    if (tx === null) return;
    var dx = e.changedTouches[0].clientX - tx;
    var dy = e.changedTouches[0].clientY - ty;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 34) {
      dx < 0 ? next(true) : prev(true);
    }
    tx = ty = null;
    resume();
  }, { passive: true });

  var mx = null, dragging = false;
  track.addEventListener('mousedown', function (e) { mx = e.clientX; dragging = false; pause(); });
  window.addEventListener('mousemove', function (e) {
    if (mx === null) return;
    if (Math.abs(e.clientX - mx) > 8) dragging = true;
  });
  window.addEventListener('mouseup', function (e) {
    if (mx === null) return;
    var dx = e.clientX - mx;
    if (dragging && Math.abs(dx) > 48) dx < 0 ? next(true) : prev(true);
    mx = null; dragging = false;
    resume();
  });
  track.addEventListener('dragstart', function (e) { e.preventDefault(); });

  cards.forEach(function (card) {
    card.addEventListener('click', function () {
      var pos = card.getAttribute('data-pos');
      if (pos === 'left') prev(true);
      else if (pos === 'right') next(true);
    });
  });

  if (btnPrev) btnPrev.addEventListener('click', function () { prev(true); });
  if (btnNext) btnNext.addEventListener('click', function () { next(true); });

  dots.forEach(function (dot, idx) {
    dot.addEventListener('click', function () { goTo(idx, true); });
    dot.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); prev(true); }
      if (e.key === 'ArrowRight') { e.preventDefault(); next(true); }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTo(idx, true); }
    });
  });

  section.addEventListener('keydown', function (e) {
    if (e.target.closest('.whr-dots')) return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); prev(true); }
    if (e.key === 'ArrowRight') { e.preventDefault(); next(true); }
  });

  var isTouch = 'ontouchstart' in window;
  if (!isTouch) {
    section.addEventListener('mouseenter', pause);
    section.addEventListener('mouseleave', resume);
  }
  section.addEventListener('focusin',  pause);
  section.addEventListener('focusout', function (e) {
    if (!section.contains(e.relatedTarget)) resume();
  });

  /* ── Intersection ── */
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          if (!paused) startAuto();
        } else {
          clearInterval(timer);
          stopBar();
        }
      });
    }, { threshold: 0.35 }).observe(section);
  }

  /* ── Patch engine ── */
  function patchEngine() {
    if (typeof window.voidGoToSection !== 'function') return false;
    var orig = window.voidGoToSection;
    var panels = null;
    window.voidGoToSection = function (idx) {
      if (!panels) panels = Array.from(document.querySelectorAll('.panel'));
      var ours = panels.indexOf(section);
      if (idx !== ours) {
        clearInterval(timer);
        stopBar();
      }
      orig(idx);
      if (idx === ours) {
        setTimeout(function () {
          render(0);
          startAuto();
        }, 80);
      }
    };
    return true;
  }

  if (!patchEngine()) {
    var tries = 0;
    var poll = setInterval(function () {
      if (patchEngine() || ++tries > 40) clearInterval(poll);
    }, 100);
  }

  render(0);
  startAuto();

  window.whrCarousel = {
    enter : function () { render(0); startAuto(); },
    exit  : function () { clearInterval(timer); stopBar(); },
    goTo  : function (i) { goTo(i, true); }
  };

})();

// ── END SECTION-REVIEWS ──



// ── PASTE SECTION-COVERAGE BELOW ──

(function () {
  'use strict';

  var section = document.getElementById('section-coverage');
  if (!section) return;

  var stats = section.querySelectorAll('.wha-stat__num');
  var isActive = false;
  var timer = null;

  function runCounters() {
    stats.forEach(function (el) {
      var text = el.textContent.trim();
      var numMatch = text.match(/([\d,]+)/);
      if (!numMatch) return;
      var target = parseInt(numMatch[1].replace(/,/g, ''), 10);
      if (isNaN(target)) return;
      var suffix = el.querySelector('.wha-stat__suffix');
      var suffixText = suffix ? ' ' + suffix.textContent.trim() : '';
      var dur = 1200;
      var start = null;

      function tick(ts) {
        if (!start) start = ts;
        var p = Math.min((ts - start) / dur, 1);
        var ease = 1 - Math.pow(1 - p, 4);
        var val = Math.round(target * ease);
        el.textContent = val.toLocaleString() + suffixText;
        if (p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  function resetCounters() {
    stats.forEach(function (el) {
      var suffix = el.querySelector('.wha-stat__suffix');
      var suffixText = suffix ? ' ' + suffix.textContent.trim() : '';
      el.textContent = '0' + suffixText;
    });
  }

  function enter() {
    if (isActive) return;
    isActive = true;
    section.classList.add('is-visible');
    timer = setTimeout(function () {
      runCounters();
    }, 200);
  }

  function exit() {
    if (!isActive) return;
    isActive = false;
    section.classList.remove('is-visible');
    resetCounters();
    clearTimeout(timer);
  }

  var io = null;

  function initObserver() {
    if (io) io.disconnect();

    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          clearTimeout(timer);
          timer = setTimeout(function () {
            enter();
          }, 100);
        } else {
          exit();
        }
      });
    }, { threshold: 0.15 });

    io.observe(section);
  }

  if ('IntersectionObserver' in window) {
    initObserver();
  } else {
    enter();
  }

  window.addEventListener('resize', function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (io) {
        io.disconnect();
        io.observe(section);
      }
    }, 300);
  });

  (function patchGoTo() {
    var attempts = 0;
    var poll = setInterval(function () {
      attempts++;
      if (typeof window.voidGoToSection === 'function') {
        var orig = window.voidGoToSection;
        var panels = null;
        window.voidGoToSection = function (idx) {
          if (!panels) panels = Array.from(document.querySelectorAll('.panel'));
          var ours = panels.indexOf(section);
          if (idx !== ours && section.classList.contains('is-visible')) {
            exit();
          }
          orig(idx);
          if (idx === ours) {
            setTimeout(function () {
              resetCounters();
              enter();
            }, 60);
          }
        };
        clearInterval(poll);
      }
      if (attempts > 30) clearInterval(poll);
    }, 80);
  }());

})();

// ── END SECTION-COVERAGE ──


// ── PASTE SECTION-FAQ BELOW ──

(function () {
  'use strict';

  var section = document.getElementById('section-faq');
  if (!section) return;

  var items = Array.from(section.querySelectorAll('.whf-item'));
  var clickables = Array.from(section.querySelectorAll('.whf-item__clickable'));

  function closeItem(item) {
    item.classList.remove('whf-item--open');
    var btn = item.querySelector('.whf-item__clickable');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function openItem(item) {
    item.classList.add('whf-item--open');
    var btn = item.querySelector('.whf-item__clickable');
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }

  clickables.forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      var item = btn.closest('.whf-item');
      var isOpen = item.classList.contains('whf-item--open');

      items.forEach(function (other) {
        if (other !== item) closeItem(other);
      });

      if (isOpen) {
        closeItem(item);
      } else {
        openItem(item);
      }
    });

    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        var item = btn.closest('.whf-item');
        var isOpen = item.classList.contains('whf-item--open');

        items.forEach(function (other) {
          if (other !== item) closeItem(other);
        });

        if (isOpen) {
          closeItem(item);
        } else {
          openItem(item);
        }
      }
    });
  });

  var revealTimers = [];

  function clearRevealTimers() {
    revealTimers.forEach(function (t) { clearTimeout(t); });
    revealTimers = [];
  }

  function resetReveal() {
    clearRevealTimers();
    items.forEach(function (item) {
      item.classList.remove('whf-item--visible');
    });
  }

  function playReveal() {
    clearRevealTimers();
    items.forEach(function (item, i) {
      var t = setTimeout(function () {
        item.classList.add('whf-item--visible');
      }, 90 * i);
      revealTimers.push(t);
    });
  }

  var observer = null;

  function initObserver() {
    if (observer) observer.disconnect();

    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          clearRevealTimers();
          playReveal();
        } else {
          resetReveal();
          items.forEach(function (item) { closeItem(item); });
        }
      });
    }, { threshold: 0.3 });

    observer.observe(section);
  }

  if ('IntersectionObserver' in window) {
    initObserver();
  } else {
    items.forEach(function (item) { item.classList.add('whf-item--visible'); });
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (observer) {
        observer.disconnect();
        observer.observe(section);
      }
    }, 300);
  });

  (function patchGoTo() {
    var attempts = 0;
    var poll = setInterval(function () {
      attempts++;
      if (typeof window.voidGoToSection === 'function') {
        var orig = window.voidGoToSection;
        var panels = null;
        window.voidGoToSection = function (idx) {
          if (!panels) panels = Array.from(document.querySelectorAll('.panel'));
          var ours = panels.indexOf(section);
          if (idx === ours) {
            setTimeout(function () {
              resetReveal();
              requestAnimationFrame(function () { playReveal(); });
            }, 55);
          } else {
            resetReveal();
            items.forEach(function (item) { closeItem(item); });
          }
          orig(idx);
        };
        clearInterval(poll);
      }
      if (attempts > 30) clearInterval(poll);
    }, 80);
  }());

})();

// ── END SECTION-FAQ ──


// ── PASTE SECTION-FOOTER BELOW ──

(function () {
  'use strict';

  var section = document.getElementById('footer');
  if (!section) return;

  var yearEl = document.getElementById('whfoot-year');
  var creditEl = section.querySelector('.whfoot-strip__credit');
  var ctaScreenEl = section.querySelector('.whfoot-cta-screen');
  var gridEl = section.querySelector('.whfoot-grid');
  var stripEl = section.querySelector('.whfoot-strip');
  var wrapEl = section.querySelector('.whfoot-wrap');
  var scrollHintEl = section.querySelector('.whfoot-scroll-hint');

  if (yearEl) {
    yearEl.textContent = new Date().getFullYear();
  }

  if (creditEl) {
    creditEl.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      window.open('https://veloraaxis.com', '_blank', 'noopener,noreferrer');
    });
  }

  var revealTimers = [];

  function clearRevealTimers() {
    revealTimers.forEach(function (t) { t && clearTimeout(t); });
    revealTimers = [];
  }

  function resetReveal() {
    clearRevealTimers();
    [ctaScreenEl, gridEl, stripEl].forEach(function (el) {
      if (el) {
        el.style.opacity = '0';
        el.style.transform = 'translateY(0)';
        el.style.transition = 'none';
      }
    });
    if (scrollHintEl) {
      scrollHintEl.style.opacity = '0';
      scrollHintEl.style.transition = 'none';
    }
  }

  function playReveal() {
    clearRevealTimers();

    if (ctaScreenEl) {
      void ctaScreenEl.offsetHeight;
      var t1 = setTimeout(function () {
        ctaScreenEl.style.transition = 'opacity 0.9s cubic-bezier(0.16, 1, 0.3, 1), transform 0.9s cubic-bezier(0.16, 1, 0.3, 1)';
        ctaScreenEl.style.opacity = '1';
        ctaScreenEl.style.transform = 'translateY(0)';
      }, 50);
      revealTimers.push(t1);
    }

    if (gridEl) {
      void gridEl.offsetHeight;
      var t2 = setTimeout(function () {
        gridEl.style.transition = 'opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1), transform 0.8s cubic-bezier(0.16, 1, 0.3, 1)';
        gridEl.style.opacity = '1';
        gridEl.style.transform = 'translateY(0)';
      }, 200);
      revealTimers.push(t2);
    }

    if (stripEl) {
      void stripEl.offsetHeight;
      var t3 = setTimeout(function () {
        stripEl.style.transition = 'opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1), transform 0.8s cubic-bezier(0.16, 1, 0.3, 1)';
        stripEl.style.opacity = '1';
        stripEl.style.transform = 'translateY(0)';
      }, 350);
      revealTimers.push(t3);
    }

    if (scrollHintEl) {
      void scrollHintEl.offsetHeight;
      var t4 = setTimeout(function () {
        scrollHintEl.style.transition = 'opacity 0.7s ease';
        scrollHintEl.style.opacity = '0.5';
      }, 650);
      revealTimers.push(t4);
    }
  }

  resetReveal();

  var footerIsVisible = false;

  if ('IntersectionObserver' in window && 'IntersectionObserverEntry' in window) {
    var observerTimeout;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        clearTimeout(observerTimeout);
        observerTimeout = setTimeout(function () {
          if (entry.isIntersecting) {
            footerIsVisible = true;
            playReveal();
            if (bttButton) showBTT();
          } else {
            footerIsVisible = false;
            resetReveal();
            if (bttButton) hideBTT();
          }
        }, 120);
      });
    }, {
      threshold: 0.1,
      rootMargin: '0px 0px -5% 0px'
    });

    observer.observe(section);

    window.addEventListener('beforeunload', function () {
      observer.disconnect();
      clearRevealTimers();
    }, { once: true });
  } else {
    playReveal();
  }

  if (wrapEl) {
    var touchStartY = 0;
    var touchStartScrollTop = 0;

    wrapEl.addEventListener('touchstart', function (e) {
      touchStartY = e.touches[0].clientY;
      touchStartScrollTop = wrapEl.scrollTop;
    }, { passive: true });

    wrapEl.addEventListener('touchmove', function (e) {
      var currentY = e.touches[0].clientY;
      var deltaY = touchStartY - currentY;
      var scrollTop = wrapEl.scrollTop;
      var maxScroll = wrapEl.scrollHeight - wrapEl.clientHeight;
      var isAtTop = scrollTop <= 0;
      var isAtBottom = scrollTop >= maxScroll - 1;

      if (isAtTop && deltaY < 0) return;
      if (isAtBottom && deltaY > 0) return;

      e.stopPropagation();
    }, { passive: true });

    wrapEl.addEventListener('wheel', function (e) {
      var scrollTop = wrapEl.scrollTop;
      var maxScroll = wrapEl.scrollHeight - wrapEl.clientHeight;
      var isAtTop = scrollTop <= 0;
      var isAtBottom = scrollTop >= maxScroll - 1;
      var scrollingUp = e.deltaY < 0;
      var scrollingDown = e.deltaY > 0;

      if (isAtTop && scrollingUp) return;
      if (isAtBottom && scrollingDown) return;

      e.stopPropagation();
    }, { passive: true });
  }

  var patchInterval = null;
  var patchAttempts = 0;
  var PATCH_MAX_RETRIES = 40;
  var PATCH_DELAY = 100;

  function patchEngine() {
    if (typeof window.voidGoToSection !== 'function') return false;

    var originalFn = window.voidGoToSection;
    var panelsCache = null;

    window.voidGoToSection = function (index) {
      if (!panelsCache) {
        panelsCache = Array.from(document.querySelectorAll('.panel'));
      }

      var ourIndex = panelsCache.indexOf(section);

      if (index === ourIndex) {
        footerIsVisible = true;
        if (bttButton) showBTT();
        setTimeout(function () {
          resetReveal();
          requestAnimationFrame(function () {
            requestAnimationFrame(playReveal);
          });
        }, 60);
      } else {
        footerIsVisible = false;
        if (bttButton) hideBTT();
        resetReveal();
      }

      return originalFn.call(this, index);
    };

    window.voidGoToSection.original = originalFn;
    return true;
  }

  function tryPatch() {
    if (patchEngine()) {
      if (patchInterval) {
        clearInterval(patchInterval);
        patchInterval = null;
      }
      return true;
    }

    patchAttempts++;
    if (patchAttempts >= PATCH_MAX_RETRIES) {
      clearInterval(patchInterval);
      patchInterval = null;
    }

    return false;
  }

  if (!patchEngine()) {
    patchInterval = setInterval(tryPatch, PATCH_DELAY);
  }

  if (wrapEl && scrollHintEl) {
    var hintHidden = false;
    wrapEl.addEventListener('scroll', function () {
      if (!hintHidden && wrapEl.scrollTop > 60) {
        hintHidden = true;
        scrollHintEl.style.transition = 'opacity 0.4s ease';
        scrollHintEl.style.opacity = '0';
      }
    }, { passive: true });
  }

  var bttButton = null;

  function createBackToTop() {
    var btn = document.createElement('button');
    btn.id = 'btt-btn';
    btn.setAttribute('aria-label', 'Back to top');
    btn.setAttribute('title', 'Back to top');
    btn.type = 'button';

    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 16V2M9 2L3 8M9 2L15 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var style = document.createElement('style');
    style.textContent = `
      #btt-btn {
        position: fixed; bottom: 28px; left: 28px; z-index: 99999;
        width: 46px; height: 46px; border-radius: 50%;
        border: 1px solid rgba(199,166,85,0.35);
        background: rgba(8,10,12,0.9);
        backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        opacity: 0; visibility: hidden; transform: translateY(12px);
        transition: opacity 0.3s ease, visibility 0.3s ease, transform 0.3s cubic-bezier(0.34,1.56,0.64,1);
        box-shadow: 0 4px 20px rgba(0,0,0,0.5); color: rgba(199,166,85,0.9);
        pointer-events: none; outline: none; user-select: none;
      }
      #btt-btn.show { opacity: 1; visibility: visible; transform: translateY(0); pointer-events: auto; }
      #btt-btn:hover { border-color: rgba(199,166,85,0.7); background: rgba(12,14,18,0.95); color: rgba(199,166,85,1); transform: translateY(-3px); }
      #btt-btn:active { transform: scale(0.95); }
      @media (max-width: 768px) { #btt-btn { bottom: 20px; left: 20px; width: 42px; height: 42px; } }
      @media (max-width: 480px) { #btt-btn { bottom: 16px; left: 16px; width: 40px; height: 40px; } }
    `;

    document.head.appendChild(style);
    document.body.appendChild(btn);

    function goToTop() {
      if (typeof window.voidGoToSection === 'function') {
        window.voidGoToSection(0);
        return;
      }
      var firstPanel = document.querySelector('.panel');
      if (firstPanel) {
        firstPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      var sc = document.getElementById('scroll-container');
      if (sc) {
        sc.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }

    btn.addEventListener('click', goToTop);
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        goToTop();
      }
    });

    return btn;
  }

  function showBTT() { if (bttButton) bttButton.classList.add('show'); }
  function hideBTT() { if (bttButton) bttButton.classList.remove('show'); }

  bttButton = createBackToTop();

  if (typeof window.footerAPI === 'undefined') {
    window.footerAPI = {
      reveal: playReveal,
      reset: resetReveal,
      scrollToTop: function () {
        if (typeof window.voidGoToSection === 'function') {
          window.voidGoToSection(0);
        } else {
          var sc = document.getElementById('scroll-container');
          if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' });
          else window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      },
      destroy: function () {
        clearRevealTimers();
        if (patchInterval) clearInterval(patchInterval);
        if (bttButton && bttButton.parentNode) {
          bttButton.parentNode.removeChild(bttButton);
        }
      }
    };
  }

})();












  /* ============================================================
     ⓳  MAIN INIT
  ============================================================ */
  function init() {
    if (!container) { console.error('[VELORA] Fatal: #scroll-container missing'); return; }
    if (!dotList)   { console.warn('[VELORA] #dot-list missing — dots skipped'); }

    container.scrollTop = 0;
    S.current           = 0;

    assignBackgrounds();
    if (TOTAL > 0) buildDots();

    // Native CSS scroll-snap (style.css) handles wheel/touch/trackpad/
    // keyboard scrolling physics directly — no listeners needed here.
    initSectionObserver();

    window.addEventListener('keydown', onKeydown);
    window.addEventListener('resize',  onResize);

    if (typeof initLoader         === 'function') initLoader();
    if (typeof initNavbar         === 'function') initNavbar();
    if (typeof initSectionButtons === 'function') initSectionButtons();
    if (typeof initStatCounters   === 'function') initStatCounters();
    if (typeof handleDeepLink     === 'function') handleDeepLink();

    console.log('[VELORA] v8 ready — ' + TOTAL + ' panels | native CSS scroll-snap (' +
      (IS_TOUCH ? 'touch' : 'PC') + ')');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 50); });
  } else {
    setTimeout(init, 50);
  }

  window.addEventListener('pagehide', function () {
    window.removeEventListener('keydown', onKeydown);
    window.removeEventListener('resize',  onResize);
    clearTimeout(moveLockTimer);
  });

}());
