/* UzLeeder digital signature — "Crafted by UzLeeder" badge for websites UzLeeder builds.
 *
 *   <uzleeder-crafted theme="dark" size="sm"></uzleeder-crafted>
 *
 * Self-hosted (not loaded from uzleeder.vercel.app) so it works under this app's
 * Content-Security-Policy (script-src 'self') — same component, same behavior.
 *
 * Attributes (all optional):
 *   theme="auto|dark|light"   auto follows the visitor's colour scheme (default: dark)
 *   align="center|start|end"  default: center
 *   size="sm|md"              default: md
 *   fonts="none"              do not load the Outfit wordmark font (falls back to the system font)
 *
 * Motion: at rest only the mark sways ("CRAFTED BY" stays still). On hover / keyboard focus the wordmark
 * types the UzLeeder family in brackets, like the site intro: <UzLeeder> -> <LeeCodes> -> <Max's Code> -> ...
 * The badge's link and label follow whichever word is on screen (click while "LeeCodes" shows -> t.me/leecodes).
 * Leaving returns it to the normal wordmark/link. "Reduce motion": no waving, words swap without typing.
 *
 * Renders inside a Shadow DOM, so the host site's CSS cannot change it and it cannot change the host site.
 * No cookies, no tracking; the only request is the tiny Outfit subset for the letters used (skip with fonts="none").
 */
