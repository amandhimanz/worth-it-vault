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
     ❶  CONSTANTS
  ============================================================ */
  var CFG = {
    MOVE_COOLDOWN       : 550,   // ms — section transition lock duration (was 700 — felt sluggish)
    EDGE_TOLERANCE      : 6,     // px — how close to edge counts as "at boundary"
    SWIPE_THRESHOLD     : 45,    // px — minimum swipe for fit-viewport panels (no inner scroll)
    OVERLAY_DURATION    : 150,   // ms — flash overlay visible time

    // PC inner-scroll easing (wheel-driven, JS-owned rAF loop)
    WHEEL_STEP_GAIN      : 0.42,  // how much of each wheel delta becomes added velocity (higher = punchier response)
    WHEEL_FRICTION       : 0.88,  // velocity decay per animation frame (lower = settles faster, less "heavy" drift)
    WHEEL_MIN_VELOCITY   : 0.05,  // px/frame — below this, the animation loop stops itself
    WHEEL_MAX_VELOCITY   : 34,    // px/frame cap — keeps one aggressive wheel tick from launching too far
    WHEEL_ACCUM_FOR_SNAP : 70,    // px of "pushing past the edge" needed before section changes (was 90 — took too long to trigger)
    WHEEL_BOUNDARY_DECAY : 300,   // ms — reset boundary-push accumulator if wheel goes idle

    // Touch: on touchend we compare how far the finger travelled to how
    // far the content actually scrolled during that same touch. Once an
    // edge is hit the content can't absorb any more, so that gap
    // ("pull") is what confirms intent to leave the section — checked
    // live on every touch, no settle wait and no requirement that it be
    // a new, separate touch. A fast flick needs less pull to confirm,
    // since speed alone already signals intent.
    TOUCH_PULL_THRESHOLD       : 18,   // px of "un-absorbable" drag needed at the edge to snap (was 24)
    TOUCH_FLICK_VELOCITY       : 0.45, // px/ms — drags at or above this speed count as a flick (was 0.5)
    TOUCH_FLICK_PULL_THRESHOLD : 8,    // px of pull needed at the edge when it's a fast flick (was 10)
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
  var smoothToggle = document.getElementById('smooth-toggle');
  var TOTAL        = panels.length;

  console.log('[VELORA] ' + TOTAL + ' panels — ' + (IS_TOUCH ? 'TOUCH' : 'PC') + ' mode');


  /* ============================================================
     ❹  STATE
  ============================================================ */
  var S = {
    current      : 0,
    moving       : false,
    globalSmooth : false,
    wheel        : { locked: false, lockTimer: null, snapAcc: 0, snapTimer: null },
    panelState   : [],   // per-panel runtime state, indexed by panel index
  };

  panels.forEach(function () {
    S.panelState.push({
      velocity      : 0,     // current eased-scroll velocity (px/frame), PC only
      raf           : null,  // active requestAnimationFrame id, PC only
      boundaryAcc   : 0,     // accumulated "push past edge" amount (px), PC only
      boundaryTimer : null,
      // _touchCleanup and _resetTouchRest are assigned later by
      // initTouchHandlers() (touch only) — left undefined on PC.
    });
  });


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
     ❻  INNER-SCROLL HELPERS
  ============================================================ */
  function getContent(idx) {
    var p = panels[idx];
    return p ? p.querySelector('.section-content') : null;
  }

  function resetScroll(idx) {
    var c = getContent(idx);
    if (c) c.scrollTop = 0;
  }

  function scrollRange(idx) {
    var c = getContent(idx);
    if (!c) return 0;
    var r = c.scrollHeight - c.clientHeight;
    return r > 0 ? r : 0;
  }

  function isScrollable(idx) {
    return scrollRange(idx) > CFG.EDGE_TOLERANCE;
  }

  function isAtTop(idx) {
    var c = getContent(idx);
    if (!c) return true;
    return c.scrollTop <= CFG.EDGE_TOLERANCE;
  }

  function isAtBottom(idx) {
    var c = getContent(idx);
    if (!c) return true;
    if (!isScrollable(idx)) return true;
    return c.scrollTop >= (c.scrollHeight - c.clientHeight - CFG.EDGE_TOLERANCE);
  }

  /** PC: should this panel use the JS-eased inner-scroll system? */
  function wantsSmooth(idx) {
    if (IS_TOUCH) return false;
    var p = panels[idx];
    if (!p) return false;
    return (S.globalSmooth || p.dataset.smooth === 'true') && isScrollable(idx);
  }

  function resetPanelGestureState(idx) {
    var st = S.panelState[idx];
    if (!st) return;
    st.boundaryAcc  = 0;
    st.velocity     = 0;
    clearTimeout(st.boundaryTimer);
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = null; }
    if (st._resetTouchRest) st._resetTouchRest();
  }


  /* ============================================================
     ❼  CORE NAVIGATION
  ============================================================ */
  function flashOverlay() {
    if (!overlay) return;
    overlay.classList.add('flash');
    setTimeout(function () { overlay.classList.remove('flash'); }, CFG.OVERLAY_DURATION);
  }

  function moveTo(direction) {
    if (S.moving) return false;
    var next = S.current + direction;
    if (next < 0 || next >= TOTAL) return false;

    resetScroll(next);
    resetPanelGestureState(next);

    S.moving  = true;
    S.current = next;
    flashOverlay();
    updateDots(next);
    container.scrollTo({ top: panels[next].offsetTop, behavior: 'smooth' });

    setTimeout(function () {
      if (panels[S.current]) container.scrollTop = panels[S.current].offsetTop;
      S.moving = false;
    }, CFG.MOVE_COOLDOWN);

    return true;
  }

  function goTo(index) {
    if (index === S.current || S.moving) return;
    if (index < 0 || index >= TOTAL) return;

    resetScroll(index);
    resetPanelGestureState(index);

    S.moving  = true;
    S.current = index;
    flashOverlay();
    updateDots(index);
    container.scrollTo({ top: panels[index].offsetTop, behavior: 'smooth' });

    setTimeout(function () {
      if (panels[S.current]) container.scrollTop = panels[S.current].offsetTop;
      S.moving = false;
    }, CFG.MOVE_COOLDOWN);
  }

  window.voidGoToSection = goTo;


  /* ============================================================
     ❽  PC — EASED INNER SCROLL  (rAF momentum loop)
     ──────────────────────────────────────────────────────────
     Each wheel tick on a smooth-mode panel adds to that panel's
     velocity. A requestAnimationFrame loop runs while velocity
     is non-trivial, moving scrollTop by `velocity` each frame
     and decaying velocity by WHEEL_FRICTION — this is what
     actually produces the eased/momentum feel. The browser's
     own scrolling is never used for this (we always
     preventDefault on smooth-mode wheel events).
  ============================================================ */
  function addWheelVelocity(idx, deltaY) {
    var st = S.panelState[idx];
    if (!st) return;
    st.velocity += deltaY * CFG.WHEEL_STEP_GAIN;
    var cap = CFG.WHEEL_MAX_VELOCITY;
    if (st.velocity > cap) st.velocity = cap;
    if (st.velocity < -cap) st.velocity = -cap;
    if (!st.raf) _runEaseLoop(idx);
  }

  function _runEaseLoop(idx) {
    var st = S.panelState[idx];
    var c  = getContent(idx);
    if (!st || !c) return;

    function step() {
      st.raf = null;
      if (idx !== S.current) { st.velocity = 0; return; } // panel changed mid-flight

      var range = scrollRange(idx);
      var next  = c.scrollTop + st.velocity;
      next = Math.max(0, Math.min(range, next));
      c.scrollTop = next;

      st.velocity *= CFG.WHEEL_FRICTION;

      if (Math.abs(st.velocity) > CFG.WHEEL_MIN_VELOCITY) {
        st.raf = requestAnimationFrame(step);
      } else {
        st.velocity = 0;
      }
    }
    st.raf = requestAnimationFrame(step);
  }


  /* ============================================================
     ❾  PC — WHEEL HANDLER (single listener, owns everything)
     ──────────────────────────────────────────────────────────
     SNAP-MODE panels (no smooth flag, or content doesn't
     overflow): preventDefault always; accumulate delta; snap
     once the accumulated delta crosses a threshold.

     SMOOTH-MODE panels: preventDefault always too — but instead
     of handing the tick to the browser, we feed it into the
     eased rAF loop above. While there's room left to scroll,
     wheel input only eases the inner content — it can't leak
     into a section change. Only once the user is already
     pinned at the top/bottom edge AND keeps scrolling outward
     does a separate "boundary push" accumulator fill up and
     trigger moveTo().
  ============================================================ */
  function onWheel(e) {
    if (IS_TOUCH) return;
    if (S.moving || S.wheel.locked) { e.preventDefault(); return; }

    var idx = S.current;

    if (!wantsSmooth(idx)) {
      e.preventDefault();
      _snapModeWheel(e.deltaY);
      return;
    }

    e.preventDefault();

    var st       = S.panelState[idx];
    var atBottom = isAtBottom(idx);
    var atTop    = isAtTop(idx);

    if (e.deltaY > 0 && atBottom && idx < TOTAL - 1) {
      _accumulateBoundaryPush(idx, e.deltaY);
      return;
    }
    if (e.deltaY < 0 && atTop && idx > 0) {
      _accumulateBoundaryPush(idx, e.deltaY);
      return;
    }

    // Not pinned at an outward edge — this tick is normal inner
    // scrolling, so clear any stale boundary-push accumulation
    // and feed the eased scroll loop instead.
    if (st) { st.boundaryAcc = 0; clearTimeout(st.boundaryTimer); }
    addWheelVelocity(idx, e.deltaY);
  }

  function _accumulateBoundaryPush(idx, deltaY) {
    var st = S.panelState[idx];
    if (!st) return;
    st.boundaryAcc += Math.abs(deltaY);
    clearTimeout(st.boundaryTimer);

    if (st.boundaryAcc >= CFG.WHEEL_ACCUM_FOR_SNAP) {
      var dir = deltaY > 0 ? 1 : -1;
      st.boundaryAcc = 0;
      if (moveTo(dir)) _lockWheel();
      return;
    }
    st.boundaryTimer = setTimeout(function () {
      st.boundaryAcc = 0;
    }, CFG.WHEEL_BOUNDARY_DECAY);
  }

  function _snapModeWheel(deltaY) {
    var w = S.wheel;
    w.snapAcc += deltaY;
    clearTimeout(w.snapTimer);
    if (Math.abs(w.snapAcc) >= CFG.WHEEL_ACCUM_FOR_SNAP) {
      var dir = w.snapAcc > 0 ? 1 : -1;
      w.snapAcc = 0;
      if (moveTo(dir)) _lockWheel();
    } else {
      w.snapTimer = setTimeout(function () { w.snapAcc = 0; }, CFG.WHEEL_BOUNDARY_DECAY);
    }
  }

  function _lockWheel() {
    var w    = S.wheel;
    w.locked = true;
    w.snapAcc = 0;
    clearTimeout(w.lockTimer);
    w.lockTimer = setTimeout(function () { w.locked = false; }, CFG.MOVE_COOLDOWN);
  }


  /* ============================================================
     ❿  TOUCH — BOUNDARY-AWARE SINGLE SWIPE
     ──────────────────────────────────────────────────────────
     The browser scrolls .section-content natively on touch —
     that's already smooth (native momentum), so we never touch
     scrollTop ourselves here. What we control is WHEN reaching
     a boundary is allowed to advance to the next section — and
     that's now decided on the SAME touch that reaches it, live,
     with no settle wait and no requirement that it be a second,
     separate touch.

     On touchend we compare two distances covering the same touch:
       • dY           — how far the finger actually travelled
       • actualScroll — how far the content itself scrolled

     While there's room left to scroll, those two stay roughly
     equal. Once the content hits the top/bottom edge it can't
     absorb any more of the drag, so the gap between them — the
     PULL — starts growing in real time. Once PULL crosses
     TOUCH_PULL_THRESHOLD while sitting at the relevant edge, that
     single touch snaps immediately on release. A fast flick needs
     less pull (TOUCH_FLICK_PULL_THRESHOLD) since speed alone
     already signals intent.

     This keeps the important guarantee from before — a normal
     reading swipe that merely reaches the edge still just comes
     to rest, it doesn't yank you into the next section — but
     drops the artificial two-touch requirement that made every
     transition feel like it needed a "warm-up" swipe first. It
     also fixes the up-direction specifically: PULL is measured
     fresh against this touch's own scroll delta, not a cached
     flag that only got set by a previous scroll event, so
     swiping back up the instant you arrive at a fresh panel
     (scrollTop already 0, nothing left to absorb the drag) works
     on the very first attempt — same as reaching the bottom
     after reading does.
  ============================================================ */
  var touchLocked = false;
  function _lockTouchBriefly() {
    touchLocked = true;
    setTimeout(function () { touchLocked = false; }, CFG.MOVE_COOLDOWN);
  }

  function initTouchHandlers() {

    panels.forEach(function (panel, idx) {
      var c = panel.querySelector('.section-content');
      if (!c) return;

      var startY        = null;  // finger clientY at touchstart
      var scrollAtStart = 0;     // c.scrollTop at touchstart
      var startTime     = 0;     // e.timeStamp at touchstart

      function onStart(e) {
        if (S.moving || touchLocked || idx !== S.current) return;
        if (e.touches.length > 1) return; // ignore pinch/multi-touch
        startY        = e.touches[0].clientY;
        scrollAtStart = c.scrollTop;
        startTime     = e.timeStamp;
      }

      function onEnd(e) {
        if (startY === null) return;
        var fromY      = startY;
        var fromScroll = scrollAtStart;
        var fromTime   = startTime;
        startY = null;
        if (S.moving || touchLocked || idx !== S.current) return;

        var endY = e.changedTouches[0].clientY;
        var dY   = fromY - endY; // positive = dragged up = wants next section

        // ── Sections with no inner scroll at all (e.g. Hero) ──
        // Plain swipe-to-change-section, single motion.
        if (!isScrollable(idx)) {
          if (Math.abs(dY) < CFG.SWIPE_THRESHOLD) return;
          var dir = dY > 0 ? 1 : -1;
          if (dir === 1 && idx < TOTAL - 1) { if (moveTo(1)) _lockTouchBriefly(); }
          else if (dir === -1 && idx > 0)   { if (moveTo(-1)) _lockTouchBriefly(); }
          return;
        }

        // ── Scrollable sections: PULL = finger travel the content
        //    couldn't absorb. Only grows once an edge is hit. ──
        var actualScroll = c.scrollTop - fromScroll;
        var pull         = Math.abs(dY) - Math.abs(actualScroll);

        var elapsed  = Math.max(1, e.timeStamp - fromTime);
        var velocity = Math.abs(dY) / elapsed; // px/ms
        var needed   = velocity >= CFG.TOUCH_FLICK_VELOCITY
          ? CFG.TOUCH_FLICK_PULL_THRESHOLD
          : CFG.TOUCH_PULL_THRESHOLD;

        if (pull < needed) return;

        if (dY > 0 && isAtBottom(idx) && idx < TOTAL - 1) {
          if (moveTo(1)) _lockTouchBriefly();
          return;
        }
        if (dY < 0 && isAtTop(idx) && idx > 0) {
          if (moveTo(-1)) _lockTouchBriefly();
        }
      }

      c.addEventListener('touchstart', onStart, { passive: true });
      c.addEventListener('touchend',   onEnd,   { passive: true });

      S.panelState[idx]._touchCleanup = function () {
        c.removeEventListener('touchstart', onStart);
        c.removeEventListener('touchend', onEnd);
      };

      S.panelState[idx]._resetTouchRest = function () {
        startY = null;
      };
    });
  }


  /* ============================================================
     ⓬  PC — HYBRID SWIPE (trackpad tablets, Surface, etc.)
         IS_TOUCH === false but touch events fire.
  ============================================================ */
  var hybrid = { startY: null, startX: null, locked: false };

  function onHybridTouchStart(e) {
    if (IS_TOUCH || e.touches.length > 1) return;
    hybrid.startY = e.touches[0].clientY;
    hybrid.startX = e.touches[0].clientX;
  }

  function onHybridTouchEnd(e) {
    if (IS_TOUCH || hybrid.startY === null) return;
    if (S.moving || hybrid.locked) { hybrid.startY = null; hybrid.startX = null; return; }

    var dY = hybrid.startY - e.changedTouches[0].clientY;
    var dX = hybrid.startX - e.changedTouches[0].clientX;
    hybrid.startY = null; hybrid.startX = null;

    if (Math.abs(dX) > Math.abs(dY) || Math.abs(dY) < CFG.SWIPE_THRESHOLD) return;

    var dir = dY > 0 ? 1 : -1;
    if (wantsSmooth(S.current)) {
      if (dir === 1 && !isAtBottom(S.current)) return;
      if (dir === -1 && !isAtTop(S.current)) return;
    }

    if (moveTo(dir)) {
      hybrid.locked = true;
      setTimeout(function () { hybrid.locked = false; }, CFG.MOVE_COOLDOWN);
    }
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
  var DOT_LABELS = [
    'HOME', 'PROCESS', 'SHIPMENT', 'CARRER', 'FOOTER',
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
        if (!S.moving) goTo(i);
      });
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!S.moving) goTo(i);
        }
      });
      dotList.appendChild(li);
    });
    if (dotNav) dotNav.classList.add('visible');
  }


  /* ============================================================
     ⓯  PC SMOOTH TOGGLE  (#smooth-toggle)
  ============================================================ */
  function initSmoothToggle() {
    if (!smoothToggle || IS_TOUCH) return;

    var stored = localStorage.getItem('velora-smooth');
    if (stored === 'on') {
      S.globalSmooth = true;
      smoothToggle.classList.add('active');
      smoothToggle.setAttribute('aria-checked', 'true');
      document.documentElement.classList.add('velora-smooth-all');
    }

    smoothToggle.addEventListener('click', function () {
      S.globalSmooth = !S.globalSmooth;
      smoothToggle.classList.toggle('active', S.globalSmooth);
      smoothToggle.setAttribute('aria-checked', String(S.globalSmooth));
      localStorage.setItem('velora-smooth', S.globalSmooth ? 'on' : 'off');
      document.documentElement.classList.toggle('velora-smooth-all', S.globalSmooth);
      console.log('[VELORA] Global smooth:', S.globalSmooth ? 'ON' : 'OFF');
    });
  }


  /* ============================================================
     ⓰  PC SCROLL-DRIFT GUARD
  ============================================================ */
  function initDriftGuard() {
    if (IS_TOUCH) return;
    var driftTimer;
    container.addEventListener('scroll', function () {
      if (S.moving) return;
      clearTimeout(driftTimer);
      driftTimer = setTimeout(function () {
        var target = panels[S.current] ? panels[S.current].offsetTop : 0;
        if (Math.abs(container.scrollTop - target) > 2) {
          container.scrollTop = target;
        }
      }, 60);
    }, { passive: true });
  }


  /* ============================================================
     ⓱  RESIZE
  ============================================================ */
  var resizeTimer;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      assignBackgrounds();
      if (!S.moving && !IS_TOUCH && panels[S.current]) {
        container.scrollTop = panels[S.current].offsetTop;
      }
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
  var HERO_SECTION_IDS = ['section-landing', 'section-landing-bc', 'section-booking', 'section-contact-form'];
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

  if (brand) {
    brand.addEventListener('click', function (e) {
      e.preventDefault();
      var homeUrl = 'index.html';
      if (window.location.pathname.includes('MAIN_SCROLL')) {
        homeUrl = '../PROJECT-1-TG/index.html';
      } else if (window.location.pathname.includes('page-3-tg')) {
        homeUrl = '../PROJECT-1-TG/index.html';
      }
      window.location.href = homeUrl;
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
          'landing-bc': 'section-landing-bc',
          'contact-form': 'section-contact-form',
          'email': 'section-email',
          'booking': 'section-booking',
          'careers': 'section-careers',
          'process': 'section-process',
          'office': 'section-office',
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
// ── PASTE SECTION-LANDING-BC BELOW ──
// ── PASTE SECTION-LANDING-BC BELOW ──

(function () {
  'use strict';

  var section = document.getElementById('section-landing-bc');
  if (!section) return;

  var content = document.getElementById('whbc-content');
  var scrollInd = document.getElementById('whbc-scroll-ind');

  /* ── Reveal content on load ── */
  if (content) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        content.classList.add('whbc-content--visible');
      });
    });
  }

  /* ── Scroll indicator auto-hide ── */
  if (scrollInd) {
    var hidden = false;
    function hideInd() {
      if (hidden) return;
      hidden = true;
      scrollInd.classList.add('whbc-scroll-ind--hidden');
    }
    window.addEventListener('wheel', hideInd, { once: true, passive: true });
    window.addEventListener('touchmove', hideInd, { once: true, passive: true });
    window.addEventListener('keydown', function (e) {
      if ([' ', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].indexOf(e.key) > -1) hideInd();
    }, { once: true });
    setTimeout(hideInd, 9000);
  }

  /* ── Cards navigation ── */
  var bookCard = section.querySelector('.whbc-card--gold');
  var careerCard = section.querySelector('.whbc-card--dark');

  // Section mapping
  var SECTION_MAP = {
    'booking': 2,    // #section-booking is the 3rd panel (0-indexed)
    'careers': 3     // #section-careers is the 4th panel (0-indexed)
  };

  function goToSection(sectionKey) {
    var targetIndex = SECTION_MAP[sectionKey];
    if (targetIndex === undefined) return;

    if (typeof window.voidGoToSection === 'function') {
      window.voidGoToSection(targetIndex);
    } else {
      // Fallback: find the panel and scroll
      var panels = Array.from(document.querySelectorAll('.panel'));
      var targetPanel = panels[targetIndex];
      if (targetPanel) {
        targetPanel.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }

  if (bookCard) {
    bookCard.addEventListener('click', function (e) {
      e.preventDefault();
      goToSection('booking');
    });
  }

  if (careerCard) {
    careerCard.addEventListener('click', function (e) {
      e.preventDefault();
      goToSection('careers');
    });
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

// ── END SECTION-LANDING-BC ──
// ── END SECTION-LANDING-BC ──

  // ── END HERO (#section-1) ──

  // ── PASTE SECTION-2 (#section-2) BELOW ──
// ── PASTE SECTION-PROCESS BELOW ──

(function () {
  'use strict';

  var section = document.getElementById('section-process');
  if (!section) return;

  var header = section.querySelector('.whpr-header');
  var steps = section.querySelectorAll('.whpr-step');
  var cta = section.querySelector('.whpr-cta');

  function resetReveal() {
    var els = [];
    if (header) els.push(header);
    steps.forEach(function(s){ els.push(s); });
    if (cta) els.push(cta);
    els.forEach(function(el){
      el.style.opacity = '0';
      el.style.transform = 'translateY(25px)';
      el.style.transition = 'none';
    });
  }

  function playReveal() {
    var delay = 0;
    if (header) { header.offsetHeight; setTimeout(function(){ header.style.transition='opacity 0.6s ease, transform 0.6s ease'; header.style.opacity='1'; header.style.transform='translateY(0)'; }, delay); delay += 100; }
    steps.forEach(function(step, i){ step.offsetHeight; setTimeout(function(){ step.style.transition='opacity 0.5s ease, transform 0.5s ease'; step.style.opacity='1'; step.style.transform='translateY(0)'; }, delay + i * 70); });
    delay += steps.length * 70;
    if (cta) { cta.offsetHeight; setTimeout(function(){ cta.style.transition='opacity 0.5s ease, transform 0.5s ease'; cta.style.opacity='1'; cta.style.transform='translateY(0)'; }, delay); }
  }

  resetReveal();

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (entry.isIntersecting) { resetReveal(); playReveal(); }
        else { resetReveal(); }
      });
    }, { threshold: 0.15 });
    io.observe(section);
  } else { playReveal(); }

  function patchEngine() {
    if (typeof window.voidGoToSection !== 'function') return false;
    var orig = window.voidGoToSection, panels = null;
    window.voidGoToSection = function(idx){
      if (!panels) panels = Array.from(document.querySelectorAll('.panel'));
      var ours = panels.indexOf(section);
      if (idx === ours) { setTimeout(function(){ resetReveal(); requestAnimationFrame(function(){ requestAnimationFrame(playReveal); }); }, 55); }
      else { resetReveal(); }
      orig(idx);
    };
    return true;
  }
  if (!patchEngine()) { var tries=0; var poll=setInterval(function(){ if(patchEngine()||++tries>40) clearInterval(poll); },100); }

})();

