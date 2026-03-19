/* ========================================
   EARTH RENDERER
   ======================================== */

/**
 * Renders an orthographic projection of Earth centered on the Eastern US
 * (-75°W, 0°N) with a day/night terminator driven by the actual UTC time.
 *
 * Uses a pixel-by-pixel ray-cast approach:
 *  1. For each canvas pixel, map to a 3D sphere point (orthographic projection).
 *  2. Convert to geographic lat/lon → sample the equirectangular texture.
 *  3. Compute dot(surfaceNormal, sunDirection) → day/night shading.
 *  4. Blend in atmosphere rim and limb darkening.
 */
function initEarth() {
  const canvas = document.getElementById('earthCanvas');
  if (!canvas) return;

  // 2× resolution for retina / HiDPI displays
  const DISPLAY_PX = 260;
  const SIZE      = DISPLAY_PX * 2;       // canvas pixel size
  const R         = SIZE / 2;             // sphere radius in canvas pixels
  canvas.width  = SIZE;
  canvas.height = SIZE;
  canvas.style.width  = DISPLAY_PX + 'px';
  canvas.style.height = DISPLAY_PX + 'px';

  // Fixed viewpoint: centered on Eastern US
  const VIEW_LON_DEG = -75;
  const VIEW_LON_R   = VIEW_LON_DEG * Math.PI / 180;
  const cosV = Math.cos(VIEW_LON_R);
  const sinV = Math.sin(VIEW_LON_R);

  const PI = Math.PI;

  // Load the equirectangular NASA Blue Marble texture
  const img = new Image();
  img.crossOrigin = 'anonymous';
  // Path relative to index.html (root of Website/)
  img.src = (window.location.pathname.includes('/public/'))
    ? '../assets/images/earth_texture.jpg'
    : 'assets/images/earth_texture.jpg';

  let texPixels = null, TW = 0, TH = 0;

  img.onload = () => {
    const tc = document.createElement('canvas');
    tc.width  = img.width;
    tc.height = img.height;
    TW = img.width;
    TH = img.height;
    tc.getContext('2d').drawImage(img, 0, 0);
    texPixels = tc.getContext('2d').getImageData(0, 0, TW, TH).data;
    renderEarth();
    // Re-render every minute so the terminator stays current
    setInterval(renderEarth, 60 * 1000);
  };

  img.onerror = () => {
    // Texture failed to load — nothing to render, CSS fallback shows
    console.warn('Earth texture failed to load.');
  };

  /** Calculate where the sun is directly overhead right now (sub-solar point). */
  function getSubSolarPoint() {
    const now = new Date();

    // Day of year (1-based)
    const jan1  = new Date(now.getFullYear(), 0, 1);
    const dayN  = Math.ceil((now - jan1) / 86400000);

    // Solar declination (±23.45°, peaks at solstices)
    const decl  = -23.45 * Math.cos((2 * PI / 365) * (dayN + 10));

    // Sub-solar longitude: at UTC 12:00 it's 0°; moves 15°/hour westward
    const utcH  = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    const lon   = -(utcH - 12) * 15;  // degrees

    return { lat: decl, lon };
  }

  function renderEarth() {
    if (!texPixels) return;

    const { lat: sLat, lon: sLon } = getSubSolarPoint();

    // Sun unit-vector in world coords (lon=0°/lat=0° maps to +X axis)
    const sLat_r = sLat * PI / 180;
    const sLon_r = sLon * PI / 180;
    const sunX   = Math.cos(sLat_r) * Math.cos(sLon_r);
    const sunY   = Math.sin(sLat_r);
    const sunZ   = Math.cos(sLat_r) * Math.sin(sLon_r);

    const ctx     = canvas.getContext('2d');
    const imgData = ctx.createImageData(SIZE, SIZE);
    const d       = imgData.data;

    // Half-angle of civil twilight zone (in dot-product terms)
    const TWILIGHT  = Math.sin(8 * PI / 180);   // ±8° smooth transition
    const MIN_LIGHT = 0.04;                       // faint ambient on nightside

    for (let py = 0; py < SIZE; py++) {
      for (let px = 0; px < SIZE; px++) {
        // Normalised screen coords [-1, 1]; flip y so north = up
        const sx =  (px - R) / R;
        const sy = -(py - R) / R;   // flip

        const dist2 = sx * sx + sy * sy;
        if (dist2 > 1) continue;   // outside sphere → transparent

        const depth = Math.sqrt(1 - dist2);

        // --- Orthographic un-project: screen → world 3-D point ---------------
        // Camera is at viewLon on the equator, looking at Earth centre.
        // right = (-sinV, 0, cosV), up = (0, 1, 0), forward = (cosV, 0, sinV)
        //
        // Inverse of the projection matrix (2×2 for the X-Z plane):
        //   Px = depth·cosV − sx·sinV
        //   Py = sy
        //   Pz = depth·sinV + sx·cosV
        const Px = depth * cosV - sx * sinV;
        const Py = sy;
        const Pz = depth * sinV + sx * cosV;

        // Geographic coordinates
        const lat_r = Math.asin(Math.max(-1, Math.min(1, Py)));
        const lon_r = Math.atan2(Pz, Px);

        // --- Sample equirectangular texture -----------------------------------
        let u = (lon_r + PI) / (2 * PI);
        let v = (PI / 2 - lat_r) / PI;
        // Clamp to avoid out-of-range access
        const tx = Math.max(0, Math.min(TW - 1, Math.floor(u * TW)));
        const ty = Math.max(0, Math.min(TH - 1, Math.floor(v * TH)));
        const ti = (ty * TW + tx) * 4;

        let r = texPixels[ti];
        let g = texPixels[ti + 1];
        let b = texPixels[ti + 2];

        // --- Day / night shading ---------------------------------------------
        // dot > 0 = dayside, dot = 0 = terminator, dot < 0 = nightside
        const dot = Px * sunX + Py * sunY + Pz * sunZ;

        let light;
        if (dot > TWILIGHT) {
          light = 1.0;
        } else if (dot > -TWILIGHT) {
          light = (dot + TWILIGHT) / (2 * TWILIGHT);   // linear ramp in twilight
        } else {
          light = 0.0;
        }
        // Gamma-correct the ramp for a nicer visual falloff
        light = MIN_LIGHT + (1 - MIN_LIGHT) * Math.pow(light, 0.65);

        // --- Limb darkening (subtle) -----------------------------------------
        const limb = 0.82 + 0.18 * depth;   // 0.82 at edge → 1.0 at centre

        // --- Atmospheric scattering at the limb ------------------------------
        // Blend a blue-white atmosphere hue into pixels near the sphere edge
        const atmoD = Math.max(0, (0.18 - depth) / 0.18);  // 0→1 as edge is approached
        const atmoMix = atmoD * 0.55;
        r = r * (1 - atmoMix) + 40  * atmoMix;
        g = g * (1 - atmoMix) + 120 * atmoMix;
        b = b * (1 - atmoMix) + 220 * atmoMix;

        // Final colour
        const idx = (py * SIZE + px) * 4;
        d[idx]     = Math.round(Math.min(255, r * light * limb));
        d[idx + 1] = Math.round(Math.min(255, g * light * limb));
        d[idx + 2] = Math.round(Math.min(255, b * light * limb));
        d[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    // Subtle outer glow ring (thin atmosphere)
    const glow = ctx.createRadialGradient(R, R, R * 0.90, R, R, R);
    glow.addColorStop(0, 'rgba(60, 140, 255, 0)');
    glow.addColorStop(1, 'rgba(60, 160, 255, 0.18)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(R, R, R, 0, 2 * PI);
    ctx.fill();
  }
}

/* ========================================
   STARFIELD CANVAS
   ======================================== */
function initStarfield() {
  const canvas = document.getElementById('starfield');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let stars = [];
  const NUM_STARS = 280;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    generateStars();
  }

  function generateStars() {
    stars = [];
    for (let i = 0; i < NUM_STARS; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        radius: Math.random() * 1.3 + 0.2,
        opacity: Math.random() * 0.7 + 0.2,
        speed: Math.random() * 0.015 + 0.003,
        direction: Math.random() > 0.5 ? 1 : -1,
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    stars.forEach(s => {
      s.opacity += s.speed * s.direction;
      if (s.opacity >= 1) { s.opacity = 1; s.direction = -1; }
      if (s.opacity <= 0.1) { s.opacity = 0.1; s.direction = 1; }

      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200, 220, 255, ${s.opacity})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  resize();
  draw();
}

/* ========================================
   NAVIGATION – scroll & mobile toggle
   ======================================== */
function initNav() {
  const nav = document.getElementById('nav');
  const toggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');

  if (nav) {
    window.addEventListener('scroll', () => {
      nav.classList.toggle('scrolled', window.scrollY > 20);
    }, { passive: true });
  }

  if (toggle && navLinks) {
    toggle.addEventListener('click', () => {
      navLinks.classList.toggle('open');
    });

    // Close on link click (mobile)
    navLinks.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => navLinks.classList.remove('open'));
    });
  }
}

/* ========================================
   SCROLL REVEAL
   ======================================== */
function initScrollReveal() {
  const elements = document.querySelectorAll('.reveal');
  if (!elements.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const delay = parseInt(entry.target.dataset.delay) || 0;
        setTimeout(() => {
          entry.target.classList.add('visible');
        }, delay);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0 });

  elements.forEach(el => observer.observe(el));

  // Fallback: force-reveal any elements still hidden after 900ms.
  // Handles Windows Chrome timing quirks where in-viewport elements
  // don't reliably fire the IntersectionObserver callback on load.
  setTimeout(() => {
    document.querySelectorAll('.reveal:not(.visible)').forEach(el => {
      el.classList.add('visible');
    });
  }, 900);
}

/* ========================================
   CONTACT FORM (basic client-side)
   ======================================== */
function initContactForm() {
  const form = document.getElementById('contactForm');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.textContent = 'Message Sent ✓';
    btn.disabled = true;
    btn.style.background = 'transparent';
    btn.style.color = 'var(--accent)';
    btn.style.borderColor = 'var(--border-accent)';
    setTimeout(() => {
      btn.textContent = 'Send Message';
      btn.disabled = false;
      btn.style = '';
      form.reset();
    }, 4000);
  });
}

