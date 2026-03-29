// ============================================================
// Waiting Room — SDF lens blur on avatar circles
// ============================================================

const MAX_USERS = 20;

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_photos;
uniform vec2 u_mouse;       // mouse in UV space (0-1)
uniform vec2 u_aspect;      // (1, height/width) for aspect correction
uniform vec2 u_positions[${MAX_USERS}]; // avatar centers in UV space
uniform float u_radii[${MAX_USERS}];    // avatar radii in UV space
uniform int u_count;

/* SDF + drawing functions from codrops */
float sdCircle(vec2 st, vec2 center) {
    return length(st - center);
}

float aastep(float threshold, float value) {
    float afwidth = length(vec2(dFdx(value), dFdy(value))) * 0.707;
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
    vec2 uv = v_uv;
    vec4 photoColor = texture2D(u_photos, uv);

    // Mouse distance in aspect-corrected space
    vec2 mouse = u_mouse;

    vec3 color = vec3(0.04);

    for (int i = 0; i < ${MAX_USERS}; i++) {
        if (i >= u_count) break;

        vec2 center = u_positions[i];
        float radius = u_radii[i];

        // Distance from pixel to avatar center (aspect corrected)
        float dist = length((uv - center) * u_aspect);

        // Distance from mouse to this pixel (aspect corrected)
        float mouseDist = length((uv - mouse) * u_aspect);

        float lens = smoothstep(radius * 0.8, 0.0, mouseDist);

        // Fill: the avatar circle, slight default soft edge
        float baseSoft = 0.003;
        float avatarFill = fill(dist, radius, baseSoft + lens * radius * 0.4);

        // Stroke: circle outline, edge expands with lens
        float strokeEdge = 0.002 + lens * radius * 0.3;
        float avatarStroke = stroke(dist, radius, 0.003, strokeEdge) * 2.0;

        // Apply photo inside circle
        color = mix(color, photoColor.rgb, avatarFill);

        // Stroke on top (white outline that expands near mouse)
        color = mix(color, vec3(1.0), avatarStroke * 0.6);
    }

    gl_FragColor = vec4(color, 1.0);
}
`;

const VERTEX_SHADER = `
varying vec2 v_uv;
void main() {
    v_uv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

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
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseDampX = 0;
    this.mouseDampY = 0;

    this._initThree();
    this._initEvents();
  }

  _initThree() {
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio, 2);

    this.photoCanvas = document.createElement('canvas');
    this.photoCanvas.width = this.w * this.dpr;
    this.photoCanvas.height = this.h * this.dpr;
    this.photoCtx = this.photoCanvas.getContext('2d');

    this.photoTexture = new THREE.CanvasTexture(this.photoCanvas);
    this.photoTexture.minFilter = THREE.LinearFilter;
    this.photoTexture.magFilter = THREE.LinearFilter;

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

    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        u_photos: { value: this.photoTexture },
        u_mouse: { value: new THREE.Vector2(0, 0) },
        u_aspect: { value: new THREE.Vector2(1, this.h / this.w) },
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
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setSize(this.w, this.h);
    this.renderer.setPixelRatio(this.dpr);
    this.photoCanvas.width = this.w * this.dpr;
    this.photoCanvas.height = this.h * this.dpr;
    this.material.uniforms.u_aspect.value.set(1, this.h / this.w);
  }

  _initEvents() {
    const onMove = (e) => {
      this.mouseX = e.touches ? e.touches[0].clientX : e.clientX;
      this.mouseY = e.touches ? e.touches[0].clientY : e.clientY;
    };
    const onDown = (e) => {
      this.mouseX = e.touches ? e.touches[0].clientX : e.clientX;
      this.mouseY = e.touches ? e.touches[0].clientY : e.clientY;
      this._updateHover();
      if (this.hoveredUser) {
        this.holding = true;
        this.holdStart = Date.now();
        this.holdTarget = this.hoveredUser;
      }
    };
    const onUp = () => { this.holding = false; this.holdStart = 0; this.holdTarget = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('mousedown', onDown);
    window.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
    window.addEventListener('resize', () => this._resize());
  }

  start() { this.active = true; this.lastTime = performance.now() * 0.001; this._animate(); }
  stop() { this.active = false; }

  updateUsers(userList, myId) {
    const currentIds = new Set(userList.map(u => u.id));
    this.users = this.users.filter(u => currentIds.has(u.id));
    for (const u of userList) {
      if (u.id === myId) continue;
      let existing = this.users.find(eu => eu.id === u.id);
      if (!existing) {
        const pad = 200;
        const newUser = {
          id: u.id, name: u.name, photo: u.photo,
          x: pad + Math.random() * (this.w - pad * 2),
          y: pad + Math.random() * (this.h - pad * 2),
          vx: (Math.random() - 0.5) * 0.2,
          vy: (Math.random() - 0.5) * 0.2,
          img: null, radius: 150
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
      const dx = this.mouseX - u.x;
      const dy = this.mouseY - u.y;
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

      // Draw photo bigger than SDF radius so edge expansion reveals more
      const r = u.radius + 50;
      ctx.save();
      ctx.beginPath();
      ctx.arc(u.x, u.y, r, 0, Math.PI * 2);
      ctx.clip();
      if (u.img) {
        ctx.drawImage(u.img, u.x - r, u.y - r, r * 2, r * 2);
      } else {
        ctx.fillStyle = '#333';
        ctx.fill();
        ctx.fillStyle = '#aaa';
        ctx.font = '28px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(u.name[0] || '?', u.x, u.y);
      }
      ctx.restore();

      ctx.fillStyle = '#888';
      ctx.font = '13px "Helvetica Neue", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(u.name, u.x, u.y + u.radius + 28);
    }
    ctx.restore();
  }

  _animate() {
    if (!this.active) return;
    requestAnimationFrame(() => this._animate());

    const time = performance.now() * 0.001;
    const dt = time - this.lastTime;
    this.lastTime = time;

    // Mouse damping
    this.mouseDampX += (this.mouseX - this.mouseDampX) * (1 - Math.exp(-8 * dt));
    this.mouseDampY += (this.mouseY - this.mouseDampY) * (1 - Math.exp(-8 * dt));

    this._updateHover();

    if (this.holding && this.holdTarget) {
      const progress = Math.min((Date.now() - this.holdStart) / 2000, 1.0);
      if (progress >= 1.0) {
        this.holding = false;
        if (this.onCallRequest) this.onCallRequest(this.holdTarget.id);
        this.holdStart = 0;
        this.holdTarget = null;
      }
    }

    this._drawPhotos();
    this.photoTexture.needsUpdate = true;

    // Mouse in UV space (0-1, Y flipped for GL)
    this.material.uniforms.u_mouse.value.set(
      this.mouseDampX / this.w,
      1.0 - this.mouseDampY / this.h
    );

    // Avatar positions in UV space
    this.material.uniforms.u_count.value = this.users.length;
    const positions = this.material.uniforms.u_positions.value;
    const radii = this.material.uniforms.u_radii.value;
    for (let i = 0; i < MAX_USERS; i++) {
      if (i < this.users.length) {
        positions[i].set(
          this.users[i].x / this.w,
          1.0 - this.users[i].y / this.h
        );
        radii[i] = this.users[i].radius / this.w;
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
      } else { el.style.opacity = '0'; }
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