// ── END SECTION-PROCESS ──



// ── PASTE SECTION-BOOKING BELOW ──

(function () {
  'use strict';

  var section = document.getElementById('section-booking');
  if (!section) return;

  var form = document.getElementById('whbk-form');
  var submitBtn = document.getElementById('whbk-submit-btn');
  var successEl = document.getElementById('whbk-success');
  var errorEl = document.getElementById('whbk-error');
  var errorText = document.getElementById('whbk-error-text');
  var successName = document.getElementById('whbk-success-name');
  var successBtn = document.getElementById('whbk-success-btn');
  var errorBtn = document.getElementById('whbk-error-btn');
  var mobileCta = document.getElementById('whbk-mobile-cta');
  var mobileCtaBtn = document.getElementById('whbk-mobile-cta-btn');

  function isTouchMobile() {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  }

  /* ── Helper: Scroll inside the section's content area ──
     Only used on desktop; mobile reflow is handled by CSS, so we skip it
     to avoid conflicts with snap‑scroll and potential crashes. */
  function scrollToSectionTop() {
    if (isTouchMobile()) return;                 // ← NO scroll on mobile
    var content = section.querySelector('.section-content');
    if (!content) return;
    try {
      content.scrollTop = 0;
    } catch (e) {
      // ignore if element is not scrollable for any reason
    }
  }

  /* ── Floating mobile submit bar (shows above keyboard) ── */
  function showMobileCta() {
    if (!mobileCta) return;
    mobileCta.classList.add('whbk-mobile-cta--visible');
    mobileCta.setAttribute('aria-hidden', 'false');
  }
  function hideMobileCta() {
    if (!mobileCta) return;
    mobileCta.classList.remove('whbk-mobile-cta--visible');
    mobileCta.setAttribute('aria-hidden', 'true');
  }

  if (form && mobileCta && mobileCtaBtn) {
    form.addEventListener('focusin', function (e) {
      if (!isTouchMobile()) return;
      if (!section.classList.contains('is-visible')) return;
      if (e.target.matches('input, select, textarea')) showMobileCta();
    });

    form.addEventListener('focusout', function () {
      setTimeout(function () {
        if (!form.contains(document.activeElement)) hideMobileCta();
      }, 60);
    });

    mobileCtaBtn.addEventListener('click', function () {
      if (submitBtn) submitBtn.click();
    });

    ['touchstart', 'touchend'].forEach(function (evt) {
      mobileCta.addEventListener(evt, function (e) { e.stopPropagation(); }, { passive: true });
    });
    mobileCta.addEventListener('touchmove', function (e) {
      e.stopPropagation();
      e.preventDefault();
    }, { passive: false });

    if (window.visualViewport) {
      var updateCtaOffset = function () {
        if (!isTouchMobile()) return;
        if (!mobileCta) return;
        var vv = window.visualViewport;
        var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        mobileCta.style.bottom = kb + 'px';
      };
      window.visualViewport.addEventListener('resize', updateCtaOffset);
      window.visualViewport.addEventListener('scroll', updateCtaOffset);
    }
  }

  /* ── Form Submission ── */
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var data = new FormData(form);

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add('whbk-submit--loading');
      }

      if (errorEl) errorEl.classList.remove('whbk-error--visible');
      if (successEl) successEl.classList.remove('whbk-success--visible');

      fetch('https://formspree.io/f/xeebraeo', {
        method: 'POST',
        body: data,
        headers: {
          'Accept': 'application/json'
        }
      })
      .then(function (response) {
        if (response.ok) {
          form.classList.add('whbk-form--hidden');
          hideMobileCta();
          var nameInput = document.getElementById('whbk-name');
          var firstName = nameInput ? nameInput.value.trim().split(' ')[0] : 'there';
          if (successName) successName.textContent = firstName;
          if (successEl) successEl.classList.add('whbk-success--visible');
          form.reset();
          setTimeout(scrollToSectionTop, 150);
        } else {
          return response.json().then(function (data) {
            throw new Error(data.error || 'Something went wrong — please try again.');
          });
        }
      })
      .catch(function (err) {
        if (errorText) errorText.textContent = err.message || 'Network error — check your connection.';
        if (errorEl) errorEl.classList.add('whbk-error--visible');
      })
      .finally(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove('whbk-submit--loading');
        }
      });
    });
  }

  /* ── Success button — reset form ── */
  if (successBtn) {
    successBtn.addEventListener('click', function () {
      if (successEl) successEl.classList.remove('whbk-success--visible');
      form.classList.remove('whbk-form--hidden');
      setTimeout(scrollToSectionTop, 100);
    });
  }

  /* ── Error button — retry ── */
  if (errorBtn) {
    errorBtn.addEventListener('click', function () {
      if (errorEl) errorEl.classList.remove('whbk-error--visible');
    });
  }

  /* ── Entrance / Exit ── */
  function enter() { section.classList.add('is-visible'); }
  function exit() { section.classList.remove('is-visible'); hideMobileCta(); }

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

