// wasitme site, "Forty-Two Days". No framework, no network, no HTML from strings. The static page is complete without
// this file: each part hides things only once it is set up, and anything that moves waits for html.motion (boot.js).
(function () {
  "use strict";
  var root = document.documentElement;
  var motion = root.classList.contains("motion");
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var byId = function (i) { return document.getElementById(i); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var parts = [];
  function part(name, fn) { try { var p = fn(); if (p) parts.push(p); } catch (e) { if (window.console) console.warn("wasitme site: " + name + " left plain", e); } }
  var store = { get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { } } };

  // ---- a closed-form damped spring, sampled into keyframes
  function springFrames(from, unit, zeta, freq, n) {
    var out = [], w = 2 * Math.PI * freq, wd = w * Math.sqrt(1 - zeta * zeta);
    for (var i = 0; i < n; i++) {
      var t = i / n * 0.6;
      out.push({ transform: unit(from * Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta * w / wd) * Math.sin(wd * t))) });
    }
    out.push({ transform: unit(0) });
    return out;
  }
  function animate(el, frames, ms) { try { return el.animate(frames, { duration: ms, easing: "linear" }); } catch (e) { return null; } }

  // ---- a polite line that types itself
  function say(el, text) {
    if (!el) return;
    el.classList.remove("is-typing"); el.textContent = text;
    if (motion) { void el.offsetWidth; el.classList.add("is-typing"); }
  }


  // ---- The 42-day stage
  part("stage", function () {
    var section = $("#days"), track = $("#days-track"), stage = $("#days-stage"), strip = $("#stage-strip"), bar = $("#bar");
    if (!motion || !section || !track || !stage || !strip) return null;
    var cols = $$(".strip__grid > .c", strip);
    if (cols.length !== 43) return null;
    var K = strip.dataset.k.split(",").map(Number), N = strip.dataset.n.split(",").map(Number), DATES = strip.dataset.dates.split(",");
    var stamp = $("#stamp"), count = $("#stamp-count"), sk = $("#stamp-k"), sn = $("#stamp-n"), sdate = $("#stamp-date");
    var odoDate = $("#odo-date"), odoDay = $("#odo-day"), notes = $$(".note", strip);
    var early = stamp && $(".stamp__face--early", stamp), late = stamp && $(".stamp__face--landed", stamp);
    var flip = $(".mk--you.is-cand .mk__l", strip), phrase = byId("flip-phrase");
    var MARK = {}; $$(".mk--you", strip).forEach(function (m) { MARK[m.dataset.d] = 1; });
    // AT[d]: scroll offset into the track where day d is in. Quiet before-window days go quickly, the recent fortnight
    // slowly, then a short dwell on the landed finding.
    var AT = [0], LEAD = 60, DWELL = 200;
    for (var d0 = 1; d0 <= 43; d0++) AT.push(d0 === 1 ? LEAD : AT[d0 - 1] + (d0 - 1 <= 28 ? 34 : 85));
    var TOTAL = AT[43] + DWELL;
    track.dataset.at = AT.join(",") + "," + TOTAL; // read by the headless checks
    var pinned = false, rows = [], day = -1, landed = false, lastNote = null;
    section.classList.add("is-armed");
    var tl = $(".today-l", section); if (tl) tl.hidden = false;
    function canPin() { return window.innerWidth >= 1180 && window.innerHeight >= 680 && strip.clientWidth >= 1060; }
    function group() { // columns per row (the grid wraps into rows of 42, 14 or 7)
      rows = []; var top = null, cur = null;
      cols.forEach(function (c, i) { var t = c.offsetTop; if (t !== top) { cur = []; rows.push(cur); top = t; } cur.push(i); });
    }
    function setPin(on) { pinned = on; root.classList.toggle("pin", on); track.style.setProperty("--span", TOTAL + "px"); }
    // the stamp lifts and comes down again (80 ms up, 140 down, after the ticks) at the method's milestones and at each of
    // your changes; at day 42 it very nearly lands
    function lift(big) {
      if (!early || landed) return;
      var r = "rotate(-2deg) ", up = big ? "translateY(-12px) rotate(-1deg)" : "translateY(-6px)";
      try { early.animate([{ transform: r + "translateY(0)" }, { transform: r + up, offset: big ? 0.4 : 0.36 }, { transform: r + "translateY(0)" }], { duration: big ? 360 : 220, delay: 40, easing: "linear" }); } catch (e) { }
    }
    function travel() { // where the landing stamp starts: the waiting corner
      if (!late || !early || !pinned) { if (late) { late.style.removeProperty("--fx"); late.style.removeProperty("--fy"); } return; }
      var a = early.getBoundingClientRect(), b = late.getBoundingClientRect();
      late.style.setProperty("--fx", Math.round(a.left + a.width / 2 - b.left - b.width / 2) + "px");
      late.style.setProperty("--fy", Math.round(a.top + a.height / 2 - b.top - b.height / 2) + "px");
    }
    function render(d) {
      var prev = day; day = d;
      var lo = Math.min(prev < 0 ? 0 : prev, d), hi = Math.max(prev < 0 ? 43 : prev, d);
      for (var i = lo; i < hi; i++) cols[i].classList.toggle("is-in", i < d);
      if (prev >= 0 && d > prev) {
        var mile = 0;
        for (var j = prev + 1; j <= d; j++) {
          if (j === 14 || j === 28 || j === 29 || j === 42 || MARK[j]) mile = j;
          if (flip && phrase && cols[j - 1].contains(flip)) flipIn();
        }
        if (mile && d < 43) lift(mile === 42);
      }
      var shown = Math.min(d, 42);
      if (count) count.textContent = String(Math.max(0, shown));
      if (stamp) stamp.classList.toggle("is-recent", d >= 29);
      if (d >= 29 && sk && sn) {
        var k = 0, n = 0;
        for (var r = 28; r < shown; r++) { k += K[r]; n += N[r]; }
        sk.textContent = k.toLocaleString("en-US"); sn.textContent = n.toLocaleString("en-US");
      }
      var land = d >= 43;
      if (land !== landed) {
        if (land) travel();
        landed = land;
        if (stamp) { stamp.classList.toggle("is-landed", land); stamp.classList.toggle("is-unpeel", !land && prev >= 0); }
      }
      var label = d <= 0 ? DATES[0] : DATES[Math.min(d, 43) - 1];
      if (sdate) sdate.textContent = label + ", ";
      if (odoDate && odoDay && pinned) {
        if (odoDate.textContent !== label) { odoDate.textContent = label; try { odoDate.animate([{ transform: "translateY(-2px)", filter: "blur(0.3px)" }, { transform: "none", filter: "none" }], 120); } catch (e) { } }
        odoDay.textContent = d >= 43 ? "today, excluded" : "day " + Math.max(0, d) + " of 42";
      }
      var on = null;
      notes.forEach(function (nt) { if (Number(nt.dataset.d) <= d) on = nt; });
      if (on !== lastNote) { if (lastNote) lastNote.classList.remove("is-on"); if (on) on.classList.add("is-on"); lastNote = on; }
    }
    // "Effort high -> medium" folds from the note into sticker 1's label: measure both, animate the label from the phrase
    function flipIn() {
      requestAnimationFrame(function () {
        if (!pinned) return;
        var a = phrase.getBoundingClientRect(), b = flip.getBoundingClientRect();
        if (!a.width || !b.width) return;
        animate(flip, [{ transform: "translate(" + (a.left - b.left) + "px," + (a.top - b.top) + "px) scale(" + clamp(a.height / Math.max(1, b.height), 1, 3) + ")", transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }], 620);
      });
    }
    var target = 0;
    return {
      // pin only when the stage really fits (big text can overflow it); --barh puts the hero's line where the stage's pins
      resize: function () {
        if (bar) root.style.setProperty("--barh", bar.offsetHeight + "px");
        setPin(canPin()); if (pinned && stage.scrollHeight > stage.clientHeight + 1) setPin(false); group();
      },
      read: function () {
        if (pinned) {
          var r = track.getBoundingClientRect(), span = r.height - stage.offsetHeight;
          var s = span > 0 ? clamp(-r.top, 0, span) * TOTAL / span : TOTAL, n = 0;
          while (n < 43 && AT[n + 1] <= s) n++;
          target = n;
        } else {
          var vh = window.innerHeight, total = 0;
          for (var i = 0; i < rows.length; i++) {
            var top = cols[rows[i][0]].getBoundingClientRect().top;
            var prog = clamp((vh * 0.9 - top) / (vh * 0.35), 0, 1);
            var n2 = Math.ceil(prog * rows[i].length - 0.001);
            total += n2;
            if (n2 < rows[i].length) break;
          }
          target = total;
        }
      },
      write: function () { if (target !== day) render(target); }
    };
  });

  // ---- one-shot (or two-way) reveals
  part("reveals", function () {
    if (!motion || !("IntersectionObserver" in window)) return null;
    var once = $$(".react, #ledger, .field, .power, .end, .decides > .formwrap > .form, .install .form, .keeps .bag .form");
    var both = $$("#redact");
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("is-in"); if (once.indexOf(e.target) >= 0) io.unobserve(e.target); }
        else if (both.indexOf(e.target) >= 0 && e.target.classList.contains("is-in")) e.target.classList.remove("is-in"); // scrolling back un-redacts
      });
    }, { threshold: 0.25 });
    once.concat(both).forEach(function (el) { el.classList.add("is-armed"); io.observe(el); });
    return null;
  });

  // ---- the command line print: only the command types, the first time it is seen
  part("feed", function () {
    var feed = $(".feed"), cmd = $(".term__cmd");
    if (!motion || !feed || !cmd || !("IntersectionObserver" in window)) return null;
    var full = cmd.textContent;
    var io = new IntersectionObserver(function (es) {
      if (!es.some(function (e) { return e.isIntersecting; })) return;
      io.disconnect();
      var i = 0;
      cmd.textContent = "";
      var type = setInterval(function () { i += 2; cmd.textContent = full.slice(0, i); if (i >= full.length) clearInterval(type); }, 16);
    }, { threshold: 0.1 });
    io.observe(feed);
    return null;
  });

  // ---- five histories: a tablist; keys 1-5 and "demo" only with focus inside the drawer (WCAG 2.1.4)
  var statusLine = $("#statusline"), statusNote = $("#statusline-note");
  function glance(c) { if (statusLine && statusLine.dataset[c]) { statusLine.textContent = statusLine.dataset[c]; if (statusNote) statusNote.textContent = "demo data, the last history you opened"; } }
  part("histories", function () {
    var drawer = $("#drawer"), tabs = $$("#hist-tabs .stampt"), keys = $("#hist-keys"), banner = $("#hist-banner");
    if (!drawer || tabs.length !== 5) return null;
    var panels = tabs.map(function (t) { return byId(t.getAttribute("aria-controls")); });
    if (panels.some(function (p) { return !p; })) return null;
    var cur = 0;
    var saved = store.get("wasitme-site-case");
    function show(i, focus, quiet) {
      var swap = function () { // a stale switch is skipped
        if (cur !== i) return;
        tabs.forEach(function (t, j) { var on = j === i; t.setAttribute("aria-selected", on ? "true" : "false"); t.tabIndex = on ? 0 : -1; panels[j].classList.toggle("is-on", on); });
        if (focus) tabs[i].focus();
      };
      cur = i;
      if (motion && document.startViewTransition) { try { document.startViewTransition(swap); } catch (e) { swap(); } } else swap();
      if (quiet) return;
      var c = tabs[i].dataset.case; glance(c); store.set("wasitme-site-case", c);
    }
    tabs.forEach(function (t, i) {
      t.hidden = false;
      t.addEventListener("click", function () { show(i, false); });
      t.addEventListener("keydown", function (e) {
        var k = e.key, n = null;
        if (k === "ArrowRight") n = (i + 1) % 5; else if (k === "ArrowLeft") n = (i + 4) % 5;
        else if (k === "Home") n = 0; else if (k === "End") n = 4;
        if (n !== null) { e.preventDefault(); show(n, true); }
      });
    });
    drawer.classList.add("has-tabs");
    if (keys) keys.hidden = false;
    show(0, false, true);
    var typed = "";
    drawer.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, textarea, select, [contenteditable]")) return;
      if (/^[1-5]$/.test(e.key)) { show(Number(e.key) - 1, true); return; }
      if (e.key.length === 1) {
        typed = (typed + e.key.toLowerCase()).slice(-5);
        if (typed.slice(-4) === "demo") { typed = ""; if (banner) banner.hidden = false; show((cur + 1) % 5, true); }
      }
    });
    if (saved && statusLine && statusLine.dataset[saved]) glance(saved);
    return null;
  });

  // ---- the vote: a context card won't vote (METHOD §3 as behaviour)
  part("nudge", function () {
    var btn = $("[data-nudge]"), row = btn && btn.closest(".lr"), note = byId("nudge-note");
    if (!btn || !row) return null;
    btn.hidden = false;
    var busy = false, pid = null, startY = 0, dy = 0, dragged = false;
    function reset() { busy = false; dy = 0; row.style.removeProperty("transform"); }
    function refuse(from) {
      if (busy) return; busy = true;
      say(note, "Noted. Not voting.");
      var a = motion ? animate(row, springFrames(from, function (x) { return "translateY(" + x + "px)"; }, 0.42, 1.9, 36), 560) : null;
      row.style.removeProperty("transform");
      if (a) a.onfinish = reset; else reset();
    }
    var reach = function () { var first = row.parentNode.firstElementChild; return -Math.max(60, Math.min(160, row.offsetTop - first.offsetTop)); };
    btn.addEventListener("click", function () { if (dragged) { dragged = false; return; } refuse(reach() * 0.6); });
    btn.addEventListener("pointerdown", function (e) { if (pid !== null || busy || e.pointerType === "touch") return; pid = e.pointerId; startY = e.clientY; dy = 0; dragged = false; try { btn.setPointerCapture(pid); } catch (x) { } });
    btn.addEventListener("pointermove", function (e) { if (e.pointerId !== pid) return; dy = Math.min(0, e.clientY - startY); if (dy < -4) dragged = true; row.style.setProperty("transform", "translateY(" + dy + "px)"); });
    var end = function (e) { if (e.pointerId !== pid) return; pid = null; if (dragged) refuse(dy); else reset(); };
    btn.addEventListener("pointerup", end); btn.addEventListener("pointercancel", end);
    return null;
  });

  // ---- the toy of the rule
  part("toy", function () {
    var form = $("#toy"), gate = $("#toy-gate"), gstate = $("#toy-gate-state"), stampEl = $("#toy-stamp"), label = $("#toy-label"), why = $("#toy-why"), tpl = $("#toy-glyphs");
    if (!form || !gate || !stampEl || !label || !why) return null;
    var G = {}, names = ["insufficient", "none", "unclear"];
    if (tpl && tpl.content) $$("svg", tpl.content).forEach(function (g, i) { G[names[i]] = g; });
    var val = function (n) { var r = form.querySelector('input[name="' + n + '"]:checked'); return r ? r.value : "flat"; };
    function decide() {
      if (gate.getAttribute("aria-checked") !== "true") return ["insufficient", "Too early to tell", "Not enough data in both windows yet."];
      // more tool errors, fewer reads per edit and more edits without reading first all point one way
      var te = { more: 1, flat: 0, fewer: -1 }[val("te")], rpe = { more: -1, flat: 0, fewer: 1 }[val("rpe")], be = { more: 1, flat: 0, fewer: -1 }[val("be")];
      var moved = [te, rpe, be].filter(function (v) { return v !== 0; });
      if (!moved.length) return ["none", "No detectable change", "Nothing moved (the toy assumes each kind could have shown a change)."];
      if (moved.some(function (v) { return v !== moved[0]; })) return ["unclear", "Can’t tell which", "The indicators moved in opposite directions."];
      if (moved.length === 1) return ["insufficient", "Too early to tell", "A single indicator moved. One alone is never enough."];
      if (te === 0) return ["insufficient", "Too early to tell", "Both research indicators moved, but the errors kind didn’t. It needs both kinds."];
      return [null, "A change, by the rule", (moved.length === 3 ? "Three indicators of two kinds point the same way." : "Two kinds point the same way.") + " Which side changed is a separate check: the timeline, above and below the line."];
    }
    var update = function () {
      var r = decide(), old = $("svg", stampEl);
      if (old) stampEl.removeChild(old);
      if (r[0] && G[r[0]]) stampEl.insertBefore(G[r[0]].cloneNode(true), label);
      label.textContent = r[1]; why.textContent = r[2];
      if (gstate) gstate.textContent = gate.getAttribute("aria-checked") === "true" ? "on" : "off";
      if (motion) { stampEl.classList.remove("is-land"); void stampEl.offsetWidth; stampEl.classList.add("is-land"); }
    };
    form.addEventListener("change", update);
    gate.addEventListener("click", function () { gate.setAttribute("aria-checked", gate.getAttribute("aria-checked") === "true" ? "false" : "true"); update(); });
    form.addEventListener("submit", function (e) { e.preventDefault(); });
    return null;
  });

  // ---- The bench: a sticker that stays above the line, a tag that hangs below it
  part("bench", function () {
    var items = $$("[data-drag]"), note = $("#bench-note"), hint = $("#hero-try"), line = $(".q__b");
    if (!items.length || !line) return null;
    items.forEach(function (el) {
      var you = el.dataset.drag === "you", dir = you ? 1 : -1, dy = 0, pid = null, startY = 0, busy = false, gap = 24, dragged = false;
      el.setAttribute("role", "button"); el.tabIndex = 0; el.removeAttribute("aria-hidden");
      el.setAttribute("aria-label", you ? "Sticker 1, on your side of the line. Press the down arrow to try to move it across." : "Tag A, on the agent’s side of the line. Press the up arrow to try to move it across.");
      el.setAttribute("aria-describedby", "bench-note");
      // distance to the line, measured at rest
      function measure() { var b = el.getBoundingClientRect(), y = line.getBoundingClientRect().top; gap = Math.max(24, Math.abs(y - (you ? b.bottom : b.top)) + 12); }
      function put(v) { dy = v; el.style.setProperty("transform", "translateY(" + v + "px)"); }
      function reset() { busy = false; dy = 0; el.style.removeProperty("transform"); }
      function back() {
        if (busy) return; busy = true; var from = dy; pid = null;
        say(note, you ? "Yours. It stays above the line." : "The agent’s. It hangs below.");
        var frames = you ? springFrames(from, function (x) { return "translateY(" + x + "px)"; }, 0.45, 1.8, 36)
          : springFrames(1, function (x) { return "translateY(" + (from * Math.max(0, x)) + "px) rotate(" + (x * 16) + "deg)"; }, 0.3, 1.4, 40);
        el.style.removeProperty("transform");
        var a = motion ? animate(el, frames, you ? 520 : 900) : null;
        if (a) a.onfinish = reset; else reset();
      }
      el.addEventListener("pointerdown", function (e) { if (busy || pid !== null || e.pointerType === "touch") return; measure(); pid = e.pointerId; startY = e.clientY; dragged = false; try { el.setPointerCapture(pid); } catch (x) { } });
      el.addEventListener("pointermove", function (e) {
        if (e.pointerId !== pid) return;
        var v = Math.max(0, (e.clientY - startY) * dir);
        if (v > 4) dragged = true;
        put(v * dir);
        if (v > gap) back();
      });
      var end = function (e) { if (e.pointerId !== pid) return; pid = null; if (Math.abs(dy) > 8) back(); else reset(); };
      el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
      el.addEventListener("click", function () { if (dragged) { dragged = false; return; } if (!busy) { put(dir * 30); back(); } });
      el.addEventListener("keydown", function (e) {
        var k = e.key;
        if (k === "Enter" || k === " ") { e.preventDefault(); if (!busy) { put(dir * 30); back(); } }
        else if ((you && k === "ArrowDown") || (!you && k === "ArrowUp")) { e.preventDefault(); if (busy) return; if (!dy) measure(); put(dy + 12 * dir); if (Math.abs(dy) > gap) back(); }
        else if ((you && k === "ArrowUp") || (!you && k === "ArrowDown")) { e.preventDefault(); if (!busy && dy) back(); }
      });
    });
    if (hint) hint.hidden = false;
    return null;
  });

  // ---- in-page links jump instantly (smooth scrolling would play all 42 days) and move focus
  part("jumps", function () {
    $$('a[href^="#"]').forEach(function (a) {
      var t = byId(a.getAttribute("href").slice(1));
      if (!t) return;
      a.addEventListener("click", function (e) {
        e.preventDefault();
        try { t.scrollIntoView({ behavior: "instant", block: "start" }); } catch (x) { t.scrollIntoView(true); }
        if (!t.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SUMMARY)$/.test(t.tagName)) t.setAttribute("tabindex", "-1");
        try { t.focus({ preventScroll: true }); } catch (x) { t.focus(); }
        if (window.history && history.pushState) history.pushState(null, "", "#" + t.id);
      });
    });
    return null;
  });

  // ---- Install: copy, and a carbon slip
  part("copy", function () {
    var live = $("#copy-status"), carbon = $("#carbon");
    $$(".cmd__copy").forEach(function (btn) {
      var code = byId(btn.dataset.copy);
      if (!code) return;
      btn.hidden = false;
      var label = btn.textContent, timer = null;
      var done = function (msg, sayIt, slip) {
        btn.textContent = msg; if (live) live.textContent = sayIt;
        if (slip && carbon && btn.dataset.copy === "cmd-quick") { carbon.hidden = false; carbon.classList.remove("is-on"); void carbon.offsetWidth; carbon.classList.add("is-on"); }
        clearTimeout(timer);
        timer = setTimeout(function () { btn.textContent = label; if (carbon) { carbon.classList.remove("is-on"); carbon.hidden = true; } }, 2600);
      };
      btn.addEventListener("click", function () {
        var select = function () {
          var range = document.createRange(); range.selectNodeContents(code);
          var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
          done("Selected", "The command is selected. Copy it with your keyboard.", false);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code.textContent).then(function () { done("Copied", "Copied. It asks before each step.", true); }, select);
        else select();
      });
    });
    return null;
  });

  // ---- the film (isolated; phones get the vertical cut and its poster)
  part("film", function () {
    var box = $("#film"), video = $("#film-video"), play = $("#film-play"), status = $("#film-status");
    if (!box || !video || !play || !status) return null;
    var failed = function () { play.hidden = true; video.setAttribute("controls", ""); status.textContent = "The film couldn’t be loaded."; };
    video.addEventListener("error", failed);
    var src = $("source", video);
    if (src) src.addEventListener("error", failed);
    if (src && video.dataset.tallSrc && window.matchMedia("(max-width: 600px)").matches) {
      box.classList.add("film-tall");
      if (video.dataset.tallPoster) video.setAttribute("poster", video.dataset.tallPoster);
      src.setAttribute("src", video.dataset.tallSrc);
      video.load();
    }
    if (video.error) { failed(); return null; }
    play.hidden = false;
    video.removeAttribute("controls");
    play.addEventListener("click", function () {
      video.setAttribute("controls", "");
      var pr = video.play();
      if (pr && pr.catch) pr.catch(function () { });
    });
    video.addEventListener("click", function () { if (!play.hidden) play.click(); });
    video.addEventListener("play", function () {
      if (document.activeElement === play) { try { video.focus({ preventScroll: true }); } catch (e) { video.focus(); } }
      play.hidden = true; status.textContent = "";
    });
    return null;
  });

  // ---- quirks
  // leave the tab and the title says what it would say; back within a day, why today doesn't count. The page's name
  // stays. A clock that went backward (negative time away) is quiet: no gag.
  part("title", function () {
    var base = document.title, left = null, t = null;
    document.addEventListener("visibilitychange", function () {
      clearTimeout(t);
      if (document.hidden) { left = Date.now(); document.title = "·┄· Too early to tell · wasitme"; return; }
      var away = left === null ? -1 : Date.now() - left;
      if (away >= 0 && away < 86400000) { document.title = "Half a day is not a day · wasitme"; t = setTimeout(function () { document.title = base; }, 2400); }
      else document.title = base;
    });
    return null;
  });

  part("console", function () {
    if (!window.console || !console.info) return null;
    console.info("[..] Too early to tell\n[none] No detectable change\n[?] Can’t tell which\n[you] Your side\n[agent] Agent side\n\n" +
      "Today counts as 0 complete days. Measure twice, blame once.\nEvery product number here came from `wasitme demo`. Read the code: github.com/draarivpatel-ui/wasitme");
    return null;
  });

  // ---- the frame loop: all reads, then all writes
  var ticking = false;
  function frame() {
    ticking = false;
    parts.forEach(function (p) { if (p.read) p.read(); });
    parts.forEach(function (p) { if (p.write) p.write(); });
  }
  function request() { if (!ticking) { ticking = true; window.requestAnimationFrame(frame); } }
  window.addEventListener("scroll", request, { passive: true });
  window.addEventListener("resize", function () { parts.forEach(function (p) { if (p.resize) p.resize(); }); request(); });
  var rm = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (rm.addEventListener) rm.addEventListener("change", function () { window.location.reload(); });
  parts.forEach(function (p) { if (p.resize) p.resize(); });
  frame();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { parts.forEach(function (p) { if (p.resize) p.resize(); }); request(); });
})();
