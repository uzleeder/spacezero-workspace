/* Dashboard globe: a real turning sphere (orthographic projection) with Uzbekistan marked.
 * One 20-second loop:
 *   0 – 7 s    the plane flies once around the orbit (behind the globe on the far half)
 *   7 – 9.5 s  the globe brings Uzbekistan to the front and the plane lands in Tashkent
 *   9.5 – 17 s a fleet takes off from Tashkent for the world (gold trails over the horizon)
 *   17 – 20 s  the trails fade while the globe turns on, and the loop starts again
 * With "reduce motion" one still frame is drawn. Nothing runs while the globe is off screen.
 */
(function () {
  'use strict';
  var svg = document.querySelector('[data-globe]');
  if (!svg) return;
  var NS = 'http://www.w3.org/2000/svg';
  var RAD = Math.PI / 180;
  var CX = 204, CY = 133, R = 101;
  var TILT = 18 * RAD;                                  // we look at the globe slightly from above
  var ORX = 155, ORY = 48, OROT = -18 * RAD;            // the orbit ellipse (same as in the markup)
  var LOOP = 20;

  // Continents, coarse, as [x, y] on a 360 x 180 map (x = lon + 180, y = 90 - lat).
  var MAP = [
    [[15, 25], [40, 20], [85, 18], [105, 28], [125, 38], [115, 45], [100, 60], [83, 65], [75, 70], [63, 58], [55, 42], [40, 30]],
    [[100, 80], [120, 82], [145, 97], [140, 112], [122, 128], [110, 143], [105, 130], [110, 108], [100, 95]],
    [[170, 54], [171, 47], [178, 42], [185, 38], [190, 32], [205, 20], [220, 24], [220, 45], [208, 50], [195, 52]],
    [[163, 75], [175, 55], [190, 53], [212, 59], [223, 78], [231, 79], [220, 105], [215, 115], [200, 125], [192, 108], [189, 86], [172, 85]],
    [[220, 45], [240, 35], [260, 18], [290, 15], [320, 18], [350, 24], [340, 32], [320, 40], [310, 50], [300, 60], [288, 72], [280, 80], [260, 82], [252, 70], [238, 65], [228, 60]],
    [[294, 112], [310, 102], [325, 102], [333, 117], [325, 128], [310, 122], [295, 124]],
    [[120, 10], [140, 8], [155, 14], [145, 24], [128, 22]]
  ];
  var LAND = MAP.map(function (poly) { return densify(poly.map(function (p) { return [p[0] - 180, 90 - p[1]]; }), 3); });
  // Uzbekistan, [lon, lat]
  var UZ = densify([[56.0, 41.3], [56.0, 45.0], [58.6, 45.6], [61.0, 44.4], [62.0, 43.5], [65.0, 43.7], [66.1, 42.9], [68.0, 41.0], [69.0, 41.4], [71.0, 42.2], [73.1, 40.8], [71.5, 40.2], [70.5, 40.9], [69.3, 40.7], [68.5, 39.5], [67.4, 39.1], [67.4, 37.3], [66.5, 37.4], [64.5, 38.9], [62.4, 40.0], [61.0, 41.2], [58.0, 42.5], [57.0, 41.3]], 1);
  var TASHKENT = [69.24, 41.3];
  var DESTINATIONS = [[-74.0, 40.7], [-0.1, 51.5], [139.7, 35.7], [151.2, -33.9], [18.4, -33.9], [-46.6, -23.5]]; // New York, London, Tokyo, Sydney, Cape Town, São Paulo

  var el = function (sel) { return svg.querySelector(sel); };
  var gratEl = el('[data-graticule]'), landEl = el('[data-land]'), uzEl = el('[data-uz]');
  var markEl = el('[data-uz-mark]'), planeFront = el('[data-plane-front]'), planeBack = el('[data-plane-back]');
  var trailsEl = el('[data-trails]'), fleetEl = el('[data-fleet]');
  var fleet = DESTINATIONS.map(function (to) {
    var trail = document.createElementNS(NS, 'path'); trail.setAttribute('class', 'globe-trail'); trailsEl.appendChild(trail);
    var g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'globe-plane globe-plane--small');
    var use = document.createElementNS(NS, 'use'); use.setAttribute('href', '#workspace-aircraft'); g.appendChild(use); fleetEl.appendChild(g);
    return { from: vec(TASHKENT), to: vec(to), trail: trail, plane: g };
  });

  function densify(poly, step) {
    var out = [];
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      var n = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / step));
      for (var k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
    }
    return out;
  }
  function vec(ll) { var l = ll[0] * RAD, p = ll[1] * RAD; return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)]; }
  function unvec(v) { return [Math.atan2(v[1], v[0]) / RAD, Math.asin(Math.max(-1, Math.min(1, v[2]))) / RAD]; }
  function slerp(a, b, u) {
    var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2], w = Math.acos(Math.max(-1, Math.min(1, d))), s = Math.sin(w);
    if (s < 1e-6) return a;
    var ka = Math.sin((1 - u) * w) / s, kb = Math.sin(u * w) / s;
    return [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
  }
  // [screenX, screenY, depth]; depth > 0 is the side facing us
  function project(lon, lat, lam0) {
    var l = (lon - lam0) * RAD, p = lat * RAD;
    var x = R * Math.cos(p) * Math.sin(l);
    var y = R * (Math.cos(TILT) * Math.sin(p) - Math.sin(TILT) * Math.cos(p) * Math.cos(l));
    var z = Math.sin(TILT) * Math.sin(p) + Math.cos(TILT) * Math.cos(p) * Math.cos(l);
    return [CX + x, CY - y, z];
  }
  var f = function (n) { return Math.round(n * 10) / 10; };
  function polyPath(poly, lam0) {
    var pts = poly.map(function (q) { return project(q[0], q[1], lam0); });
    if (!pts.some(function (p) { return p[2] > 0; })) return '';
    return 'M' + pts.map(function (p) {
      if (p[2] > 0) return f(p[0]) + ' ' + f(p[1]);
      var dx = p[0] - CX, dy = p[1] - CY, k = R / (Math.hypot(dx, dy) || 1);   // far side: pinned to the edge of the globe
      return f(CX + dx * k) + ' ' + f(CY + dy * k);
    }).join('L') + 'Z';
  }
  function linePath(points) {   // only the parts on the near side
    var d = '', pen = false;
    points.forEach(function (p) {
      if (p[2] > 0.02) { d += (pen ? 'L' : 'M') + f(p[0]) + ' ' + f(p[1]); pen = true; } else pen = false;
    });
    return d;
  }
  function graticule(lam0) {
    var d = '', lon, lat, pts;
    for (lon = -180; lon < 180; lon += 30) { pts = []; for (lat = -90; lat <= 90; lat += 4) pts.push(project(lon, lat, lam0)); d += linePath(pts); }
    [-60, -30, 0, 30, 60].forEach(function (la) { pts = []; for (lon = -180; lon <= 180; lon += 4) pts.push(project(lon, la, lam0)); d += linePath(pts); });
    return d;
  }
  function orbitPoint(theta) {
    var lx = ORX * Math.cos(theta), ly = ORY * Math.sin(theta);
    return [CX + lx * Math.cos(OROT) - ly * Math.sin(OROT), CY + lx * Math.sin(OROT) + ly * Math.cos(OROT), ly];
  }
  function place(g, x, y, angle, scale, opacity) {
    g.setAttribute('transform', 'translate(' + f(x) + ' ' + f(y) + ') rotate(' + f(angle) + ') scale(' + scale + ')');
    g.style.opacity = opacity; g.style.visibility = opacity > 0.01 ? 'visible' : 'hidden';
  }
  var hide = function (g) { g.style.visibility = 'hidden'; };
  var heading = function (a, b) { return Math.atan2(b[1] - a[1], b[0] - a[0]) / RAD; };
  var clamp01 = function (u) { return Math.max(0, Math.min(1, u)); };
  var easeInOut = function (u) { return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; };
  function hermite(p0, p1, m0, m1, dur, u) {
    var u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 * dur + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1 * dur;
  }
  // The globe turns west to east all the time, slowing down to face Uzbekistan for the landing.
  var FACE = TASHKENT[0] - 8;
  function centerLon(t) {
    if (t < 9.5) return hermite(FACE + 200, FACE, -40, 0, 9.5, t / 9.5);
    if (t < 17) return hermite(FACE, FACE - 20, 0, -6, 7.5, (t - 9.5) / 7.5);
    return hermite(FACE - 20, FACE + 200 - 360, -6, -40, 3, (t - 17) / 3);
  }

  function frame(t) {
    var lam0 = centerLon(t);
    gratEl.setAttribute('d', graticule(lam0));
    landEl.setAttribute('d', LAND.map(function (p) { return polyPath(p, lam0); }).join(''));
    uzEl.setAttribute('d', polyPath(UZ, lam0));
    var tash = project(TASHKENT[0], TASHKENT[1], lam0);
    if (tash[2] > 0.15) { markEl.setAttribute('transform', 'translate(' + f(tash[0]) + ' ' + f(tash[1]) + ')'); markEl.style.visibility = 'visible'; markEl.style.opacity = Math.min(1, (tash[2] - 0.15) * 4); }
    else markEl.style.visibility = 'hidden';
    markEl.classList.toggle('is-busy', t > 8.8 && t < 15);

    // 1) once around the orbit, starting at its left end and passing in front first
    if (t < 7) {
      var th = Math.PI - 2 * Math.PI * (t / 7);
      var p = orbitPoint(th), q = orbitPoint(th - 0.02);
      var front = p[2] > 0;
      place(front ? planeFront : planeBack, p[0], p[1], heading(p, q), 0.62, 1);
      hide(front ? planeBack : planeFront);
    } else if (t < 9.5) {
      // 2) down to Tashkent on a curve, getting smaller as it lands
      hide(planeBack);
      var u = easeInOut((t - 7) / 2.5), p0 = orbitPoint(-Math.PI), p2 = tash;
      var p1 = [(p0[0] + p2[0]) / 2, Math.min(p0[1], p2[1]) - 55];
      var bz = function (s) { var a = 1 - s; return [a * a * p0[0] + 2 * a * s * p1[0] + s * s * p2[0], a * a * p0[1] + 2 * a * s * p1[1] + s * s * p2[1]]; };
      var pos = bz(u), ahead = bz(Math.min(1, u + 0.02));
      place(planeFront, pos[0], pos[1], u < 0.99 ? heading(pos, ahead) : 0, 0.62 - 0.36 * u, u > 0.85 ? (1 - u) / 0.15 : 1);
    } else { hide(planeFront); hide(planeBack); }

    // 3) the fleet leaves Uzbekistan in every direction
    fleet.forEach(function (fl, i) {
      var start = 9.6 + i * 0.5, dur = 4.6, u = clamp01((t - start) / dur);
      var fade = t > 16 ? clamp01(1 - (t - 16) / 2.5) : 1;
      if (t < start || fade <= 0) { fl.trail.setAttribute('d', ''); hide(fl.plane); return; }
      var pts = [];
      for (var k = 0; k <= 40; k++) { var s = (k / 40) * u, ll = unvec(slerp(fl.from, fl.to, s)); pts.push(project(ll[0], ll[1], lam0)); }
      fl.trail.setAttribute('d', linePath(pts));
      fl.trail.style.opacity = fade;
      var head = pts[pts.length - 1], next = unvec(slerp(fl.from, fl.to, Math.min(1, u + 0.01))), nx = project(next[0], next[1], lam0);
      if (u < 1 && head[2] > 0.03) place(fl.plane, head[0], head[1], heading(head, nx), 0.3, Math.min(1, head[2] * 5) * fade);
      else hide(fl.plane);
    });
  }

  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { frame(12); return; }
  var t0 = null, shown = true, raf = 0, last = 0;
  function tick(now) {
    raf = 0;
    if (t0 === null) t0 = now - last * 1000;
    last = ((now - t0) / 1000) % LOOP;
    frame(last);
    if (shown) raf = requestAnimationFrame(tick);
  }
  frame(0);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      shown = entries[0].isIntersecting;
      if (shown && !raf) { t0 = null; raf = requestAnimationFrame(tick); }
    }).observe(svg);
  } else raf = requestAnimationFrame(tick);
})();
