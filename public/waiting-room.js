// ============================================================
// Waiting Room — Three.js scene with SDF lens blur
// ============================================================

class WaitingRoom {
  constructor(container) {
    this.container = container;
    this.users = []; // { id, name, photo, x, y, vx, vy, img, texture }
    this.mouse = { x: 0, y: 0 };
    this.mouseDamp = { x: 0, y: 0 };
    this.hoveredUser = null;
    this.holdStart = 0;
    this.holding = false;
    this.holdTarget = null;
    this.onCallRequest = null; // callback
    this.active = false;

    this._initThree();
    this._initEvents();
  }

  _initThree() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);

    // Offscreen canvas for rendering avatars
    this.avatarCanvas = document.createElement('canvas');
    this.avatarCanvas.width = w * dpr;
    this.avatarCanvas.height = h * dpr;
    this.avatarCtx = this.avatarCanvas.getContext('2d');

    // Three.js setup
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(dpr);
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Avatar texture (updated each frame from the offscreen canvas)
    this.avatarTexture = new THREE.CanvasTexture(this.avatarCanvas);
    this.avatarTexture.minFilter = THREE.LinearFilter;
    this.avatarTexture.magFilter = THREE.LinearFilter;

    // Full-screen quad with lens blur shader
    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        u_texture: { value: this.avatarTexture },
        u_mouse: { value: new THREE.Vector2(0.5, 0.5) },
        u_resolution: { value: new THREE.Vector2(w * dpr, h * dpr) },
        u_holdProgress: { value: 0.0 },
        u_hasHover: { value: 0.0 },
        u_time: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 v_uv;
        void main() {
          v_uv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 v_uv;
        uniform sampler2D u_texture;
        uniform vec2 u_mouse;
        uniform vec2 u_resolution;
        uniform float u_holdProgress;
        uniform float u_hasHover;
        uniform float u_time;

        // Gaussian blur by sampling in a circle pattern
        vec4 blur(sampler2D tex, vec2 uv, vec2 res, float radius) {
          vec4 sum = vec4(0.0);
          float total = 0.0;
          vec2 pixel = 1.0 / res;
          for (float x = -6.0; x <= 6.0; x += 1.0) {
            for (float y = -6.0; y <= 6.0; y += 1.0) {
              float d = length(vec2(x, y));
              if (d > 6.0) continue;
              float w = exp(-0.5 * d * d / max(radius * radius * 0.08, 0.01));
              sum += texture2D(tex, uv + vec2(x, y) * pixel * radius * 0.5) * w;
              total += w;
            }
          }
          return sum / total;
        }

        void main() {
          vec2 uv = v_uv;
          vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);

          // Distance from mouse (aspect-corrected)
          vec2 mouseUV = u_mouse;
          float dist = length((uv - mouseUV) * aspect);

          // Lens radius — grows slightly during hold
          float lensRadius = 0.12 + u_holdProgress * 0.05;

          // Blur amount: strong everywhere, clear inside lens
          float lensEdge = smoothstep(lensRadius, lensRadius * 0.3, dist);
          float blurAmount = mix(5.0, 0.0, lensEdge * u_hasHover);

          // Sample with blur
          vec4 blurred = blur(u_texture, uv, u_resolution, blurAmount);
          vec4 clear = texture2D(u_texture, uv);
          vec4 color = mix(blurred, clear, lensEdge * u_hasHover);

          // Chromatic aberration at lens edge (the codrops distortion feel)
          float ringZone = smoothstep(lensRadius * 0.9, lensRadius, dist) *
                          smoothstep(lensRadius * 1.3, lensRadius, dist);
          float aberration = ringZone * u_hasHover * (0.003 + u_holdProgress * 0.008);
          vec2 dir = normalize(uv - mouseUV) * aberration;
          color.r = mix(color.r, texture2D(u_texture, uv + dir).r, ringZone * u_hasHover);
          color.b = mix(color.b, texture2D(u_texture, uv - dir).b, ringZone * u_hasHover);

          // Hold progress ring
          if (u_holdProgress > 0.01) {
            float angle = atan(uv.y - mouseUV.y, (uv.x - mouseUV.x) * aspect.x);
            float ringDist = length((uv - mouseUV) * aspect);
            float ringRadius = lensRadius * 1.05;
            float ringWidth = 0.004 + u_holdProgress * 0.002;
            float ring = smoothstep(ringWidth, 0.0, abs(ringDist - ringRadius));

            // Progress arc
            float progress = u_holdProgress;
            float a = mod(angle + 3.14159, 6.28318) / 6.28318;
            float arc = step(a, progress);

            // Glow
            float glow = ring * arc;
            color.rgb += vec3(0.7, 0.8, 1.0) * glow * 0.8;
          }

          gl_FragColor = color;
        }
      `,
      transparent: true
    });

    this.quad = new THREE.Mesh(geo, mat);
    this.scene.add(this.quad);
    this.material = mat;

    this.w = w;
    this.h = h;
    this.dpr = dpr;
  }

  _initEvents() {
    const onMove = (e) => {
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      this.mouse.x = x;
      this.mouse.y = y;
    };

    const onDown = (e) => {
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      this.mouse.x = x;
      this.mouse.y = y;
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

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.renderer.setSize(w, h);
    this.avatarCanvas.width = w * dpr;
    this.avatarCanvas.height = h * dpr;
    this.material.uniforms.u_resolution.value.set(w * dpr, h * dpr);
  }

  start() {
    this.active = true;
    this._animate();
  }

  stop() {
    this.active = false;
  }

  updateUsers(userList, myId) {
    // Add new users, remove departed ones
    const currentIds = new Set(userList.map(u => u.id));
    // Remove users no longer in list
    this.users = this.users.filter(u => currentIds.has(u.id));

    for (const u of userList) {
      if (u.id === myId) continue; // don't show yourself

      let existing = this.users.find(eu => eu.id === u.id);
      if (!existing) {
        // New user — add with random position
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

        // Load profile photo
        if (u.photo) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { newUser.img = img; };
          img.src = u.photo;
        }

        this.users.push(newUser);
      } else {
        // Update existing user info
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
    for (const u of this.users) {
      const dx = this.mouse.x - u.x;
      const dy = this.mouse.y - u.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < u.radius + 20) {
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
      // Float animation — gentle drift
      u.x += u.vx;
      u.y += u.vy;

      // Bounce off walls
      const pad = u.radius;
      if (u.x < pad || u.x > this.w - pad) u.vx *= -1;
      if (u.y < pad || u.y > this.h - pad) u.vy *= -1;
      u.x = Math.max(pad, Math.min(this.w - pad, u.x));
      u.y = Math.max(pad, Math.min(this.h - pad, u.y));

      // Draw circle avatar
      ctx.save();
      ctx.beginPath();
      ctx.arc(u.x, u.y, u.radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

      if (u.img) {
        ctx.drawImage(u.img, u.x - u.radius, u.y - u.radius, u.radius * 2, u.radius * 2);
      } else {
        // Placeholder circle
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
      ctx.fillStyle = '#ccc';
      ctx.font = '13px "Helvetica Neue", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(u.name, u.x, u.y + u.radius + 18);
    }

    ctx.restore();
  }

  _animate() {
    if (!this.active) return;
    requestAnimationFrame(() => this._animate());

    // Smooth mouse damping
    this.mouseDamp.x += (this.mouse.x - this.mouseDamp.x) * 0.1;
    this.mouseDamp.y += (this.mouse.y - this.mouseDamp.y) * 0.1;

    // Update hover
    this._updateHover();

    // Handle hold progress
    let holdProgress = 0;
    if (this.holding && this.holdTarget) {
      const elapsed = (Date.now() - this.holdStart) / 2000; // 2 seconds
      holdProgress = Math.min(elapsed, 1.0);

      if (holdProgress >= 1.0) {
        // Call request!
        this.holding = false;
        if (this.onCallRequest) {
          this.onCallRequest(this.holdTarget.id);
        }
        this.holdStart = 0;
        this.holdTarget = null;
      }
    }

    // Draw avatars to offscreen canvas
    this._drawAvatars();

    // Update Three.js uniforms
    this.avatarTexture.needsUpdate = true;
    this.material.uniforms.u_mouse.value.set(
      this.mouseDamp.x / this.w,
      1.0 - this.mouseDamp.y / this.h // flip Y for shader
    );
    this.material.uniforms.u_holdProgress.value = holdProgress;
    this.material.uniforms.u_hasHover.value = this.hoveredUser ? 1.0 : 0.0;
    this.material.uniforms.u_time.value = performance.now() * 0.001;

    // Update hover name display
    const hoverNameEl = document.getElementById('hover-name');
    if (hoverNameEl) {
      if (this.hoveredUser) {
        hoverNameEl.textContent = this.holding ? 'connecting...' : this.hoveredUser.name;
        hoverNameEl.style.opacity = '1';
      } else {
        hoverNameEl.style.opacity = '0';
      }
    }

    // Render
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