/* ========================================
   DETROIT ZOOM TRANSITION
   ======================================== */

/**
 * Intercepts the "About Me" button click, plays a cinematic zoom-into-Earth
 * animation aimed at Detroit, MI, then navigates to the about page.
 *
 * Detroit coordinates: 42.33°N, 83.05°W
 * Orthographic view centred at −75°W:
 *   screen_x = −0.104,  screen_y = 0.674  (normalised, from sphere centre)
 *   → canvas pixel (116.5, 42.4) in the 260px display canvas
 *   → wrapper pixel (126.5, 52.4) in the 280px .earth-wrapper
 */
function initDetroitZoom() {
  const btn = document.getElementById('aboutMeBtn');
  if (!btn) return;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const dest = btn.getAttribute('href');

    // Detroit's position as transform-origin inside .earth-wrapper (280×280 px)
    const DETROIT_X = 126.5;
    const DETROIT_Y = 52.4;

    const heroContent = document.querySelector('.hero-content');
    const scrollHint  = document.querySelector('.scroll-hint');
    const nav         = document.getElementById('nav');
    const wrapper     = document.querySelector('.earth-wrapper');
    const orbitPlanes = document.querySelectorAll('.orbit-plane');
    const starfield   = document.getElementById('starfield');

    // Phase 1 – fade out all UI except the Earth (400 ms)
    [...orbitPlanes, heroContent, scrollHint, nav, starfield]
      .filter(Boolean)
      .forEach(el => {
        el.style.transition   = 'opacity 0.4s ease';
        el.style.opacity      = '0';
        el.style.pointerEvents = 'none';
      });

    // Phase 2 – zoom Earth toward Detroit (starts at 350 ms, 1.65 s duration)
    setTimeout(() => {
      wrapper.style.transformOrigin = `${DETROIT_X}px ${DETROIT_Y}px`;
      wrapper.style.transition      = 'transform 1.65s cubic-bezier(0.4, 0, 1, 1)';
      wrapper.style.transform       = 'scale(12)';
      wrapper.style.zIndex          = '50';
    }, 350);

    // Phase 3 – dark overlay covers the pixelated zoom-end (starts at 1 800 ms)
    setTimeout(() => {
      const overlay = document.createElement('div');
      overlay.className = 'page-transition-overlay';
      document.body.appendChild(overlay);
      // Double rAF ensures the element is painted before the transition fires
      requestAnimationFrame(() =>
        requestAnimationFrame(() => overlay.classList.add('active'))
      );
    }, 1800);

    // Phase 4 – navigate (2 250 ms — overlay fully opaque by then)
    setTimeout(() => {
      window.location.href = dest;
    }, 2250);
  });
}

/* ========================================
   INIT
   ======================================== */
document.addEventListener('DOMContentLoaded', () => {
  initEarth();
  initStarfield();
  initNav();
  initScrollReveal();
  initContactForm();
  initDetroitZoom();
});