(function () {
  if (!window.customElements || customElements.get("uzleeder-crafted")) return;
  var HOME = "https://uzleeder.vercel.app/?ref=crafted";
  var LABEL_DEFAULT = "Crafted by UzLeeder (opens uzleeder.vercel.app)";
  // each word in two colours, like the wordmark ([text, "ink" | "red"]), and where it links while it is shown
  var WORDS = [
    { name: "UzLeeder", url: HOME, host: "uzleeder.vercel.app", parts: [["Uz", "ink"], ["Leeder", "red"]] },
    { name: "LeeCodes", url: "https://t.me/leecodes", host: "t.me/leecodes", parts: [["Lee", "red"], ["Codes", "ink"]] },
    { name: "Max's Code", url: "https://t.me/maxscode", host: "t.me/maxscode", parts: [["Max's", "red"], [" Code", "ink"]] }
  ];
  var plain = function (w) { return w.parts.map(function (p) { return p[0]; }).join(""); };
  var FONT = "https://fonts.googleapis.com/css2?family=Outfit:wght@800&text=" + encodeURIComponent("<>" + WORDS.map(plain).join("")) + "&display=swap";
  var escH = function (s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/'/g, "&#39;"); };
  // the first n letters of a word, keeping each part's colour
  function partial(w, n) {
    var out = "";
    w.parts.forEach(function (p) { if (n <= 0) return; var t = p[0].slice(0, n); n -= t.length; out += '<span class="' + (p[1] === "red" ? "lee" : "uz") + '">' + escH(t) + "</span>"; });
    return out;
  }
  var LABEL = "CRAFTED BY";

  var css =
    ":host{display:block;--cb-muted:#8e97ab;--cb-ink:#ffffff;--cb-red:#f0384e;--cb-inner:#ffffff;--cb-ring:rgba(240,56,78,.55)}" +
    ":host([theme=light]){--cb-muted:#5b6377;--cb-ink:#1c2233;--cb-red:#e01e37;--cb-inner:#1c2233;--cb-ring:rgba(224,30,55,.45)}" +
    "@media (prefers-color-scheme:light){:host([theme=auto]){--cb-muted:#5b6377;--cb-ink:#1c2233;--cb-red:#e01e37;--cb-inner:#1c2233;--cb-ring:rgba(224,30,55,.45)}}" +
    ".wrap{display:flex;justify-content:center;padding:14px 0}" +
    ":host([align=start]) .wrap{justify-content:flex-start}:host([align=end]) .wrap{justify-content:flex-end}" +
    "a{display:inline-flex;align-items:center;gap:12px;text-decoration:none;border-radius:8px;padding:4px 6px;-webkit-tap-highlight-color:transparent}" +
    "a:focus-visible{outline:2px solid var(--cb-ring);outline-offset:3px}" +
    /* waving label: each letter rises and falls a little, one after another */
    ".by{display:inline-flex;font:600 11px/1 ui-monospace,'SFMono-Regular','Cascadia Mono',Consolas,monospace;letter-spacing:.28em;text-transform:uppercase;color:var(--cb-muted)}" +
    ".by i{font-style:normal;display:inline-block}" +
    ".by i.sp{width:.55em}" +
    /* the mark sways around its base */
    ".mark{width:22px;height:20px;flex:none;overflow:visible;transform-origin:50% 100%;animation:cbSway 2.8s ease-in-out infinite}" +
    "@keyframes cbSway{0%,100%{transform:rotate(0)}25%{transform:rotate(-5deg)}50%{transform:rotate(0)}75%{transform:rotate(5deg)}}" +
    ".o{fill:none;stroke:var(--cb-red);stroke-width:7;stroke-miterlimit:10}.i{fill:none;stroke:var(--cb-inner);stroke-width:5.5;stroke-miterlimit:10}" +
    /* wordmark / typed words */
    ".word{position:relative;display:inline-block;font:800 17px/1 Outfit,'Segoe UI',system-ui,-apple-system,sans-serif;letter-spacing:-.02em;white-space:nowrap;text-align:left;transition:width .25s cubic-bezier(.2,.7,.2,1)}" +
    ".uz{color:var(--cb-ink)}.lee{color:var(--cb-red)}" +
    ".typed{display:none}.br{color:var(--cb-red)}.tx{color:var(--cb-ink)}" +
    ".caret{display:inline-block;width:2px;height:.9em;margin:0 1px;vertical-align:-.08em;background:var(--cb-red);animation:cbBlink 1s steps(1) infinite}" +
    "@keyframes cbBlink{50%{opacity:0}}" +
    ":host(.on) .rest{display:none}:host(.on) .typed{display:inline}" +
    ":host(.on) .mark{animation-play-state:paused}" +
    ":host([size=sm]) a{gap:9px}:host([size=sm]) .by{font-size:9.5px}:host([size=sm]) .mark{width:18px;height:16px}:host([size=sm]) .word{font-size:14px}" +
    "@media (prefers-reduced-motion:reduce){.mark,.caret{animation:none}.word{transition:none}}";

  var label = LABEL.split("").map(function (ch, n) { return ch === " " ? '<i class="sp"></i>' : '<i style="--n:' + n + '">' + ch + "</i>"; }).join("");
  var html =
    '<div class="wrap"><a href="' + HOME + '" target="_blank" rel="noopener" aria-label="' + LABEL_DEFAULT + '">' +
    '<span class="by" aria-hidden="true">' + label + "</span>" +
    '<svg class="mark" viewBox="0 0 48 44" aria-hidden="true" focusable="false"><path class="o" d="M4 41 24 5l20 36"/><path class="i" d="M14 41 24 23l10 18"/></svg>' +
    '<span class="word" aria-hidden="true"><span class="rest"><span class="uz">Uz</span><span class="lee">Leeder</span></span>' +
    '<span class="typed"><span class="br">&lt;</span><span class="tx"></span><span class="caret"></span><span class="br">&gt;</span></span></span></a></div>';

  function loadFont(el) {
    if (el.getAttribute("fonts") === "none" || document.querySelector("link[data-uzleeder-font]")) return;
    var l = document.createElement("link");
    l.rel = "stylesheet"; l.href = FONT; l.setAttribute("data-uzleeder-font", "");
    document.head.appendChild(l);
  }
  var reduce = function () { return window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches; };

  customElements.define("uzleeder-crafted", class extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      if (!this.hasAttribute("theme")) this.setAttribute("theme", "dark");
      var root = this.attachShadow({ mode: "open" });
      root.innerHTML = "<style>" + css + "</style>" + html;
      loadFont(this);
      var self = this, a = root.querySelector("a"), word = root.querySelector(".word"), tx = root.querySelector(".tx");
      var timer = null, active = false;

      // the typed words are wider than the wordmark: measure once so the badge grows smoothly instead of jumping
      function typedWidth() {
        var probe = document.createElement("span");
        probe.className = "word";
        probe.style.cssText = "position:absolute;visibility:hidden;width:auto";
        probe.innerHTML = '<span class="br">&lt;</span><span class="tx"></span><span class="caret"></span><span class="br">&gt;</span>';
        root.querySelector(".wrap").appendChild(probe);
        var w = 0;
        WORDS.forEach(function (x) { probe.querySelector(".tx").innerHTML = partial(x, 99); w = Math.max(w, probe.getBoundingClientRect().width); });
        probe.remove();
        return Math.ceil(w);
      }

      // the link follows the word on screen: click while "LeeCodes" shows -> t.me/leecodes
      function linkTo(x) {
        a.href = x.url;
        a.setAttribute("aria-label", x.url === HOME ? LABEL_DEFAULT : "Crafted by UzLeeder — " + x.name + " (opens " + x.host + ")");
      }
      function stop() {
        active = false; clearTimeout(timer); timer = null;
        a.href = HOME; a.setAttribute("aria-label", LABEL_DEFAULT);
        word.style.width = word.getBoundingClientRect().width + "px";          // from the typed width...
        self.classList.remove("on"); tx.textContent = "";
        var rest = root.querySelector(".rest").getBoundingClientRect().width;
        requestAnimationFrame(function () { word.style.width = rest + "px"; });  // ...back to the wordmark
        timer = setTimeout(function () { if (!active) word.style.width = ""; }, 300);
      }
      function start() {
        if (active) return;
        active = true; clearTimeout(timer);
        word.style.width = word.getBoundingClientRect().width + "px";
        self.classList.add("on");
        var target = typedWidth();
        requestAnimationFrame(function () { word.style.width = target + "px"; });
        var w = 0, i = 0, del = false;
        var at = function (ms, fn) { timer = setTimeout(function () { if (active) fn(); }, ms); };
        if (reduce()) {                                   // no typing: whole words, one after another
          (function swap() { linkTo(WORDS[w]); tx.innerHTML = partial(WORDS[w], 99); w = (w + 1) % WORDS.length; at(1100, swap); })();
          return;
        }
        (function step() {                                // type -> hold -> delete -> next word
          var cur = WORDS[w], len = plain(cur).length;
          if (!del) {
            if (i === 0) linkTo(cur);                     // a new word starts -> its link
            tx.innerHTML = partial(cur, ++i);
            if (i === len) { del = true; at(1100, step); } else at(85, step);
          } else {
            tx.innerHTML = partial(cur, --i);
            if (i === 0) { del = false; w = (w + 1) % WORDS.length; at(260, step); } else at(40, step);
          }
        })();
      }
      a.addEventListener("mouseenter", start);
      a.addEventListener("mouseleave", stop);
      a.addEventListener("focus", start);
      a.addEventListener("blur", stop);
    }
    disconnectedCallback() { this.classList.remove("on"); }
  });
})();
