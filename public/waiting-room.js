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
uniform vec2 u_resolution;  // canvas resolution in pixels
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

// Blur the texture around a point
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
    vec2 res = u_resolution;

    // Sample texture (names drawn on canvas)
    vec4 texColor = texture2D(u_photos, uv);

    // Mouse proximity blur
    float mouseDist = length((uv - mouse) * u_aspect);
    float lens = smoothstep(0.08, 0.0, mouseDist);
    float blurAmount = lens * 8.0;
    vec4 blurred = blurSample(u_photos, uv, res, blurAmount);

    // Blend: text blurs near mouse, blurred part is white
    vec4 finalColor = texColor;
    if (lens > 0.001) {
      // Use blurred alpha to determine the expansion zone
      float expansion = max(blurred.a - texColor.a, 0.0) * lens;
      // Blur the original text
      finalColor = mix(texColor, vec4(1.0, 1.0, 1.0, blurred.a), lens);
      // Make the expanded area white
      finalColor.rgb = vec3(1.0);
      finalColor.a = mix(texColor.a, blurred.a, lens);
    }

    gl_FragColor = finalColor;
}
`;

const VERTEX_SHADER = `
varying vec2 v_uv;
void main() {
    v_uv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ICON_NAMES = [
  'sun-dim','sparkle','robot','rainbow','rabbit','popcorn','popsicle',
  'potted-plant','plant','planet','piggy-bank','orange','ice-cream',
  'heart','android-logo','acorn','alien','bone','bird','carrot',
  'cherries','cheese','clover','coffee','cookie','cow','cube',
  'detective','dog','eyes','fire-simple','fish-simple','flower-lotus',
  'flower','flying-saucer','flower-tulip','tree'
];

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
    this.icons = {}; // loaded icon images

    this._loadIcons();
    this._initThree();
    this._initEvents();
  }

  _loadIcons() {
    for (const name of ICON_NAMES) {
      const img = new Image();
      img.src = '/icons/' + name + '.svg';
      this.icons[name] = img;
    }
  }

  _randomIcon() {
    return ICON_NAMES[Math.floor(Math.random() * ICON_NAMES.length)];
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
        const pad = 120;
        const newUser = {
          id: u.id, name: u.name,
          x: pad + Math.random() * (this.w - pad * 2),
          y: pad + Math.random() * (this.h - pad * 2),
          icon: this._randomIcon(),
          radius: 40
        };
        this.users.push(newUser);
      } else {
        existing.name = u.name;
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
      // Gentle floating in place (small oscillation around origin)
      if (!u.originX) { u.originX = u.x; u.originY = u.y; u.phase = Math.random() * Math.PI * 2; }
      const t = performance.now() * 0.001;
      u.x = u.originX + Math.sin(t * 0.5 + u.phase) * 8;
      u.y = u.originY + Math.cos(t * 0.3 + u.phase * 1.3) * 6;

      // Draw name text centered at the user position
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 24px "Helvetica Neue", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(u.name, u.x, u.y);
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
