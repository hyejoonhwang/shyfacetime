// ============================================================
// Waiting Room — SDF Lens Blur on avatar circles
// Shader technique from https://github.com/guilanier/codrops-sdf-lensblur
// The lens (cursor) controls the edge sharpness of each avatar circle
// ============================================================

const MAX_USERS = 20;

class WaitingRoom {
  constructor(container) {
    this.container = container;
    this.users = [];
    this.hoveredUser = null;
    this.holdStart = 0;
    this.holding = false;
    this.holdTarget = null;
    this.onCallRequest = null;
    this.active = false;
    this.lastTime = 0;

    this.vMouse = new THREE.Vector2();
    this.vMouseDamp = new THREE.Vector2();
    this.vResolution = new THREE.Vector2();

    this._initThree();
    this._initEvents();
  }

  _initThree() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);

    this.w = w;
    this.h = h;
    this.dpr = dpr;

    // Offscreen canvas: avatar photos drawn here, used as texture
    this.photoCanvas = document.createElement('canvas');
    this.photoCanvas.width = w * dpr;
    this.photoCanvas.height = h * dpr;
    this.photoCtx = this.photoCanvas.getContext('2d');

    this.photoTexture = new THREE.CanvasTexture(this.photoCanvas);
    this.photoTexture.minFilter = THREE.LinearFilter;
    this.photoTexture.magFilter = THREE.LinearFilter;

    // Three.js — matching codrops structure exactly
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.camera.position.z = 1;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.container.appendChild(this.renderer.domElement);

    // Avatar positions as uniform array
    const posArray = [];
    const radArray = [];
    for (let i = 0; i < MAX_USERS; i++) {
      posArray.push(new THREE.Vector2(0, 0));
      radArray.push(0.0);
    }

    const geo = new THREE.PlaneGeometry(1, 1);
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
        uniform sampler2D u_photos;
        uniform float u_holdProgress;
        uniform float u_hasHover;
        uniform float u_time;

        // Avatar data
        uniform vec2 u_positions[${MAX_USERS}];
        uniform float u_radii[${MAX_USERS}];
        uniform int u_count;

        #define PI 3.1415926535897932
        #define TWO_PI 6.2831853071795865

        // --- Coordinate utils (from codrops) ---
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

        // --- SDF functions (from codrops) ---
        float sdCircle(in vec2 st, in vec2 center) {
          return length(st - center) * 2.0;
        }

        float aastep(float threshold, float value) {
          float afwidth = length(vec2(dFdx(value), dFdy(value))) * 0.70710678118654757;
          return smoothstep(threshold - afwidth, threshold + afwidth, value);
        }

        float fill(float x, float size, float edge) {
          return 1.0 - smoothstep(size - edge, size + edge, x);
        }

        float stroke(float x, float size, float w, float edge) {
          float d = smoothstep(size - edge, size + edge, x + w * 0.5)
                  - smoothstep(size - edge, size + edge, x - w * 0.5);
          return clamp(d, 0.0, 1.0);
        }

        void main() {
          vec2 st = coord(gl_FragCoord.xy) + 0.5;
          vec2 posMouse = coord(u_mouse * u_pixelRatio) * vec2(1.0, -1.0) + 0.5;
          vec2 uv = v_texcoord;

          // --- Lens SDF (from codrops): circle around cursor ---
          float lensCircleSize = 0.25 + u_holdProgress * 0.1;
          float lensCircleEdge = 0.5 + u_holdProgress * 0.2;
          float sdfLens = fill(
            sdCircle(st, posMouse),
            lensCircleSize,
            lensCircleEdge
          ) * u_hasHover;

          // --- Background ---
          vec3 color = vec3(0.04);

          // --- Render each avatar as SDF circle ---
          // Edge controlled by lens proximity (the codrops technique)
          for (int i = 0; i < ${MAX_USERS}; i++) {
            if (i >= u_count) break;

            vec2 avatarSt = u_positions[i];
            float avatarRad = u_radii[i];

            float d = sdCircle(st, avatarSt);

            // THE KEY: lens SDF value controls the edge parameter
            // Far from cursor: sdfLens ~0 → large edge → soft/blurry circle
            // Near cursor: sdfLens ~1 → small edge → sharp circle
            float baseEdge = 0.5;  // default: very soft
            float sharpEdge = 0.01; // when lens is active: crisp
            float edge = mix(baseEdge, sharpEdge, sdfLens);

            // Circle fill with lens-controlled edge
            float avatarFill = fill(d, avatarRad, edge);

            // Stroke ring that appears with lens
            float avatarStroke = stroke(d, avatarRad, 0.008, edge) * 2.0 * sdfLens;

            // Sample photo texture
            vec4 photo = texture2D(u_photos, uv);

            // Blurred photo sample (for soft state)
            vec2 pixel = 1.0 / u_resolution;
            vec4 blurredPhoto = vec4(0.0);
            float tw = 0.0;
            float blurAmt = 6.0 * (1.0 - sdfLens);
            for (float bx = -3.0; bx <= 3.0; bx += 1.5) {
              for (float by = -3.0; by <= 3.0; by += 1.5) {
                float bw = exp(-0.5 * (bx*bx + by*by) / 4.0);
                blurredPhoto += texture2D(u_photos, uv + vec2(bx, by) * pixel * blurAmt) * bw;
                tw += bw;
              }
            }
            blurredPhoto /= tw;

            // Mix clear and blurred based on lens
            vec4 finalPhoto = mix(blurredPhoto, photo, sdfLens);

            // Apply to color
            color = mix(color, finalPhoto.rgb, avatarFill);

            // Add stroke ring (white, subtle)
            color += vec3(0.6) * avatarStroke;
          }

          // --- Hold progress arc ---
          if (u_holdProgress > 0.01) {
            float angle = atan(st.y - posMouse.y, st.x - posMouse.x);
            float d = sdCircle(st, posMouse);
            float arcStroke = stroke(d, lensCircleSize * 2.0, 0.015, 0.02) * 3.0;

            float a = mod(angle + PI, TWO_PI) / TWO_PI;
            float arc = step(a, u_holdProgress);

            color += vec3(0.5, 0.6, 1.0) * arcStroke * arc;
          }

          gl_FragColor = vec4(color, 1.0);
        }
      `,
      uniforms: {
        u_mouse: { value: this.vMouseDamp },
        u_resolution: { value: this.vResolution },
        u_pixelRatio: { value: dpr },
        u_photos: { value: this.photoTexture },
        u_holdProgress: { value: 0.0 },
        u_hasHover: { value: 0.0 },
        u_time: { value: 0.0 },
        u_positions: { value: posArray },
        u_radii: { value: radArray },
        u_count: { value: 0 }
      }
    });

    this.quad = new THREE.Mesh(geo, mat);
    this.scene.add(this.quad);
    this.material = mat;

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

    this.photoCanvas.width = w * dpr;
    this.photoCanvas.height = h * dpr;

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
      this.vMouse.set(
        e.touches ? e.touches[0].clientX : e.clientX,
        e.touches ? e.touches[0].clientY : e.clientY
      );
    };

    const onDown = (e) => {
      this.vMouse.set(
        e.touches ? e.touches[0].clientX : e.clientX,
        e.touches ? e.touches[0].clientY : e.clientY
      );
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

  stop() { this.active = false; }

  updateUsers(userList, myId) {
    const currentIds = new Set(userList.map(u => u.id));
    this.users = this.users.filter(u => currentIds.has(u.id));

    for (const u of userList) {
      if (u.id === myId) continue;
      let existing = this.users.find(eu => eu.id === u.id);
      if (!existing) {
        const padding = 120;
        const newUser = {
          id: u.id, name: u.name, photo: u.photo,
          x: padding + Math.random() * (this.w - padding * 2),
          y: padding + Math.random() * (this.h - padding * 2),
          vx: (Math.random() - 0.5) * 0.3,
          vy: (Math.random() - 0.5) * 0.3,
          img: null, radius: 50
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
    for (const u of this.users) {
      const dx = this.vMouse.x - u.x;
      const dy = this.vMouse.y - u.y;
      if (Math.sqrt(dx * dx + dy * dy) < u.radius + 40) {
        this.hoveredUser = u;
        break;
      }
    }
  }

  // Draw photos to offscreen canvas (the shader reads this as texture)
  _drawPhotos() {
    const ctx = this.photoCtx;
    const dpr = this.dpr;
    ctx.clearRect(0, 0, this.photoCanvas.width, this.photoCanvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    for (const u of this.users) {
      // Float
      u.x += u.vx;
      u.y += u.vy;
      const pad = u.radius + 10;
      if (u.x < pad || u.x > this.w - pad) u.vx *= -1;
      if (u.y < pad || u.y > this.h - pad) u.vy *= -1;
      u.x = Math.max(pad, Math.min(this.w - pad, u.x));
      u.y = Math.max(pad, Math.min(this.h - pad, u.y));

      // Draw circular photo
      ctx.save();
      ctx.beginPath();
      ctx.arc(u.x, u.y, u.radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      if (u.img) {
        ctx.drawImage(u.img, u.x - u.radius, u.y - u.radius, u.radius * 2, u.radius * 2);
      } else {
        ctx.fillStyle = '#444';
        ctx.fill();
        ctx.fillStyle = '#aaa';
        ctx.font = '22px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(u.name[0] || '?', u.x, u.y);
      }
      ctx.restore();

      // Name
      ctx.fillStyle = '#888';
      ctx.font = '12px "Helvetica Neue", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(u.name, u.x, u.y + u.radius + 18);
    }
    ctx.restore();
  }

  // Convert avatar pixel position to shader coordinate space
  _toShaderCoord(px, py) {
    const dpr = this.dpr;
    const w = this.w * dpr;
    const h = this.h * dpr;
    // Match the coord() function in the shader
    let x = (px * dpr) / w;
    let y = (py * dpr) / h;
    if (w > h) {
      x = x * (w / h) + (h - w) / h / 2.0;
    } else {
      y = y * (h / w) + (w - h) / w / 2.0;
    }
    x = -(x - 0.5) + 0.5;
    y = (y - 0.5) + 0.5;
    return [x, y];
  }

  _animate() {
    if (!this.active) return;
    requestAnimationFrame(() => this._animate());

    const time = performance.now() * 0.001;
    const dt = time - this.lastTime;
    this.lastTime = time;

    // Mouse damping (from codrops)
    this.vMouseDamp.x = THREE.MathUtils.damp(this.vMouseDamp.x, this.vMouse.x, 8, dt);
    this.vMouseDamp.y = THREE.MathUtils.damp(this.vMouseDamp.y, this.vMouse.y, 8, dt);

    this._updateHover();

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

    this._drawPhotos();

    // Update uniforms
    this.photoTexture.needsUpdate = true;
    this.material.uniforms.u_holdProgress.value = holdProgress;
    this.material.uniforms.u_hasHover.value = this.hoveredUser ? 1.0 : 0.0;
    this.material.uniforms.u_time.value = time;
    this.material.uniforms.u_count.value = this.users.length;

    // Update avatar positions in shader coordinate space
    const positions = this.material.uniforms.u_positions.value;
    const radii = this.material.uniforms.u_radii.value;
    for (let i = 0; i < MAX_USERS; i++) {
      if (i < this.users.length) {
        const [sx, sy] = this._toShaderCoord(this.users[i].x, this.users[i].y);
        positions[i].set(sx, sy);
        // Convert pixel radius to shader space (approximate)
        radii[i] = (this.users[i].radius / this.w) * 2.0;
      } else {
        positions[i].set(-10, -10);
        radii[i] = 0;
      }
    }

    // Hover name
    const el = document.getElementById('hover-name');
    if (el) {
      if (this.hoveredUser) {
        el.textContent = this.holding ? 'connecting...' : this.hoveredUser.name;
        el.style.opacity = '1';
      } else {
        el.style.opacity = '0';
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    this.active = false;
    if (this.renderer?.domElement?.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
    this.renderer.dispose();
  }
}
