// wasitme site: the few things that need a script. No framework, no network, no HTML built from strings.
// Everything is readable without it. Each part switches its own enhancement on only after it is set up, so a failure
// in one part leaves that part plain and visible. With prefers-reduced-motion the page stays still.
(function () {
  "use strict";
  var root = document.documentElement;
  var motion = root.classList.contains("motion");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var parts = [];
  function part(name, fn) { try { var p = fn(); if (p) parts.push(p); } catch (e) { if (window.console) console.warn("wasitme site: " + name + " left plain", e); } }

  // ---- header: the small logo stays tucked while the big one is on screen (the markup starts it tucked, so it never
  // flashes; CSS only hides it under html.js); the bar takes the ground of whatever is just below it
  part("header", function () {
    var bar = $("#bar"), home = $(".bar__home"), heroLogo = $(".hero__logo"), hero = $(".hero"), filmMedia = $(".film__media");
    if (!bar) return null;
    if (home) {
      if (heroLogo && "IntersectionObserver" in window) {
        new IntersectionObserver(function (es) { home.classList.toggle("is-tucked", es[0].isIntersecting); }, { rootMargin: "-56px 0px 0px 0px" }).observe(heroLogo);
      } else home.classList.remove("is-tucked");
    }
    var grounds = $$("main > section, footer");
    var g = null, scrolled = null;
    return {
      read: function () {
        var y = bar.offsetHeight + 1, next = "paper"; // the first line of the page under the bar
        for (var i = 0; i < grounds.length; i++) {
          var r = grounds[i].getBoundingClientRect();
          if (r.top <= y && r.bottom > y) {
            if (grounds[i] === hero && filmMedia) { var fm = filmMedia.getBoundingClientRect(); next = fm.top + fm.height / 2 > y ? "paper" : "ink"; } // paper turns to ink at the film's middle
            else next = grounds[i].classList.contains("ground-ink") ? "ink" : "paper";
            break;
          }
        }
        this.next = next; this.scrolled = window.scrollY > 8;
      },
      write: function () {
        if (g !== this.next) { g = this.next; bar.dataset.ground = g; }
        if (scrolled !== this.scrolled) { scrolled = this.scrolled; bar.classList.toggle("is-scrolled", scrolled); }
      }
    };
  });

  // ---- one-shot reveals (only when motion is allowed)
  part("reveals", function () {
    if (!motion || !("IntersectionObserver" in window)) return null;
    var els = $$(".ledger, .steps");
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } });
    }, { threshold: 0.2 }); // no percentage rootMargin: it resolves against the viewport's width, so a wide, short window could never intersect
    els.forEach(function (el) { io.observe(el); });
    root.classList.add("reveals");
    return null;
  });

  // ---- the question on the case line: its choreography plays once, when it comes into view
  part("question", function () {
    var ask = $(".ask"), wrap = $(".ask .q-wrap");
    if (!motion || !ask || !wrap || !("IntersectionObserver" in window)) return null;
    var io;
    var play = function () {
      if (ask.classList.contains("is-in")) return;
      ask.classList.add("is-in"); io.disconnect(); window.removeEventListener("scroll", check);
    };
    // belt and braces: whatever the observer does, the question plays once it is on screen
    var check = function () { var r = wrap.getBoundingClientRect(); if (r.top < window.innerHeight * 0.92 && r.bottom > 0) play(); };
    io = new IntersectionObserver(function (es) { if (es[0].isIntersecting) play(); }, { threshold: 0.25 });
    root.classList.add("q-armed");
    io.observe(wrap);
    window.addEventListener("scroll", check, { passive: true });
    window.setTimeout(check, 1200);
    return null;
  });

  // ---- the peak: three cases filed along one line as the reader scrolls
  part("peak", function () {
    var section = $("#case"), track = $("#peak-track"), stage = $("#peak-stage"), tabs = $("#peak-tabs");
    var cases = $$("#peak-cases .case");
    if (!motion || !section || !track || !stage || !tabs || cases.length !== 3) return null;
    var N = cases.length, PRE = 7;
    var state = cases.map(function (c) {
      var row = $(".row--bars", c);
      return { el: c, row: row, marks: $$(".mark", c), conns: $$(".conn", c), label: $(".cursor__date", c),
        dates: (row && row.dataset.dates ? row.dataset.dates.split(",") : []), k: -1, d: -1, stamped: null, active: null };
    });
    var buttons = $$(".peak__tab", tabs);
    // the stage needs room: when the tallest case doesn't fit the viewport, the three cases stay stacked, as without a script
    var casesEl = $("#peak-cases");
    var staged = false;
    var fits = function () {
      if (window.innerHeight < 520 || window.innerWidth < 320) return false;
      setStaged(true);
      var cs = getComputedStyle(tabs);
      var need = tabs.offsetHeight + parseFloat(cs.marginBottom) + casesEl.offsetHeight + 16; // 16: the stage's own padding
      return need <= stage.clientHeight + 1;
    };
    function setStaged(on) {
      if (on === staged) return;
      staged = on;
      section.classList.toggle("staged", on);
      tabs.hidden = !on;
      state.forEach(function (s) { s.d = -1; s.stamped = null; s.active = null; });
      if (!on) state.forEach(function (s) { s.el.classList.remove("is-active", "is-stamped"); });
    }
    buttons.forEach(function (b) {
      b.addEventListener("click", function () {
        var i = Number(b.dataset.go);
        var r = track.getBoundingClientRect();
        var span = r.height - stage.getBoundingClientRect().height;
        window.scrollTo({ top: window.scrollY + r.top + span * ((i + 0.66) / N), behavior: reduce.matches ? "auto" : "smooth" });
      });
    });
    setStaged(fits());
    return {
      resize: function () { setStaged(fits()); if (staged) state.forEach(function (s) { s.el.style.setProperty("--track", s.row.getBoundingClientRect().width + "px"); }); },
      read: function () {
        if (!staged) return;
        var r = track.getBoundingClientRect(), sh = stage.getBoundingClientRect().height;
        var span = r.height - sh;
        this.p = span > 0 ? clamp(-r.top / span, 0, 1) : 1;
      },
      write: function () {
        if (!staged) return;
        var p = this.p, active = Math.min(N - 1, Math.floor(p * N));
        state.forEach(function (s, i) {
          var t = clamp(p * N - i, 0, 1);
          var d = i < active ? 1 : clamp((t - 0.05) / 0.5, 0, 1);
          if (Math.abs(d - s.d) > 0.0005) {
            s.d = d;
            // the first PRE days are already filed when a case comes up, so it never opens on an empty axis
            var f = (PRE + (28 - PRE) * d) / 28;
            s.el.style.setProperty("--d", f.toFixed(4));
            s.el.style.setProperty("--live", d > 0 && d < 1 ? "1" : "0");
            var day = f * 28 + 0.5;
            var k = Math.min(27, Math.max(0, Math.ceil(f * 28) - 1));
            if (s.label && s.dates[k] && k !== s.k) { s.k = k; s.label.textContent = s.dates[k]; }
            s.marks.forEach(function (m) { m.classList.toggle("is-in", Number(m.dataset.day) <= day); });
            s.conns.forEach(function (m) { m.classList.toggle("is-in", Number(m.dataset.day) <= day); });
          }
          var stamped = i < active || t >= 0.6;
          if (stamped !== s.stamped) { s.stamped = stamped; s.el.classList.toggle("is-stamped", stamped); }
          var on = i === active;
          if (on !== s.active) { s.active = on; s.el.classList.toggle("is-active", on); buttons[i].setAttribute("aria-pressed", on ? "true" : "false"); }
        });
      }
    };
  });

  // ---- slow parallax on the product windows (wide screens only)
  part("parallax", function () {
    var els = $$("[data-depth]");
    if (!motion || !els.length) return null;
    root.classList.add("depth");
    var py = els.map(function () { return 0; }), next = py.slice();
    return {
      read: function () {
        if (window.innerWidth <= 900) { next = els.map(function () { return 0; }); return; }
        var vh = window.innerHeight;
        els.forEach(function (el, i) {
          var r = el.getBoundingClientRect();
          var top = r.top - py[i]; // measure where it would be without its own offset
          next[i] = (top + r.height / 2 - vh / 2) * Number(el.dataset.depth);
        });
      },
      write: function () {
        els.forEach(function (el, i) { if (Math.abs(next[i] - py[i]) > 0.3) { py[i] = next[i]; el.style.setProperty("--py", py[i].toFixed(1) + "px"); } });
      }
    };
  });

  var ticking = false;
  function frame() {
    ticking = false;
    parts.forEach(function (p) { if (p.read) p.read(); });   // all geometry first
    parts.forEach(function (p) { if (p.write) p.write(); }); // then every write
  }
  function request() { if (!ticking) { ticking = true; window.requestAnimationFrame(frame); } }
  window.addEventListener("scroll", request, { passive: true });
  window.addEventListener("resize", function () { parts.forEach(function (p) { if (p.resize) p.resize(); }); request(); });
  if (reduce.addEventListener) reduce.addEventListener("change", function () { window.location.reload(); });
  parts.forEach(function (p) { if (p.resize) p.resize(); });
  frame();
  // measure again once the web fonts are in: line heights and wrapping change with them
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { parts.forEach(function (p) { if (p.resize) p.resize(); }); request(); });

  // ---- the film
  part("film", function () {
    var video = $("#film-video"), play = $("#film-play"), status = $("#film-status");
    if (!video || !play || !status) return null;
    var failed = function () { play.hidden = true; video.setAttribute("controls", ""); status.textContent = "The film couldn’t be loaded."; };
    video.addEventListener("error", failed);
    var src = $("source", video);
    if (src) src.addEventListener("error", failed);
    // phones get the vertical cut, its own poster and its own text version (decided once, before anything loads)
    var hero = $(".hero");
    if (hero && src && video.dataset.tallSrc && window.matchMedia("(max-width: 600px)").matches) {
      hero.classList.add("film-tall");
      if (video.dataset.tallPoster) video.setAttribute("poster", video.dataset.tallPoster);
      src.setAttribute("src", video.dataset.tallSrc);
      video.load();
    }
    if (video.error) { failed(); return null; } // it already failed before this ran
    play.hidden = false;
    video.removeAttribute("controls"); // the poster stays clean until the reader presses play
    play.addEventListener("click", function () {
      video.setAttribute("controls", "");
      var pr = video.play();
      if (pr && pr.catch) pr.catch(function () { /* the native controls stay available */ });
    });
    // until the film starts, the whole poster is a play button too (the real button stays the keyboard path)
    video.addEventListener("click", function () { if (!play.hidden) play.click(); });
    video.addEventListener("play", function () {
      // keyboard users keep their place: focus moves from the button to the player before the button goes
      if (document.activeElement === play) { try { video.focus({ preventScroll: true }); } catch (e) { video.focus(); } }
      play.hidden = true; status.textContent = "";
    });
    return null;
  });

  // ---- the terminal: when it has to scroll sideways, fade the edge that has more and say so in the caption
  part("terminal", function () {
    $$(".term__frame").forEach(function (fr) {
      var sc = $(".term__scroll", fr);
      if (!sc) return;
      var update = function () {
        var max = sc.scrollWidth - sc.clientWidth;
        fr.classList.toggle("can-scroll", max > 1);
        fr.classList.toggle("is-moved", sc.scrollLeft > 1);
        fr.classList.toggle("is-end", sc.scrollLeft >= max - 1);
      };
      sc.addEventListener("scroll", update, { passive: true });
      window.addEventListener("resize", update);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(update);
      update();
    });
    return null;
  });

  // ---- copy buttons
  part("copy", function () {
    var live = $("#copy-status");
    $$(".cmd__copy").forEach(function (btn) {
      var code = document.getElementById(btn.dataset.copy);
      if (!code) return;
      btn.hidden = false;
      var label = btn.textContent;
      var done = function (msg, say) {
        btn.textContent = msg; btn.classList.add("is-done");
        if (live) live.textContent = say;
        window.setTimeout(function () { btn.textContent = label; btn.classList.remove("is-done"); }, 1800);
      };
      btn.addEventListener("click", function () {
        var text = code.textContent;
        var select = function () {
          var range = document.createRange(); range.selectNodeContents(code);
          var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
          done("Selected", "The command is selected. Copy it with your keyboard.");
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done("Copied", "Copied to the clipboard."); }, select);
        else select();
      });
    });
    return null;
  });
})();
