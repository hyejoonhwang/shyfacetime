// ============================================================
// Waiting Room — Cards rendered on Three.js canvas with SDF blur
// SDF shader from https://github.com/guilanier/codrops-sdf-lensblur
// ============================================================

const MAX_USERS = 20;

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_photos;
uniform vec2 u_mouse;
uniform vec2 u_aspect;
uniform vec2 u_resolution;
uniform vec2 u_positions[${MAX_USERS}];
uniform float u_radii[${MAX_USERS}];
uniform int u_count;

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

// Blur sampling
vec4 blurSample(sampler2D tex, vec2 uv, vec2 res, float amount) {
    if (amount < 0.001) return texture2D(tex, uv);
    vec4 sum = vec4(0.0);
    float total = 0.0;
    vec2 pixel = 1.0 / res;
    for (float x = -3.0; x <= 3.0; x += 1.0) {
        for (float y = -3.0; y <= 3.0; y += 1.0) {
            float w = exp(-0.5 * (x*x + y*y) / 4.0);
            sum += texture2D(tex, uv + vec2(x, y) * pixel * amount) * w;
            total += w;
        }
    }
    return sum / total;
}

void main() {
    vec2 uv = v_uv;
    vec2 mouse = u_mouse;
    vec4 texColor = texture2D(u_photos, uv);

    vec3 color = vec3(0.0);
    float alpha = 0.0;

    for (int i = 0; i < ${MAX_USERS}; i++) {
        if (i >= u_count) break;

        vec2 center = u_positions[i];
        float radius = u_radii[i];

        float dist = length((uv - center) * u_aspect);
        float mouseDist = length((uv - mouse) * u_aspect);

        // SDF lens: smooth falloff from mouse point
        float lens = smoothstep(radius * 0.8, 0.0, mouseDist);

        // Card fill with slight default softness
        float baseSoft = 0.003;
        float cardFill = fill(dist, radius, baseSoft + lens * radius * 0.4);

        // Stroke: edge expands with lens (the SDF blur distort)
        float strokeEdge = 0.002 + lens * radius * 0.3;
        float cardStroke = stroke(dist, radius, 0.003, strokeEdge) * 2.0;

        // Blur the texture near cursor
        float blurAmt = lens * 6.0;
        vec4 blurred = blurSample(u_photos, uv, u_resolution, blurAmt);
        vec4 cardColor = mix(texColor, blurred, lens);

        // Apply card content
        color = mix(color, cardColor.rgb, cardFill);
        alpha = max(alpha, cardFill);

        // White stroke (expanding edge)
        color = mix(color, vec3(1.0), cardStroke * 0.6);
        alpha = max(alpha, cardStroke * 0.6);
    }

    gl_FragColor = vec4(color, alpha);
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

    // Offscreen canvas for drawing card content
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
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
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
      transparent: true,
      uniforms: {
        u_photos: { value: this.photoTexture },
        u_mouse: { value: new THREE.Vector2(0, 0) },
        u_aspect: { value: new THREE.Vector2(1, this.h / this.w) },
        u_resolution: { value: new THREE.Vector2(this.w * this.dpr, this.h * this.dpr) },
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
    this.material.uniforms.u_resolution.value.set(this.w * this.dpr, this.h * this.dpr);
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
        // Trigger call request immediately on click
        if (this.onCallRequest) this.onCallRequest(this.holdTarget.id);
        this.holding = false;
        this.holdTarget = null;
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
        const newUser = {
          id: u.id, name: u.name, photo: u.photo,
          img: null, cardW: 200, cardH: 260, x: 0, y: 0
        };
        if (u.photo) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { newUser.img = img; };
          img.src = u.photo;
        }
        this.users.push(newUser);
        this._layoutCards();
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
    this._layoutCards();
  }

  _layoutCards() {
    // Grid layout centered on screen
    const cols = Math.max(1, Math.min(4, Math.floor((this.w - 80) / 220)));
    const gap = 20;
    const cardW = 200;
    const cardH = 260;
    const totalW = cols * cardW + (cols - 1) * gap;
    const startX = (this.w - totalW) / 2 + cardW / 2;
    const startY = 40 + cardH / 2;

    this.users.forEach((u, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      u.cardW = cardW;
      u.cardH = cardH;
      u.x = startX + col * (cardW + gap);
      u.y = startY + row * (cardH + gap);
    });
  }

  _updateHover() {
    this.hoveredUser = null;
    for (const u of this.users) {
      const hw = u.cardW / 2 + 10;
      const hh = u.cardH / 2 + 10;
      if (Math.abs(this.mouseX - u.x) < hw && Math.abs(this.mouseY - u.y) < hh) {
        this.hoveredUser = u;
        break;
      }
    }
  }

  _drawCards() {
    const ctx = this.photoCtx;
    const dpr = this.dpr;
    ctx.clearRect(0, 0, this.photoCanvas.width, this.photoCanvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    for (const u of this.users) {
      const x = u.x - u.cardW / 2;
      const y = u.y - u.cardH / 2;
      const w = u.cardW;
      const h = u.cardH;
      const r = 32; // border radius matching design system

      // Card background
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fillStyle = '#F5F4F0';
      ctx.fill();
      ctx.strokeStyle = '#CFCDC5';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Avatar circle
      const avatarR = 28;
      const avatarY = y + 50;
      if (u.img) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(u.x, avatarY, avatarR, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(u.img, u.x - avatarR, avatarY - avatarR, avatarR * 2, avatarR * 2);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(u.x, avatarY, avatarR, 0, Math.PI * 2);
        ctx.fillStyle = '#CFCDC5';
        ctx.fill();
        ctx.fillStyle = '#999';
        ctx.font = '600 20px Nunito, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(u.name[0] || '?', u.x, avatarY);
      }

      // Avatar border
      ctx.beginPath();
      ctx.arc(u.x, avatarY, avatarR, 0, Math.PI * 2);
      ctx.strokeStyle = '#CFCDC5';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Name
      ctx.fillStyle = '#000000';
      ctx.font = '700 16px Nunito, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(u.name, u.x, avatarY + avatarR + 24);

      // "online" status
      ctx.fillStyle = '#999999';
      ctx.font = '400 12px Nunito, sans-serif';
      ctx.fillText('online', u.x, avatarY + avatarR + 44);

      // "call" button
      const btnW = 140;
      const btnH = 36;
      const btnX = u.x - btnW / 2;
      const btnY = y + h - 56;
      ctx.beginPath();
      ctx.roundRect(btnX, btnY, btnW, btnH, 18);
      ctx.fillStyle = '#7BA887';
      ctx.fill();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 14px Nunito, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('call', u.x, btnY + btnH / 2);
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
    this._drawCards();
    this.photoTexture.needsUpdate = true;

    // Update uniforms
    this.material.uniforms.u_mouse.value.set(
      this.mouseDampX / this.w,
      1.0 - this.mouseDampY / this.h
    );
    this.material.uniforms.u_count.value = this.users.length;

    const positions = this.material.uniforms.u_positions.value;
    const radii = this.material.uniforms.u_radii.value;
    for (let i = 0; i < MAX_USERS; i++) {
      if (i < this.users.length) {
        const u = this.users[i];
        positions[i].set(u.x / this.w, 1.0 - u.y / this.h);
        // Radius covers the card (use half-diagonal)
        radii[i] = Math.sqrt(u.cardW * u.cardW + u.cardH * u.cardH) / 2 / this.w;
      } else {
        positions[i].set(-10, -10);
        radii[i] = 0;
      }
    }

    // Cursor style
    document.body.style.cursor = this.hoveredUser ? 'pointer' : 'default';

    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    this.active = false;
    if (this.renderer?.domElement?.parentNode)
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    this.renderer.dispose();
  }
}
