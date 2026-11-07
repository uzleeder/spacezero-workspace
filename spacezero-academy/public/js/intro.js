(function () {
  'use strict';
  var intro = document.getElementById('workspace-intro');
  if (!intro) return;
  var key = 'spacezero-intro-seen-v1';
  // Admin actions (resend invite, disable, reset password, ...) reload the page via
  // window.location.reload() on success (public/js/app.js) — that must not replay this.
  try { if (sessionStorage.getItem(key)) return; } catch (_) { /* Storage is optional. */ }
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 5 seconds: the plane's one unhurried loop around the globe while the bar fills (it plays once per browser session).
  var duration = reduced ? 250 : 5000;
  var bar = intro.querySelector('[role="progressbar"]');
  var fill = intro.querySelector('.workspace-intro__fill');
  var label = intro.querySelector('[data-intro-percent]');
  var globeSvg = intro.querySelector('[data-intro-globe]');
  var globe = globeSvg ? introGlobe(globeSvg) : null;
  var previousFocus = document.activeElement;
  var locked = [];
  var finished = false;
  function release() {
    if (finished) return;
    finished = true;
    intro.hidden = true;
    document.documentElement.classList.remove('intro-active');
    locked.forEach(function (el) { el.inert = false; });
    if (previousFocus && previousFocus !== document.body) previousFocus.focus();
    try { sessionStorage.setItem(key, '1'); } catch (_) { /* Storage is optional. */ }
  }
  function start() {
    if (finished) return;
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (el !== intro && el.tagName !== 'SCRIPT' && !el.inert) { el.inert = true; locked.push(el); }
    });
    intro.tabIndex = -1;
    intro.focus({ preventScroll: true });
    if (globe) globe.load();
    var startTime;
    function frame(now) {
      if (finished) return;
      if (startTime === undefined) startTime = now;
      var fraction = Math.min((now - startTime) / duration, 1);
      var percent = Math.floor(fraction * 100);
      label.textContent = percent + '%';
      bar.setAttribute('aria-valuenow', String(percent));
      fill.style.transform = 'scaleX(' + fraction + ')';
      if (globe) globe.draw(reduced ? 1 : fraction);
      if (fraction < 1) requestAnimationFrame(frame);
      else setTimeout(function () {
        intro.classList.add('workspace-intro--done');
        setTimeout(release, reduced ? 0 : 450);
      }, reduced ? 0 : 300);
    }
    requestAnimationFrame(frame);
  }
  intro.hidden = false;
  document.documentElement.classList.add('intro-active');
  // Always release the page, even if animation frames are paused in a background tab (after the 5 s loop and its fade).
  setTimeout(release, 9000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  // ---- The big globe: every country (Natural Earth 110m, the dashboard globe's data) on a turning sphere, and a plane
  // that flies once around the orbit as the bar goes from 0 to 100 %, leaving a gold trail. The globe turns so that
  // Uzbekistan faces you at 100 %. The plane and trail on the far half of the orbit pass behind the sphere.
  function introGlobe(svg) {
    var RAD = Math.PI / 180;
    var CX = 200, CY = 128, R = 96;
    var TILT = 18 * RAD, SIN_T = Math.sin(TILT), COS_T = Math.cos(TILT);
    var ORX = 172, ORY = 44, OROT = -16 * RAD;           // the orbit ellipse (same as in the markup)
    var START = Math.PI;                                  // the plane sets off from the left end of the orbit, in front
    var UZ_LON = 64, TURN = 150;                          // the globe turns 150 degrees and ends facing Uzbekistan
    var q = function (sel) { return svg.querySelector(sel); };
    var gridEl = q('[data-grid]'), landEl = q('[data-land]'), bordersEl = q('[data-borders]'), uzEl = q('[data-uz]');
    var trailBack = q('[data-trail-back]'), trailFront = q('[data-trail-front]');
    var planeBack = q('[data-plane-back]'), planeFront = q('[data-plane-front]');
    var countries = null, uz = null, loading = false;
    var f = function (n) { return Math.round(n * 10) / 10; };
    var ease = function (u) { return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; };

    function project(lon, lat, lam0) {
      var l = (lon - lam0) * RAD, p = lat * RAD, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l);
      return [CX + R * cp * Math.sin(l), CY - R * (COS_T * sp - SIN_T * cp * cl), SIN_T * sp + COS_T * cp * cl];
    }
    function linePath(points) {
      var d = '', pen = false;
      points.forEach(function (p) { if (p[2] > 0.02) { d += (pen ? 'L' : 'M') + f(p[0]) + ' ' + f(p[1]); pen = true; } else pen = false; });
      return d;
    }
    function graticule(lam0) {
      var d = '', lon, lat, pts;
      for (lon = -180; lon < 180; lon += 30) { pts = []; for (lat = -90; lat <= 90; lat += 4) pts.push(project(lon, lat, lam0)); d += linePath(pts); }
      [-60, -30, 0, 30, 60].forEach(function (la) { pts = []; for (lon = -180; lon <= 180; lon += 4) pts.push(project(lon, la, lam0)); d += linePath(pts); });
      return d;
    }
    function prep(ring) {
      var n = ring.length, out = { lon: new Float64Array(n), cp: new Float64Array(n), sp: new Float64Array(n) };
      for (var i = 0; i < n; i++) { out.lon[i] = ring[i][0] * RAD; out.cp[i] = Math.cos(ring[i][1] * RAD); out.sp[i] = Math.sin(ring[i][1] * RAD); }
      return out;
    }
    // country fill: points on the far side are pinned to the globe's edge, so a country cut by the horizon is cut there
    function ringFill(r, lam0r) {
      var d = '', any = false, n = r.lon.length;
      for (var i = 0; i < n; i++) {
        var l = r.lon[i] - lam0r, cp = r.cp[i], sp = r.sp[i], cl = Math.cos(l);
        var x = R * cp * Math.sin(l), y = -R * (COS_T * sp - SIN_T * cp * cl), z = SIN_T * sp + COS_T * cp * cl;
        if (z > 0) any = true; else { var k = R / (Math.hypot(x, y) || 1); x *= k; y *= k; }
        d += (i ? 'L' : 'M') + f(CX + x) + ' ' + f(CY + y);
      }
      return any ? d + 'Z' : '';
    }
    // border line: only the parts on the near side
    function ringLine(r, lam0r) {
      var d = '', pen = false, n = r.lon.length;
      for (var i = 0; i <= n; i++) {
        var j = i % n, l = r.lon[j] - lam0r, cp = r.cp[j], sp = r.sp[j], cl = Math.cos(l);
        var z = SIN_T * sp + COS_T * cp * cl;
        if (z > 0.01) { d += (pen ? 'L' : 'M') + f(CX + R * cp * Math.sin(l)) + ' ' + f(CY - R * (COS_T * sp - SIN_T * cp * cl)); pen = true; } else pen = false;
      }
      return d;
    }
    // TopoJSON (world-atlas) to rings of [lon, lat]
    function decode(topo) {
      var sx = topo.transform.scale[0], sy = topo.transform.scale[1], tx = topo.transform.translate[0], ty = topo.transform.translate[1];
      var arcs = topo.arcs.map(function (a) { var x = 0, y = 0; return a.map(function (p) { x += p[0]; y += p[1]; return [x * sx + tx, y * sy + ty]; }); });
      function ring(ids) {
        var out = [];
        ids.forEach(function (i, k) {
          var a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
          for (var j = k ? 1 : 0; j < a.length; j++) out.push(a[j]);
        });
        return out;
      }
      return topo.objects.countries.geometries.map(function (g) {
        var polys = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
        var rings = [];
        polys.forEach(function (poly) { poly.forEach(function (r) { rings.push(prep(ring(r))); }); });
        return { id: g.id, rings: rings };
      });
    }
    // [x, y, depth]: depth > 0 is the near half of the orbit (in front of the globe)
    function orbitPoint(theta) {
      var lx = ORX * Math.cos(theta), ly = ORY * Math.sin(theta);
      return [CX + lx * Math.cos(OROT) - ly * Math.sin(OROT), CY + lx * Math.sin(OROT) + ly * Math.cos(OROT), ly];
    }
    function trail(theta) {
      var back = '', front = '', side = 0, steps = Math.max(2, Math.ceil(Math.abs(START - theta) / (2 * Math.PI) * 140));
      for (var k = 0; k <= steps; k++) {
        var p = orbitPoint(START + (theta - START) * k / steps), now = p[2] >= 0 ? 1 : -1, xy = f(p[0]) + ' ' + f(p[1]);
        if (now === 1) front += (side === 1 ? 'L' : 'M') + xy; else back += (side === -1 ? 'L' : 'M') + xy;
        if (side && now !== side) { if (now === 1) back += 'L' + xy; else front += 'L' + xy; } // join the two halves without a gap
        side = now;
      }
      trailBack.setAttribute('d', back);
      trailFront.setAttribute('d', front);
    }
    function place(g, x, y, angle) {
      g.setAttribute('transform', 'translate(' + f(x) + ' ' + f(y) + ') rotate(' + f(angle) + ') scale(.46)');
      g.style.visibility = 'visible';
    }

    return {
      load: function () {
        if (loading) return;
        loading = true;
        if (!window.fetch) return;
        fetch(svg.getAttribute('data-world'), { credentials: 'same-origin' })
          .then(function (res) { if (!res.ok) throw new Error('no map'); return res.json(); })
          .then(function (topo) {
            countries = decode(topo);
            countries.forEach(function (c) { if (c.id === '860') uz = c; });   // ISO 3166 code of Uzbekistan
            svg.classList.add('has-land');
          })
          .catch(function () { /* the sphere, its grid and the plane still show */ });
      },
      draw: function (fraction) {
        var u = ease(fraction);
        var lam0 = UZ_LON - (1 - u) * TURN, lam0r = lam0 * RAD;
        gridEl.setAttribute('d', graticule(lam0));
        if (countries) {
          var fillD = '', lineD = '';
          countries.forEach(function (c) {
            if (c === uz) return;
            c.rings.forEach(function (r) { fillD += ringFill(r, lam0r); lineD += ringLine(r, lam0r); });
          });
          landEl.setAttribute('d', fillD);
          bordersEl.setAttribute('d', lineD);
          if (uz) uzEl.setAttribute('d', uz.rings.map(function (r) { return ringFill(r, lam0r); }).join(''));
        }
        var theta = START - u * 2 * Math.PI;              // one loop: in front from left to right, then behind
        trail(theta);
        var at = orbitPoint(theta), ahead = orbitPoint(theta - 0.02);
        var angle = Math.atan2(ahead[1] - at[1], ahead[0] - at[0]) / RAD;
        var inFront = at[2] >= 0;
        place(inFront ? planeFront : planeBack, at[0], at[1], angle);
        (inFront ? planeBack : planeFront).style.visibility = 'hidden';
      },
    };
  }
}());