// ── END SECTION-BOOKING ──

// ── PASTE SECTION-CAREERS BELOW ──

(function () {
  'use strict';

  var section = document.getElementById('section-careers');
  if (!section) return;

  var form = document.getElementById('whcr-form');
  var submitBtn = document.getElementById('whcr-submit-btn');
  var successEl = document.getElementById('whcr-success');
  var errorEl = document.getElementById('whcr-error');
  var errorText = document.getElementById('whcr-error-text');
  var successName = document.getElementById('whcr-success-name');
  var successBtn = document.getElementById('whcr-success-btn');
  var errorBtn = document.getElementById('whcr-error-btn');
  var mobileCta = document.getElementById('whcr-mobile-cta');
  var mobileCtaBtn = document.getElementById('whcr-mobile-cta-btn');

  function isTouchMobile() {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  }

  function scrollToSectionTop() {
    if (isTouchMobile()) return;
    var content = section.querySelector('.section-content');
    if (!content) return;
    try {
      content.scrollTop = 0;
    } catch (e) {}
  }

  function showMobileCta() {
    if (!mobileCta) return;
    mobileCta.classList.add('whcr-mobile-cta--visible');
    mobileCta.setAttribute('aria-hidden', 'false');
  }
  function hideMobileCta() {
    if (!mobileCta) return;
    mobileCta.classList.remove('whcr-mobile-cta--visible');
    mobileCta.setAttribute('aria-hidden', 'true');
  }

  if (form && mobileCta && mobileCtaBtn) {
    form.addEventListener('focusin', function (e) {
      if (!isTouchMobile()) return;
      if (!section.classList.contains('is-visible')) return;
      if (e.target.matches('input, select, textarea')) showMobileCta();
    });

    form.addEventListener('focusout', function () {
      setTimeout(function () {
        if (!form.contains(document.activeElement)) hideMobileCta();
      }, 60);
    });

    mobileCtaBtn.addEventListener('click', function () {
      if (submitBtn) submitBtn.click();
    });

    ['touchstart', 'touchend'].forEach(function (evt) {
      mobileCta.addEventListener(evt, function (e) { e.stopPropagation(); }, { passive: true });
    });
    mobileCta.addEventListener('touchmove', function (e) {
      e.stopPropagation();
      e.preventDefault();
    }, { passive: false });

    if (window.visualViewport) {
      var updateCtaOffset = function () {
        if (!isTouchMobile()) return;
        if (!mobileCta) return;
        var vv = window.visualViewport;
        var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        mobileCta.style.bottom = kb + 'px';
      };
      window.visualViewport.addEventListener('resize', updateCtaOffset);
      window.visualViewport.addEventListener('scroll', updateCtaOffset);
    }
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var data = new FormData(form);

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add('whcr-submit--loading');
      }

      if (errorEl) errorEl.classList.remove('whcr-error--visible');
      if (successEl) successEl.classList.remove('whcr-success--visible');

      fetch('https://formspree.io/f/xeebraeo', {
        method: 'POST',
        body: data,
        headers: {
          'Accept': 'application/json'
        }
      })
      .then(function (response) {
        if (response.ok) {
          form.classList.add('whcr-form--hidden');
          hideMobileCta();
          var nameInput = document.getElementById('whcr-name');
          var firstName = nameInput ? nameInput.value.trim().split(' ')[0] : 'there';
          if (successName) successName.textContent = firstName;
          if (successEl) successEl.classList.add('whcr-success--visible');
          form.reset();
          setTimeout(scrollToSectionTop, 150);
        } else {
          return response.json().then(function (data) {
            throw new Error(data.error || 'Something went wrong — please try again.');
          });
        }
      })
      .catch(function (err) {
        if (errorText) errorText.textContent = err.message || 'Network error — check your connection.';
        if (errorEl) errorEl.classList.add('whcr-error--visible');
      })
      .finally(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove('whcr-submit--loading');
        }
      });
    });
  }

  if (successBtn) {
    successBtn.addEventListener('click', function () {
      if (successEl) successEl.classList.remove('whcr-success--visible');
      form.classList.remove('whcr-form--hidden');
      setTimeout(scrollToSectionTop, 100);
    });
  }

  if (errorBtn) {
    errorBtn.addEventListener('click', function () {
      if (errorEl) errorEl.classList.remove('whcr-error--visible');
    });
  }

  function enter() { section.classList.add('is-visible'); }
  function exit() { section.classList.remove('is-visible'); hideMobileCta(); }

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (entry.isIntersecting) enter();
        else exit();
      });
    }, { threshold: 0.15 });
    io.observe(section);
  }

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

