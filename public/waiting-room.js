// ============================================================
// Waiting Room — SDF Lens Blur on avatar circles
// Effect from https://github.com/guilanier/codrops-sdf-lensblur
// The cursor makes the circle edge expand and blur where it is
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

    // Offscreen canvas: avatar photos
    this.photoCanvas = document.createElement('canvas');
    this.photoCanvas.width = w * dpr;
    this.photoCanvas.height = h * dpr;
    this.photoCtx = this.photoCanvas.getContext('2d');

    this.photoTexture = new THREE.CanvasTexture(this.photoCanvas);
    this.photoTexture.minFilter = THREE.LinearFilter;
    this.photoTexture.magFilter = THREE.LinearFilter;

    // Three.js setup (mirrors codrops)
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.camera.position.z = 1;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.container.appendChild(this.renderer.domElement);

    const posArray = [];
    const radArray = [];
    for (let i = 0; i < MAX_USERS; i++) {
      posArray.push(new THREE.Vector2(-10, -10));
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
        uniform float u_time;
        uniform vec2 u_positions[${MAX_USERS}];
        uniform float u_radii[${MAX_USERS}];
        uniform int u_count;

        #define PI 3.14159265358979

        // --- Coordinate system (from codrops) ---
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
          vec2 posMouse = coord(u_mouse * u_pixelRatio) * vec2(1., -1.) + 0.5;
          vec2 uv = v_texcoord;

          // Background
          vec3 color = vec3(0.04);

          // Photo texture
          vec4 photoColor = texture2D(u_photos, uv);

          // Mouse lens influence — smooth falloff from cursor point
          float distToMouse = sdCircle(st, posMouse);
          float lensInfluence = fill(distToMouse, 0.3, 0.5);

          // --- Render each avatar with codrops SDF lens blur ---
          for (int i = 0; i < ${MAX_USERS}; i++) {
            if (i >= u_count) break;

            vec2 aPos = u_positions[i];
            float aRad = u_radii[i];
            float sdf = sdCircle(st, aPos);

            // Edge scaled to avatar size — prevents blob, keeps gooey tension
            // lensInfluence (0-1) × small factor = subtle edge expansion
            float edgeAmount = lensInfluence * aRad * 1.5;

            // Stroke: edge controlled by mouse proximity
            // Near mouse: edge expands → stroke gets wide and soft (gooey)
            // Far: edge ≈ 0 → stroke is thin and crisp
            float borderSize = 0.01;
            float avatarStroke = stroke(sdf, aRad, borderSize, edgeAmount) * 4.0;

            // Fill: slight default softness for the blurry-but-visible look
            float avatarFill = fill(sdf, aRad, 0.04);

            // Apply photo inside circle
            color = mix(color, photoColor.rgb, avatarFill);

            // The stroke edge (white, expanding with gooey blur)
            color += vec3(1.0) * avatarStroke * 0.7;
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
    this.w = w; this.h = h; this.dpr = dpr;
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
        const pad = 120;
        const newUser = {
          id: u.id, name: u.name, photo: u.photo,
          x: pad + Math.random() * (this.w - pad * 2),
          y: pad + Math.random() * (this.h - pad * 2),
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

  _drawPhotos() {
    const ctx = this.photoCtx;
    const dpr = this.dpr;
    ctx.clearRect(0, 0, this.photoCanvas.width, this.photoCanvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    for (const u of this.users) {
      u.x += u.vx; u.y += u.vy;
      const pad = u.radius + 10;
      if (u.x < pad || u.x > this.w - pad) u.vx *= -1;
      if (u.y < pad || u.y > this.h - pad) u.vy *= -1;
      u.x = Math.max(pad, Math.min(this.w - pad, u.x));
      u.y = Math.max(pad, Math.min(this.h - pad, u.y));

      // Draw photo in circle (larger than SDF radius so edge blur reveals it)
      ctx.save();
      ctx.beginPath();
      ctx.arc(u.x, u.y, u.radius + 30, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      if (u.img) {
        const r = u.radius + 30;
        ctx.drawImage(u.img, u.x - r, u.y - r, r * 2, r * 2);
      } else {
        ctx.fillStyle = '#333';
        ctx.fillRect(u.x - u.radius - 30, u.y - u.radius - 30, (u.radius + 30) * 2, (u.radius + 30) * 2);
        ctx.fillStyle = '#aaa';
        ctx.font = '24px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(u.name[0] || '?', u.x, u.y);
      }
      ctx.restore();

      // Name
      ctx.fillStyle = '#888';
      ctx.font = '12px "Helvetica Neue", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(u.name, u.x, u.y + u.radius + 48);
    }
    ctx.restore();
  }

  // Convert pixel position to codrops shader coord space
  _toShaderCoord(px, py) {
    const dpr = this.dpr;
    const rw = this.w * dpr;
    const rh = this.h * dpr;
    let x = (px * dpr) / rw;
    let y = (py * dpr) / rh;
    if (rw > rh) {
      x = x * (rw / rh) + (rh - rw) / rh / 2.0;
    } else {
      y = y * (rh / rw) + (rw - rh) / rw / 2.0;
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
    this.photoTexture.needsUpdate = true;

    // Update uniforms
    this.material.uniforms.u_holdProgress.value = holdProgress;
    this.material.uniforms.u_time.value = time;
    this.material.uniforms.u_count.value = this.users.length;

    const positions = this.material.uniforms.u_positions.value;
    const radii = this.material.uniforms.u_radii.value;
    for (let i = 0; i < MAX_USERS; i++) {
      if (i < this.users.length) {
        const [sx, sy] = this._toShaderCoord(this.users[i].x, this.users[i].y);
        positions[i].set(sx, sy);
        radii[i] = (this.users[i].radius / this.w) * 2.0;
      } else {
        positions[i].set(-10, -10);
        radii[i] = 0;
      }
    }

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
    if (this.renderer?.domElement?.parentNode)
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    this.renderer.dispose();
  }
}
