// The water surface under the home replay's top rule. One WebGL2 fragment shader, black and white (~3 KB gzipped).
// The canvas never paints a background. In dark it only adds light (screen); in light it only tints (multiply).
// So the page's own color always shows through and there is no band or seam to see.
// 30 fps cap, paused off-screen or in a hidden tab, DPR capped at 1.5. Reduced motion: one still frame.
// No WebGL2: the canvas is removed and the page stays plain design B.
// Text contrast over the water is tested in e2e/water.spec.ts; don't raise the dark `peak` without re-running it.
(() => {
  const bottle = document.querySelector(".replay");
  if (!bottle) return;
  const canvas = document.createElement("canvas");
  canvas.className = "water";
  canvas.setAttribute("aria-hidden", "true");
  bottle.prepend(canvas);
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) { canvas.remove(); return; }
  document.documentElement.classList.add("has-water");

  const vs = `#version 300 es
  in vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
  const fs = `#version 300 es
  precision highp float;
  uniform vec2 uRes; uniform float uDpr, uTime, uSurface, uHit, uDark, uHitX;
  uniform vec3 uLight, uTint, uLine;
  uniform float uCaustic, uBody, uPeak;
  out vec4 o;

  vec2 h2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
  float gn(vec2 p){ vec2 i = floor(p), f = fract(p), u = f*f*(3.0 - 2.0*f);
    float a = dot(h2(i) - 0.5, f), b = dot(h2(i + vec2(1, 0)) - 0.5, f - vec2(1, 0));
    float c = dot(h2(i + vec2(0, 1)) - 0.5, f - vec2(0, 1)), d = dot(h2(i + vec2(1, 1)) - 0.5, f - vec2(1, 1));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y); }

  // Caustics: light focused by the moving surface lands on a net of thin bright cell edges (F2 - F1).
  float net(vec2 x, float t, float w){
    vec2 n = floor(x), f = fract(x); float d1 = 8.0, d2 = 8.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(i, j), r = h2(n + g);
      vec2 q = g + 0.5 + 0.42*sin(t*0.55 + 6.2831*r) - f;
      float d = dot(q, q);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
    float e = 1.0 - smoothstep(0.0, w, sqrt(d2) - sqrt(d1));
    return e * e;
  }

  void main(){
    vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;   // CSS px from the top left of the section
    float H = uRes.y / uDpr, t = uTime;
    // The surface: a slow swell, and one ring when the lesson reaches it (uHit = seconds since, < 0 before).
    float ys = uSurface + 1.6*sin(px.x*0.0042 + t*0.5) + 0.8*sin(px.x*0.0117 - t*0.75);
    float flash = 0.0;
    if (uHit >= 0.0) {
      float r = abs(px.x - uHitX);
      float env = exp(-uHit*1.3) * exp(-r*0.003);
      ys += 4.0 * env * sin(r*0.05 - uHit*8.0);
      flash = exp(-uHit*1.2);
    }
    float d = px.y - ys, below = smoothstep(-0.7, 0.7, d), dd = max(d, 0.0);
    float fade = 1.0 - smoothstep(0.45, 1.0, px.y / H);      // nothing left by the bottom edge: no seam
    // Two octaves of warp bend the cell edges into the soft curves real caustics have.
    vec2 w = vec2(gn(px/170.0 + t*0.03), gn(px/170.0 + 9.1 - t*0.03)) * 2.0
           + vec2(gn(px/60.0 - t*0.05), gn(px/60.0 + 3.3 + t*0.05)) * 0.45;
    vec2 cp = px / vec2(115.0, 74.0) + w;
    float deep = 1.0 - exp(-dd/140.0);                         // deeper light is wider and dimmer
    float width = mix(0.07, 0.20, deep) * (0.8 + 0.4*gn(px/90.0 + 5.0));
    float c = net(cp, t, width) + 0.35*net(cp*1.8 + 4.0, t*1.15, width*1.2);
    float patchy = 0.35 + 0.65*smoothstep(-0.25, 0.35, gn(px/420.0 + vec2(t*0.015, 0.0)));
    c *= patchy * below * fade * exp(-dd/190.0);
    float line = exp(-d*d/1.1) ;
    float glow = below * exp(-dd/18.0);
    vec3 col;
    if (uDark > 0.5) {
      // Screen blend: black adds nothing. Light only, capped so text contrast holds.
      col = uLight * min(c * uCaustic, uPeak) + uLine * line * (0.55 + 0.4*flash) + uLight * glow * (0.05 + 0.10*flash) * fade;
    } else {
      // Multiply blend: white changes nothing. The water body tints; caustic lines stay bright; the meniscus is a fine dark line.
      float body = below * fade * uBody * (1.0 - exp(-dd/60.0));
      vec3 tint = mix(vec3(1.0), uTint, body);
      tint = mix(tint, vec3(1.0), clamp(c * uCaustic, 0.0, 1.0));
      tint = mix(tint, uLine, line * (0.6 + 0.3*flash));
      col = tint;
    }
    o = vec4(col, 1.0);
  }`;

  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog); gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(prog, n);
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

  const themes = {
    dark:  { light: "#ffffff", line: "#f5f5f5", tint: "#000000", caustic: 0.22, body: 0, peak: 0.085 },
    light: { light: "#ffffff", line: "#0a0a0a", tint: "#e4e4e4", caustic: 1.0, body: 1.0, peak: 1 },
  };
  const darkQ = matchMedia("(prefers-color-scheme: dark)");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hitAt = parseFloat(getComputedStyle(bottle).getPropertyValue("--done")) || 2.4;   // when the seal flips

  let dpr = 1, hitX = 260, surface = 44;
  const size = () => {
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const grid = bottle.querySelector(".grid");
    if (grid) surface = grid.getBoundingClientRect().top - canvas.getBoundingClientRect().top + 1;
    const seal = bottle.querySelector(".now");
    if (seal) { const s = seal.getBoundingClientRect(); hitX = s.left - canvas.getBoundingClientRect().left + s.width / 2; }
  };
  const draw = (t) => {
    const dark = darkQ.matches, th = themes[dark ? "dark" : "light"];
    canvas.style.mixBlendMode = dark ? "screen" : "multiply";
    gl.uniform2f(U("uRes"), canvas.width, canvas.height); gl.uniform1f(U("uDpr"), dpr);
    gl.uniform1f(U("uTime"), t); gl.uniform1f(U("uSurface"), surface); gl.uniform1f(U("uDark"), dark ? 1 : 0);
    gl.uniform1f(U("uHit"), reduce ? -1 : t - hitAt); gl.uniform1f(U("uHitX"), hitX);
    gl.uniform3fv(U("uLight"), rgb(th.light)); gl.uniform3fv(U("uLine"), rgb(th.line)); gl.uniform3fv(U("uTint"), rgb(th.tint));
    gl.uniform1f(U("uCaustic"), th.caustic); gl.uniform1f(U("uBody"), th.body); gl.uniform1f(U("uPeak"), th.peak);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const still = () => draw(8);
  size(); new ResizeObserver(() => { size(); if (reduce) still(); }).observe(bottle);
  darkQ.addEventListener("change", () => { if (reduce) still(); });
  if (reduce) { still(); return; }

  let visible = true, last = 0, raf = 0;
  const start = performance.now();
  const loop = (now) => {
    raf = 0;
    if (!visible || document.hidden) return;
    if (now - last >= 33) { last = now; draw((now - start) / 1000); }   // 30 fps is plenty for water
    raf = requestAnimationFrame(loop);
  };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible && !raf) raf = requestAnimationFrame(loop); }).observe(canvas);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !raf) raf = requestAnimationFrame(loop); });
  raf = requestAnimationFrame(loop);
})();