// ── END SECTION-CAREERS ──

// ── END SECTION-CAREERS ──
  // ── END SECTION-4 (DESIGN) ──
/* ============================================================
   WESTERN HAWK — CTA + FOOTER JS  vFINAL-FIXED
   - Dynamic year
   - Velora Axis credit opens in new tab
   - Reveal animations on scroll
   - IntersectionObserver
   - Engine patching for snap navigation
   - Smart scroll: footer scrolls freely, snap engine works
     when user tries to leave the section
   - Back to top button: ONLY visible when footer section
     is active/visible, hidden everywhere else
   ============================================================ */

(function () {

  var section = document.getElementById('footer');
  if (!section) return;

  var yearEl = document.getElementById('whfoot-year');
  var creditEl = section.querySelector('.whfoot-strip__credit');
  var ctaScreenEl = section.querySelector('.whfoot-cta-screen');
  var gridEl = section.querySelector('.whfoot-grid');
  var stripEl = section.querySelector('.whfoot-strip');
  var wrapEl = section.querySelector('.whfoot-wrap');
  var scrollHintEl = section.querySelector('.whfoot-scroll-hint');

  // ═══════════════ 1. DYNAMIC YEAR ═══════════════
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear();
  }

  // ═══════════════ 2. VELORA AXIS CREDIT CLICK ═══════════════
  if (creditEl) {
    creditEl.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      window.open('https://veloraaxis.com', '_blank', 'noopener,noreferrer');
    });
  }

  // ═══════════════ 3. REVEAL ANIMATION ═══════════════
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
        el.style.transform = 'translateY(30px)';
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
        ctaScreenEl.style.transition = 'opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1), transform 0.8s cubic-bezier(0.16, 1, 0.3, 1)';
        ctaScreenEl.style.opacity = '1';
        ctaScreenEl.style.transform = 'translateY(0)';
      }, 0);
      revealTimers.push(t1);
    }

    if (gridEl) {
      void gridEl.offsetHeight;
      var t2 = setTimeout(function () {
        gridEl.style.transition = 'opacity 0.7s cubic-bezier(0.16, 1, 0.3, 1), transform 0.7s cubic-bezier(0.16, 1, 0.3, 1)';
        gridEl.style.opacity = '1';
        gridEl.style.transform = 'translateY(0)';
      }, 150);
      revealTimers.push(t2);
    }

    if (stripEl) {
      void stripEl.offsetHeight;
      var t3 = setTimeout(function () {
        stripEl.style.transition = 'opacity 0.7s cubic-bezier(0.16, 1, 0.3, 1), transform 0.7s cubic-bezier(0.16, 1, 0.3, 1)';
        stripEl.style.opacity = '1';
        stripEl.style.transform = 'translateY(0)';
      }, 300);
      revealTimers.push(t3);
    }

    if (scrollHintEl) {
      void scrollHintEl.offsetHeight;
      var t4 = setTimeout(function () {
        scrollHintEl.style.transition = 'opacity 0.6s ease';
        scrollHintEl.style.opacity = '0.5';
      }, 600);
      revealTimers.push(t4);
    }
  }

  resetReveal();

  // ═══════════════ 4. INTERSECTION OBSERVER ═══════════════
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
            // Show BTT button when footer is visible
            if (bttButton) showBTT();
          } else {
            footerIsVisible = false;
            resetReveal();
            // Hide BTT button when footer is not visible
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

  // ═══════════════ 5. SMART SCROLL FIX ═══════════════
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

      if (isAtTop && deltaY < 0) {
        return;
      }

      if (isAtBottom && deltaY > 0) {
        return;
      }

      e.stopPropagation();
    }, { passive: true });

    wrapEl.addEventListener('wheel', function (e) {
      var scrollTop = wrapEl.scrollTop;
      var maxScroll = wrapEl.scrollHeight - wrapEl.clientHeight;
      var isAtTop = scrollTop <= 0;
      var isAtBottom = scrollTop >= maxScroll - 1;
      var scrollingUp = e.deltaY < 0;
      var scrollingDown = e.deltaY > 0;

      if (isAtTop && scrollingUp) {
        return;
      }

      if (isAtBottom && scrollingDown) {
        return;
      }

      e.stopPropagation();
    }, { passive: true });
  }

  // ═══════════════ 6. ENGINE PATCHING ═══════════════
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
        // We are entering the footer section
        footerIsVisible = true;
        if (bttButton) showBTT();
        setTimeout(function () {
          resetReveal();
          requestAnimationFrame(function () {
            requestAnimationFrame(playReveal);
          });
        }, 60);
      } else {
        // We are leaving the footer section
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

  // ═══════════════ 7. HIDE SCROLL HINT ═══════════════
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

  // ═══════════════ 8. BACK TO TOP BUTTON (ONLY IN FOOTER) ═══════════════
  var bttButton = null;

  function createBackToTop() {
    var btn = document.createElement('button');
    btn.id = 'btt-btn';
    btn.setAttribute('aria-label', 'Back to top');
    btn.setAttribute('title', 'Back to top');
    btn.type = 'button';

    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 16V2M9 2L3 8M9 2L15 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var style = document.createElement('style');
    style.textContent = [
      '#btt-btn {',
      '  position: fixed;',
      '  bottom: 28px;',
      '  left: 28px;',
      '  z-index: 99999;',
      '  width: 46px;',
      '  height: 46px;',
      '  border-radius: 50%;',
      '  border: 1px solid rgba(199,166,85,0.35);',
      '  background: rgba(8,10,12,0.9);',
      '  backdrop-filter: blur(14px);',
      '  -webkit-backdrop-filter: blur(14px);',
      '  cursor: pointer;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  opacity: 0;',
      '  visibility: hidden;',
      '  transform: translateY(12px);',
      '  transition: opacity 0.3s ease, visibility 0.3s ease, transform 0.3s cubic-bezier(0.34,1.56,0.64,1), background 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease;',
      '  box-shadow: 0 4px 20px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.3);',
      '  outline: none;',
      '  -webkit-tap-highlight-color: transparent;',
      '  user-select: none;',
      '  color: rgba(199,166,85,0.9);',
      '  pointer-events: none;',
      '}',
      '#btt-btn.show {',
      '  opacity: 1;',
      '  visibility: visible;',
      '  transform: translateY(0);',
      '  pointer-events: auto;',
      '}',
      '#btt-btn:hover {',
      '  border-color: rgba(199,166,85,0.7);',
      '  background: rgba(12,14,18,0.95);',
      '  box-shadow: 0 8px 32px rgba(0,0,0,0.65), 0 0 32px rgba(199,166,85,0.12);',
      '  color: rgba(199,166,85,1);',
      '  transform: translateY(-3px);',
      '}',
      '#btt-btn:active {',
      '  transform: scale(0.95);',
      '  transition: transform 0.1s ease;',
      '}',
      '#btt-btn:focus-visible {',
      '  outline: 2px solid rgba(199,166,85,0.8);',
      '  outline-offset: 3px;',
      '}',
      '@media (max-width: 768px) {',
      '  #btt-btn { bottom: 20px; left: 20px; width: 42px; height: 42px; }',
      '}',
      '@media (max-width: 480px) {',
      '  #btt-btn { bottom: 16px; left: 16px; width: 40px; height: 40px; }',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  #btt-btn { transition: opacity 0.15s ease, visibility 0.15s ease !important; }',
      '}'
    ].join('\n');

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

  function showBTT() {
    if (bttButton) {
      bttButton.classList.add('show');
    }
  }

  function hideBTT() {
    if (bttButton) {
      bttButton.classList.remove('show');
    }
  }

  // Create button (hidden by default)
  bttButton = createBackToTop();

  // ═══════════════ 9. PUBLIC API ═══════════════
  if (typeof window.footerAPI === 'undefined') {
    window.footerAPI = {
      reveal: playReveal,
      reset: resetReveal,
      scrollToTop: function () {
        if (typeof window.voidGoToSection === 'function') {
          window.voidGoToSection(0);
        } else {
          var sc = document.getElementById('scroll-container');
          if (sc) {
            sc.scrollTo({ top: 0, behavior: 'smooth' });
          } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
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
  // ── PASTE SECTION-PROCESS (#section-process) BELOW ──

  // ── END SECTION-PROCESS (#section-process) ──

  // ── PASTE SECTION-7 (TESTIMONIALS) BELOW ──

  // ── END SECTION-7 (TESTIMONIALS) ──

  // ── PASTE SECTION-8 (FAQ) BELOW ──

  // ── END SECTION-8 (FAQ) ──

  // ── PASTE SECTION-CTA (#section-cta) BELOW ──

  // ── END SECTION-CTA (#section-cta) ──

  // ── PASTE FOOTER (#footer) BELOW ──

  // ── END FOOTER (#footer) ──


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

    if (!IS_TOUCH) {
      container.addEventListener('wheel', onWheel, { passive: false });

      initDriftGuard();
      initSmoothToggle();

      container.addEventListener('touchstart', onHybridTouchStart, { passive: true });
      container.addEventListener('touchend',   onHybridTouchEnd,   { passive: true });
    }

    if (IS_TOUCH) {
    initTouchHandlers();
    }

    window.addEventListener('keydown', onKeydown);
    window.addEventListener('resize',  onResize);

    if (typeof initLoader         === 'function') initLoader();
    if (typeof initNavbar         === 'function') initNavbar();
    if (typeof initSectionButtons === 'function') initSectionButtons();
    if (typeof initStatCounters   === 'function') initStatCounters();
    if (typeof handleDeepLink     === 'function') handleDeepLink();

    console.log('[VELORA] v7 ready — ' + TOTAL + ' panels | ' +
      (IS_TOUCH ? 'Touch (single-swipe boundary snap)' :
       'PC (eased-inner-scroll' + (S.globalSmooth ? '+smooth-all' : '') + ')'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 50); });
  } else {
    setTimeout(init, 50);
  }

  window.addEventListener('pagehide', function () {
    if (!IS_TOUCH) {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchstart', onHybridTouchStart);
      container.removeEventListener('touchend',   onHybridTouchEnd);
    }
    window.removeEventListener('keydown', onKeydown);
    window.removeEventListener('resize',  onResize);
    S.panelState.forEach(function (st) {
      if (st.raf) cancelAnimationFrame(st.raf);
      if (st._touchCleanup) st._touchCleanup();
    });
  });

}());
