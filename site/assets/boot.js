// Runs before first paint: marks the page as scripted, and as animated only when the reader allows motion.
// "motion" only starts the hero's CSS animations, which finish on their own. Anything that hides content until a
// script reveals it is switched on by site.js itself, after it has set that part up.
(function () {
  var d = document.documentElement;
  d.classList.add("js");
  try { if (window.matchMedia("(prefers-reduced-motion: no-preference)").matches) d.classList.add("motion"); } catch (e) { /* stay still */ }
})();
