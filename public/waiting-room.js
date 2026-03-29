// ============================================================
// Waiting Room — Three.js scene with codrops SDF lens blur
// Shader adapted from https://github.com/guilanier/codrops-sdf-lensblur
// ============================================================

class WaitingRoom {
  constructor(container) {
    this.container = container;
    this.users = [];
    this.mouse = { x: 0, y: 0 };
    this.mouseDamp = { x: 0, y: 0 };
    this.hoveredUser = null;
    this.holdStart = 0;
    this.holding = false;
    this.holdTarget = null;
    this.onCallRequest = null;
    this.active = false;
    this.lastTime = 0;

    this._initThree();
    this._initEvents();
  }

  _initThree() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);

    // Offscreen canvas for rendering avatar photos
    this.avatarCanvas = document.createElement('canvas');
    this.avatarCanvas.width = w * dpr;
    this.avatarCanvas.height = h * dpr;
    this.avatarCtx = this.avatarCanvas.getContext('2d');

    // Three.js setup — mirrors the codrops structure
    this.scene = new THREE.Scene();
    this.vMouse = new THREE.Vector2();
    this.vMouseDamp = new THREE.Vector2();
    this.vResolution = new THREE.Vector2();

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.camera.position.z = 1;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.container.appendChild(this.renderer.domElement);

    // Avatar texture (updated each frame)
    this.avatarTexture = new THREE.CanvasTexture(this.avatarCanvas);
    this.avatarTexture.minFilter = THREE.LinearFilter;
    this.avatarTexture.magFilter = THREE.LinearFilter;

    const geo = new THREE.PlaneGeometry(1, 1);

    // Fragment shader adapted from codrops SDF lens blur
    const mat = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec2 v_texcoord;
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          v_texcoord = uv;
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 v_texcoord;
        uniform vec2 u_mouse;
        uniform vec2 u_resolution;
        uniform float u_pixelRatio;
        uniform sampler2D u_avatars;
        uniform float u_holdProgress;
        uniform float u_hasHover;
        uniform float u_time;

        #define PI 3.1415926535897932
        #define TWO_PI 6.2831853071795865

        // --- Coordinate utils from codrops ---
        vec2 coord(in vec2 p) {
          p = p / u_resolution.xy;
          if (u_resolution.x > u_resolution.y) {
            p.x *= u_resolution.x / u_resolution.y;
            p.x += (u_resolution.y - u_resolution.x) / u_resolution.y / 2.0;
          } else {
            p.y *= u_resolution.y / u_resolution.x;
            p.y += (u_resolution.x - u_resolution.y) / u_resolution.x / 2.0;
          }
          p -= 0.5;
          p *= vec2(-1.0, 1.0);
          return p;
        }

        // --- SDF functions from codrops ---
        float sdCircle(in vec2 st, in vec2 center) {
          return length(st - center) * 2.0;
        }

        float aastep(float threshold, float value) {
          float afwidth = length(vec2(dFdx(value), dFdy(value))) * 0.70710678118654757;
          return smoothstep(threshold - afwidth, threshold + afwidth, value);
        }

        float fill(in float x) { return 1.0 - aastep(0.0, x); }
        float fill(float x, float size, float edge) {
          return 1.0 - smoothstep(size - edge, size + edge, x);
        }

        float stroke(in float d, in float t) { return (1.0 - aastep(t, abs(d))); }
        float stroke(float x, float size, float w, float edge) {
          float d = smoothstep(size - edge, size + edge, x + w * 0.5)
                  - smoothstep(size - edge, size + edge, x - w * 0.5);
          return clamp(d, 0.0, 1.0);
        }

        void main() {
          vec2 st = coord(gl_FragCoord.xy) + 0.5;
          vec2 posMouse = coord(u_mouse * u_pixelRatio) * vec2(1., -1.) + 0.5;

          // --- Lens SDF circle (from codrops) ---
          // This is the core trick: the lens circle's fill value
          // is used as the 'edge' parameter for other shapes
          float lensSize = 0.25 + u_holdProgress * 0.1;
          float lensEdge = 0.45 + u_holdProgress * 0.15;
          float sdfLens = fill(
            sdCircle(st, posMouse),
            lensSize,
            lensEdge
          ) * u_hasHover;

          // --- Sample avatar texture ---
          vec2 uv = v_texcoord;
          vec4 texColor = texture2D(u_avatars, uv);

          // --- Apply the codrops-style SDF effect ---
          // Use the lens SDF to control edge sharpness of a full-screen circle
          // This creates the signature "blur-to-sharp" lens distortion
          float sdfBg = sdCircle(st, vec2(0.5));

          // Variation: stroke with edge controlled by lens proximity
          float shape = stroke(sdfBg, 0.9, 0.8, sdfLens) * 1.5;

          // Blend: outside lens = blurred/faded avatars, inside = clear
          // The SDF shape modulates visibility
          float clarity = clamp(sdfLens * 1.5, 0.0, 1.0);

          // Blurred version (offset sampling to simulate blur)
          vec2 pixel = 1.0 / u_resolution;
          vec4 blurred = vec4(0.0);
          float blurRadius = 8.0 * (1.0 - clarity);
          for (float i = -3.0; i <= 3.0; i += 1.0) {
            for (float j = -3.0; j <= 3.0; j += 1.0) {
              float w = exp(-0.5 * (i*i + j*j) / 4.5);
              blurred += texture2D(u_avatars, uv + vec2(i, j) * pixel * blurRadius) * w;
            }
          }
          blurred /= blurred.a > 0.0 ? blurred.a / texColor.a : 1.0;
          // Normalize
          float totalW = 0.0;
          vec4 blurNorm = vec4(0.0);
          for (float i = -3.0; i <= 3.0; i += 1.0) {
            for (float j = -3.0; j <= 3.0; j += 1.0) {
              float w = exp(-0.5 * (i*i + j*j) / 4.5);
              blurNorm += texture2D(u_avatars, uv + vec2(i, j) * pixel * blurRadius) * w;
              totalW += w;
            }
          }
          blurred = blurNorm / totalW;

          vec4 finalTex = mix(blurred, texColor, clarity);

          // --- SDF overlay: the geometric distortion ring ---
          // Stroke ring around the lens, edge controlled by lens SDF
          float ring = stroke(sdCircle(st, posMouse), lensSize * 2.0, 0.02, sdfLens * 0.5) * 3.0;

          // Chromatic aberration at lens boundary
          vec2 dir = normalize(st - posMouse) * sdfLens * 0.008;
          float chromR = texture2D(u_avatars, uv + dir).r;
          float chromB = texture2D(u_avatars, uv - dir).b;
          finalTex.r = mix(finalTex.r, chromR, sdfLens * 0.5);
          finalTex.b = mix(finalTex.b, chromB, sdfLens * 0.5);

          // Combine
          vec3 color = finalTex.rgb;

          // Add SDF ring as white overlay
          color += vec3(ring * 0.4) * u_hasHover;

          // --- Hold progress arc ---
          if (u_holdProgress > 0.01) {
            float angle = atan(st.y - posMouse.y, st.x - posMouse.x);
            float arcDist = sdCircle(st, posMouse);
            float arcRing = stroke(arcDist, lensSize * 2.2, 0.025, 0.02) * 4.0;

            float progress = u_holdProgress;
            float a = mod(angle + PI, TWO_PI) / TWO_PI;
            float arc = step(a, progress);

            color += vec3(0.5, 0.6, 1.0) * arcRing * arc;

            // Pulsing center glow
            float pulse = sin(u_time * 5.0) * 0.5 + 0.5;
            float centerGlow = fill(sdCircle(st, posMouse), lensSize, 0.3) * u_holdProgress;
            color += vec3(0.2, 0.3, 0.6) * centerGlow * pulse * 0.4;
          }

          gl_FragColor = vec4(color, 1.0);
        }
      `,
      uniforms: {
        u_mouse: { value: this.vMouseDamp },
        u_resolution: { value: this.vResolution },
        u_pixelRatio: { value: dpr },
        u_avatars: { value: this.avatarTexture },
        u_holdProgress: { value: 0.0 },
        u_hasHover: { value: 0.0 },
        u_time: { value: 0.0 }
      }
    });

    this.quad = new THREE.Mesh(geo, mat);
    this.scene.add(this.quad);
    this.material = mat;

    this.w = w;
    this.h = h;
    this.dpr = dpr;

    this._resize();
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);

    this.w = w;
    this.h = h;
    this.dpr = dpr;

    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(dpr);

    this.avatarCanvas.width = w * dpr;
    this.avatarCanvas.height = h * dpr;

    // Orthographic camera matching codrops setup
    this.camera.left = -w / 2;
    this.camera.right = w / 2;
    this.camera.top = h / 2;
    this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();

    this.quad.scale.set(w, h, 1);
    this.vResolution.set(w, h).multiplyScalar(dpr);
    this.material.uniforms.u_pixelRatio.value = dpr;
  }

  _initEvents() {
    const onMove = (e) => {
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      this.vMouse.set(x, y);
    };

    const onDown = (e) => {
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      this.vMouse.set(x, y);
      this._updateHover();

      if (this.hoveredUser) {
        this.holding = true;
        this.holdStart = Date.now();
        this.holdTarget = this.hoveredUser;
      }
    };

    const onUp = () => {
      this.holding = false;
      this.holdStart = 0;
      this.holdTarget = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('mousedown', onDown);
    window.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
    window.addEventListener('resize', () => this._resize());
  }

  start() {
    this.active = true;
    this.lastTime = performance.now() * 0.001;
    this._animate();
  }

  stop() {
    this.active = false;
  }

  updateUsers(userList, myId) {
    const currentIds = new Set(userList.map(u => u.id));
    this.users = this.users.filter(u => currentIds.has(u.id));

    for (const u of userList) {
      if (u.id === myId) continue;

      let existing = this.users.find(eu => eu.id === u.id);
      if (!existing) {
        const padding = 100;
        const newUser = {
          id: u.id,
          name: u.name,
          photo: u.photo,
          x: padding + Math.random() * (this.w - padding * 2),
          y: padding + Math.random() * (this.h - padding * 2),
          vx: (Math.random() - 0.5) * 0.3,
          vy: (Math.random() - 0.5) * 0.3,
          img: null,
          radius: 45
        };

        if (u.photo) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { newUser.img = img; };
          img.src = u.photo;
        }

        this.users.push(newUser);
      } else {
        existing.name = u.name;
        if (u.photo && u.photo !== existing.photo) {
          existing.photo = u.photo;
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { existing.img = img; };
          img.src = u.photo;
        }
      }
    }
  }

  _updateHover() {
    this.hoveredUser = null;
    const mx = this.vMouse.x;
    const my = this.vMouse.y;
    for (const u of this.users) {
      const dx = mx - u.x;
      const dy = my - u.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < u.radius + 30) {
        this.hoveredUser = u;
        break;
      }
    }
  }

  _drawAvatars() {
    const ctx = this.avatarCtx;
    const dpr = this.dpr;
    ctx.clearRect(0, 0, this.avatarCanvas.width, this.avatarCanvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    for (const u of this.users) {
      u.x += u.vx;
      u.y += u.vy;

      const pad = u.radius;
      if (u.x < pad || u.x > this.w - pad) u.vx *= -1;
      if (u.y < pad || u.y > this.h - pad) u.vy *= -1;
      u.x = Math.max(pad, Math.min(this.w - pad, u.x));
      u.y = Math.max(pad, Math.min(this.h - pad, u.y));

      // Circle avatar
      ctx.save();
      ctx.beginPath();
      ctx.arc(u.x, u.y, u.radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

      if (u.img) {
        ctx.drawImage(u.img, u.x - u.radius, u.y - u.radius, u.radius * 2, u.radius * 2);
      } else {
        ctx.fillStyle = '#333';
        ctx.fill();
        ctx.fillStyle = '#888';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(u.name[0] || '?', u.x, u.y);
      }
      ctx.restore();

      // Name label
      ctx.fillStyle = '#999';
      ctx.font = '12px "Helvetica Neue", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(u.name, u.x, u.y + u.radius + 16);
    }

    ctx.restore();
  }

  _animate() {
    if (!this.active) return;
    requestAnimationFrame(() => this._animate());

    const time = performance.now() * 0.001;
    const dt = time - this.lastTime;
    this.lastTime = time;

    // Mouse damping — exactly like codrops
    this.vMouseDamp.x = THREE.MathUtils.damp(this.vMouseDamp.x, this.vMouse.x, 8, dt);
    this.vMouseDamp.y = THREE.MathUtils.damp(this.vMouseDamp.y, this.vMouse.y, 8, dt);

    this._updateHover();

    // Hold progress
    let holdProgress = 0;
    if (this.holding && this.holdTarget) {
      holdProgress = Math.min((Date.now() - this.holdStart) / 2000, 1.0);
      if (holdProgress >= 1.0) {
        this.holding = false;
        if (this.onCallRequest) this.onCallRequest(this.holdTarget.id);
        this.holdStart = 0;
        this.holdTarget = null;
      }
    }

    // Draw avatars to offscreen canvas
    this._drawAvatars();

    // Update uniforms
    this.avatarTexture.needsUpdate = true;
    this.material.uniforms.u_holdProgress.value = holdProgress;
    this.material.uniforms.u_hasHover.value = this.hoveredUser ? 1.0 : 0.0;
    this.material.uniforms.u_time.value = time;

    // Hover name
    const hoverNameEl = document.getElementById('hover-name');
    if (hoverNameEl) {
      if (this.hoveredUser) {
        hoverNameEl.textContent = this.holding ? 'connecting...' : this.hoveredUser.name;
        hoverNameEl.style.opacity = '1';
      } else {
        hoverNameEl.style.opacity = '0';
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    this.active = false;
    if (this.renderer && this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
    this.renderer.dispose();
  }
}
