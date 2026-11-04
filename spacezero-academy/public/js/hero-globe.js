/* Dashboard globe: a real turning sphere (orthographic projection) with every country and its borders,
 * Uzbekistan marked, and flights from Tashkent International (TAS).
 * Map data: Natural Earth 1:110m countries (public domain) via world-atlas 2.0.2 (ISC),
 * served from /static/data/world-countries-110m.json (TopoJSON, decoded here).
 *
 * One 30-second loop:
 *   0 – 12 s     the plane flies once around the orbit (behind the globe on the far half)
 *   12 – 17.5 s  the globe settles with Uzbekistan in front; the plane slows down all the way in,
 *                glides down and touches down just west of Tashkent
 *   17.5 – 19 s  it rolls along the ground to TAS and stops
 *   19.6 – 29 s  planes take off from TAS for JFK, LHR, IST, DXB, ICN and DEL (trails over the horizon),
 *                the trails fade and the loop starts again
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
  var SIN_T = Math.sin(TILT), COS_T = Math.cos(TILT);
  var ORX = 155, ORY = 48, OROT = -18 * RAD;            // the orbit ellipse (same as in the markup)
  var LOOP = 30;
  var ORBIT_END = 12, TOUCHDOWN = 17.5, PARKED = 19, FLEET = 19.6, FADE = 26.5;

  // Airports: [lon, lat] of the airport itself
  var TAS = { code: 'TAS', city: 'Tashkent', at: [69.2812, 41.2579] };
  var ROUTES = [
    { code: 'JFK', city: 'New York', at: [-73.7781, 40.6413], side: 'left' },
    { code: 'LHR', city: 'London', at: [-0.4543, 51.4700], side: 'left' },
    { code: 'IST', city: 'Istanbul', at: [28.7519, 41.2753], side: 'left' },
    { code: 'DXB', city: 'Dubai', at: [55.3657, 25.2532], side: 'left' },
    { code: 'ICN', city: 'Seoul', at: [126.4407, 37.4602], side: 'right' },
    { code: 'DEL', city: 'Delhi', at: [77.1000, 28.5562], side: 'right' }
  ];
  var UZ_LABEL_AT = [63.5, 47.2];                        // where the country name sits (just above the country)

  var el = function (sel) { return svg.querySelector(sel); };
  var gratEl = el('[data-graticule]'), landEl = el('[data-land]'), bordersEl = el('[data-borders]'), uzEl = el('[data-uz]');
  var markEl = el('[data-uz-mark]'), uzNameEl = el('[data-uz-name]'), planeFront = el('[data-plane-front]'), planeBack = el('[data-plane-back]');
  var trailsEl = el('[data-trails]'), fleetEl = el('[data-fleet]'), portsEl = el('[data-ports]');

  var countries = [], uzRings = [];
  function mk(tag, cls, parent) { var n = document.createElementNS(NS, tag); if (cls) n.setAttribute('class', cls); parent.appendChild(n); return n; }

  var fleet = ROUTES.map(function (r, i) {
    var trail = mk('path', 'globe-trail', trailsEl);
    var g = mk('g', 'globe-plane globe-plane--small', fleetEl);
    mk('use', '', g).setAttribute('href', '#workspace-aircraft');
    var port = mk('g', 'globe-port', portsEl);
    mk('circle', 'globe-port-dot', port).setAttribute('r', '1.8');
    var label = mk('text', 'globe-port-label', port);
    label.textContent = r.code;                            // abroad only the airport code; Uzbekistan keeps its full names
    var left = r.side === 'left';                         // each label keeps one side, so neighbours do not overlap
    label.setAttribute('text-anchor', left ? 'end' : 'start'); label.setAttribute('x', left ? '-4' : '4'); label.setAttribute('y', '2.6');
    var from = vec(TAS.at), to = vec(r.at);
    var angle = Math.acos(Math.max(-1, Math.min(1, from[0] * to[0] + from[1] * to[1] + from[2] * to[2])));
    return { route: r, from: from, to: to, trail: trail, plane: g, port: port, label: label, start: FLEET + i * 0.45, dur: 2.2 + 3.4 * angle / Math.PI };
  });

  // Tapping the globe launches more flights, one per tap, between real airports (the busier, the more you tap).
  var MORE_AIRPORTS = [
    TAS, ROUTES[0], ROUTES[1], ROUTES[2], ROUTES[3], ROUTES[4], ROUTES[5],
    { code: 'FRA', at: [8.5622, 50.0379] }, { code: 'CDG', at: [2.5479, 49.0097] }, { code: 'SVO', at: [37.4146, 55.9726] },
    { code: 'DOH', at: [51.6081, 25.2731] }, { code: 'CAI', at: [31.4056, 30.1219] }, { code: 'JNB', at: [28.2460, -26.1392] },
    { code: 'ALA', at: [77.0405, 43.3521] }, { code: 'PEK', at: [116.5975, 40.0799] }, { code: 'BKK', at: [100.7501, 13.6900] },
    { code: 'SIN', at: [103.9894, 1.3644] }, { code: 'SYD', at: [151.1772, -33.9399] }, { code: 'LAX', at: [-118.4085, 33.9416] },
    { code: 'GRU', at: [-46.4730, -23.4356] }
  ];
  var MAX_EXTRA = 30;
  var extra = [], clock = 0, lastLam = 0;
  function launch(lam0) {
    var facing = MORE_AIRPORTS.filter(function (a) { return project(a.at[0], a.at[1], lam0)[2] > 0.3; });
    var from = facing.length ? facing[Math.floor(Math.random() * facing.length)] : TAS;
    var choices = MORE_AIRPORTS.filter(function (a) {
      if (a === from) return false;
      var p = vec(from.at), q = vec(a.at);
      return Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]))) > 15 * RAD;   // not next door
    });
    var to = choices[Math.floor(Math.random() * choices.length)];
    var trail = mk('path', 'globe-trail globe-trail--extra', trailsEl);
    var g = mk('g', 'globe-plane globe-plane--small', fleetEl);
    mk('use', '', g).setAttribute('href', '#workspace-aircraft');
    var port = mk('g', 'globe-port', portsEl);
    mk('circle', 'globe-port-dot', port).setAttribute('r', '1.6');
    var label = mk('text', 'globe-port-label', port);
    label.textContent = to.code; label.setAttribute('x', '4'); label.setAttribute('y', '2.6');
    var a = vec(from.at), b = vec(to.at);
    var angle = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    extra.push({ route: to, from: a, to: b, trail: trail, plane: g, port: port, born: clock, dur: 2.4 + 3.6 * angle / Math.PI });
    while (extra.length > MAX_EXTRA) drop(extra.shift());
  }
  function drop(fl) { fl.trail.remove(); fl.plane.remove(); fl.port.remove(); }
  function drawFlight(fl, u, fade, lam0) {
    var pts = [];
    for (var k = 0; k <= 40; k++) { var ll = unvec(slerp(fl.from, fl.to, (k / 40) * u)); pts.push(project(ll[0], ll[1], lam0)); }
    fl.trail.setAttribute('d', linePath(pts));
    fl.trail.style.opacity = fade;
    var head = pts[pts.length - 1], next = unvec(slerp(fl.from, fl.to, Math.min(1, u + 0.01))), nx = project(next[0], next[1], lam0);
    if (u < 1 && head[2] > 0.03) place(fl.plane, head[0], head[1], heading(head, nx), 0.3, Math.min(1, head[2] * 5) * fade);
    else hide(fl.plane);
    var port = project(fl.route.at[0], fl.route.at[1], lam0);
    if (port[2] > 0.12) place(fl.port, port[0], port[1], null, 1, Math.min(1, (port[2] - 0.12) * 4) * fade * Math.min(1, u * 3));
    else hide(fl.port);
  }

  // ---- geometry ----
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
    var l = (lon - lam0) * RAD, p = lat * RAD, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l);
    return [CX + R * cp * Math.sin(l), CY - R * (COS_T * sp - SIN_T * cp * cl), SIN_T * sp + COS_T * cp * cl];
  }
  // a ring prepared once: radians and the latitude terms, so a frame only needs sin/cos of the longitude
  function prep(ring) {
    var n = ring.length, out = { lon: new Float64Array(n), cp: new Float64Array(n), sp: new Float64Array(n) };
    for (var i = 0; i < n; i++) { out.lon[i] = ring[i][0] * RAD; out.cp[i] = Math.cos(ring[i][1] * RAD); out.sp[i] = Math.sin(ring[i][1] * RAD); }
    return out;
  }
  var f = function (n) { return Math.round(n * 10) / 10; };
  // fill outline: points on the far side are pinned to the edge of the globe, so a country cut by the horizon is cut there
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

  // ---- TopoJSON (world-atlas) to rings of [lon, lat] ----
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
      return { id: g.id, name: g.properties && g.properties.name, rings: rings };
    });
  }

  // ---- motion helpers ----
  function orbitPoint(theta) {
    var lx = ORX * Math.cos(theta), ly = ORY * Math.sin(theta);
    return [CX + lx * Math.cos(OROT) - ly * Math.sin(OROT), CY + lx * Math.sin(OROT) + ly * Math.cos(OROT), ly];
  }
  function place(g, x, y, angle, scale, opacity) {
    g.setAttribute('transform', 'translate(' + f(x) + ' ' + f(y) + ')' + (angle === null ? '' : ' rotate(' + f(angle) + ')') + (scale === 1 ? '' : ' scale(' + scale + ')'));
    g.style.opacity = opacity; g.style.visibility = opacity > 0.01 ? 'visible' : 'hidden';
  }
  var hide = function (g) { g.style.visibility = 'hidden'; };
  var heading = function (a, b) { return Math.atan2(b[1] - a[1], b[0] - a[0]) / RAD; };
  var clamp01 = function (u) { return Math.max(0, Math.min(1, u)); };
  function hermite(p0, p1, m0, m1, dur, u) {
    var u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 * dur + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1 * dur;
  }
  // The globe turns west to east all the time, slowing down to face Uzbekistan for the landing.
  var FACE = TAS.at[0] - 14;
  var RUNWAY = 4;                                       // degrees of longitude rolled out on the ground before TAS
  function centerLon(t) {
    if (t < TOUCHDOWN) return hermite(FACE + 280, FACE, -22, 0, TOUCHDOWN, t / TOUCHDOWN);       // comes to rest for the landing
    if (t < 27.5) return hermite(FACE, FACE - 20, 0, -6, 27.5 - TOUCHDOWN, (t - TOUCHDOWN) / (27.5 - TOUCHDOWN));
    return hermite(FACE - 20, FACE + 280 - 360, -6, -22, LOOP - 27.5, (t - 27.5) / (LOOP - 27.5));
  }

  function frame(t) {
    var lam0 = centerLon(t), lam0r = lam0 * RAD;
    gratEl.setAttribute('d', graticule(lam0));
    if (countries.length) {
      var fill = '', lines = '';
      countries.forEach(function (c) { c.rings.forEach(function (r) { fill += ringFill(r, lam0r); lines += ringLine(r, lam0r); }); });
      landEl.setAttribute('d', fill);
      bordersEl.setAttribute('d', lines);
      uzEl.setAttribute('d', uzRings.map(function (r) { return ringFill(r, lam0r); }).join(''));
    }
    var tas = project(TAS.at[0], TAS.at[1], lam0);
    if (tas[2] > 0.15) { place(markEl, tas[0], tas[1], null, 1, Math.min(1, (tas[2] - 0.15) * 4)); } else hide(markEl);
    var nameAt = project(UZ_LABEL_AT[0], UZ_LABEL_AT[1], lam0);
    if (nameAt[2] > 0.2) place(uzNameEl, nameAt[0], nameAt[1], null, 1, Math.min(1, (nameAt[2] - 0.2) * 4)); else hide(uzNameEl);
    markEl.classList.toggle('is-busy', t > 16.5 && t < 25);

    // 1) once around the orbit, starting at its left end and passing in front first
    if (t < ORBIT_END) {
      var th = Math.PI - 2 * Math.PI * (t / ORBIT_END);
      var p = orbitPoint(th), q = orbitPoint(th - 0.02);
      var front = p[2] > 0;
      place(front ? planeFront : planeBack, p[0], p[1], heading(p, q), 0.62, 1);
      hide(front ? planeBack : planeFront);
    } else if (t < TOUCHDOWN) {
      // 2) the approach: slower and slower, descending on a shallow glide path to touch down west of TAS
      hide(planeBack);
      var v = (t - ORBIT_END) / (TOUCHDOWN - ORBIT_END), u = 1 - Math.pow(1 - v, 1.7);
      var p0 = orbitPoint(-Math.PI), td = project(TAS.at[0] - RUNWAY, TAS.at[1], lam0);
      var p1 = [td[0] - 75, td[1] - 16];                                   // the last part of the curve is a gentle glide
      var bz = function (s) { var a = 1 - s; return [a * a * p0[0] + 2 * a * s * p1[0] + s * s * td[0], a * a * p0[1] + 2 * a * s * p1[1] + s * s * td[1]]; };
      var pos = bz(u), ahead = bz(Math.min(1, u + 0.01));
      if (u > 0.995) ahead = tas;
      place(planeFront, pos[0], pos[1], heading(pos, ahead), 0.62 - 0.34 * u, 1);
    } else if (t < FLEET) {
      // 3) on the ground: it rolls to TAS, brakes to a stop, and is parked when the fleet takes off
      hide(planeBack);
      var r = 1 - Math.pow(1 - clamp01((t - TOUCHDOWN) / (PARKED - TOUCHDOWN)), 2);
      var g = project(TAS.at[0] - RUNWAY * (1 - r), TAS.at[1], lam0);
      place(planeFront, g[0], g[1], heading(project(TAS.at[0] - RUNWAY, TAS.at[1], lam0), tas), 0.28, t > PARKED ? clamp01(1 - (t - PARKED) / (FLEET - PARKED)) : 1);
    } else { hide(planeFront); hide(planeBack); }

    // 3) the fleet leaves TAS for its airports
    fleet.forEach(function (fl) {
      var u = clamp01((t - fl.start) / fl.dur);
      var fade = t > FADE ? clamp01(1 - (t - FADE) / 2.5) : 1;
      if (t < fl.start || fade <= 0) { fl.trail.setAttribute('d', ''); hide(fl.plane); hide(fl.port); return; }
      var pts = [];
      for (var k = 0; k <= 40; k++) { var ll = unvec(slerp(fl.from, fl.to, (k / 40) * u)); pts.push(project(ll[0], ll[1], lam0)); }
      fl.trail.setAttribute('d', linePath(pts));
      fl.trail.style.opacity = fade;
      var head = pts[pts.length - 1], next = unvec(slerp(fl.from, fl.to, Math.min(1, u + 0.01))), nx = project(next[0], next[1], lam0);
      if (u < 1 && head[2] > 0.03) place(fl.plane, head[0], head[1], heading(head, nx), 0.3, Math.min(1, head[2] * 5) * fade);
      else hide(fl.plane);
      // the destination airport shows once the plane is on its way, while it faces us
      var port = project(fl.route.at[0], fl.route.at[1], lam0);
      if (port[2] > 0.12) {
        place(fl.port, port[0], port[1], null, 1, Math.min(1, (port[2] - 0.12) * 4) * fade * Math.min(1, u * 3));
      } else hide(fl.port);
    });

    // 4) the flights launched by tapping the globe; each fades out after landing and is removed
    lastLam = lam0;
    extra = extra.filter(function (fl) {
      var age = clock - fl.born, u = clamp01(age / fl.dur), fade = age > fl.dur ? clamp01(1 - (age - fl.dur) / 2.5) : 1;
      if (fade <= 0) { drop(fl); return false; }
      drawFlight(fl, u, fade, lam0);
      return true;
    });
  }

  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var t0 = null, shown = true, raf = 0, last = 0, lastDraw = 0;
  function tick(now) {
    raf = 0;
    if (t0 === null) t0 = now - last * 1000;
    clock = now / 1000;
    if (now - lastDraw > 30) { last = ((now - t0) / 1000) % LOOP; frame(last); lastDraw = now; }   // ~30 frames a second is plenty
    if (shown) raf = requestAnimationFrame(tick);
  }
  function start() {
    if (reduce) { frame(22.5); return; }
    svg.classList.add('is-tappable');
    svg.addEventListener('click', function () { launch(lastLam); });
    frame(0);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        shown = entries[0].isIntersecting;
        if (shown && !raf) { t0 = null; raf = requestAnimationFrame(tick); }
      }).observe(svg);
    } else raf = requestAnimationFrame(tick);
  }
  var url = svg.getAttribute('data-world');
  if (url && window.fetch) {
    fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (topo) {
      if (topo) {
        countries = decode(topo);
        var uz = countries.filter(function (c) { return c.id === '860'; })[0];
        uzRings = uz ? uz.rings : [];
      }
      if (reduce) frame(22.5);
    }).catch(function () { /* the globe still turns, without countries */ });
  }
  start();
})();
