// ============================================================
// Waiting Room — using codrops SDF lens blur shader directly
// Source: https://github.com/guilanier/codrops-sdf-lensblur
// ============================================================

const MAX_USERS = 20;

// Fragment shader — copied from codrops fragment.glsl
// Only change: replaced single shape with loop over avatar circles
const FRAGMENT_SHADER = `
precision highp float;
varying vec2 v_texcoord;

uniform vec2 u_mouse;
uniform vec2 u_resolution;
uniform float u_pixelRatio;
uniform sampler2D u_photos;
uniform vec2 u_positions[${MAX_USERS}];
uniform float u_radii[${MAX_USERS}];
uniform int u_count;

/* common constants — from codrops */
#ifndef PI
#define PI 3.1415926535897932384626433832795
#endif
#ifndef TWO_PI
#define TWO_PI 6.2831853071795864769252867665590
#endif

/* Coordinate and unit utils — from codrops */
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

/* signed distance functions — from codrops */
float sdCircle(in vec2 st, in vec2 center) {
    return length(st - center) * 2.0;
}

/* antialiased step function — from codrops */
float aastep(float threshold, float value) {
    float afwidth = length(vec2(dFdx(value), dFdy(value))) * 0.70710678118654757;
    return smoothstep(threshold - afwidth, threshold + afwidth, value);
}

/* Signed distance drawing methods — from codrops */
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
    vec2 pixel = 1.0 / u_resolution.xy;
    vec2 st = coord(gl_FragCoord.xy) + 0.5;
    vec2 posMouse = coord(u_mouse * u_pixelRatio) * vec2(1., -1.) + 0.5;

    /* sdf Circle (lens) params — from codrops */
    float circleSize = 0.3;
    float circleEdge = 0.5;

    /* sdf Circle (lens around mouse) — from codrops */
    float sdfCircle = fill(
        sdCircle(st, posMouse),
        circleSize,
        circleEdge
    );

    vec3 color = vec3(0.04);
    vec2 uv = v_texcoord;
    vec4 photoColor = texture2D(u_photos, uv);

    /* Loop over avatar circles — using VAR==2 technique from codrops:
       sdf circle with stroke param adjusted by sdf circle */
    for (int i = 0; i < ${MAX_USERS}; i++) {
        if (i >= u_count) break;

        float sdf = sdCircle(st, u_positions[i]);

        /* stroke with edge = sdfCircle — copied from codrops VAR==2 */
        float avatarStroke = stroke(sdf, u_radii[i], 0.02, sdfCircle) * 4.0;

        /* fill for photo content */
        float avatarFill = fill(sdf, u_radii[i], 0.04);

        color = mix(color, photoColor.rgb, avatarFill);
        color += vec3(1.0) * avatarStroke;
    }

    gl_FragColor = vec4(color, 1.0);
}
`;

// Vertex shader — from codrops main.js
const VERTEX_SHADER = `
varying vec2 v_texcoord;
void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    v_texcoord = uv;
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

    // From codrops main.js
    this.vMouse = new THREE.Vector2();
    this.vMouseDamp = new THREE.Vector2();
    this.vResolution = new THREE.Vector2();

    this._initThree();
    this._initEvents();
  }

  _initThree() {
    // Scene setup — from codrops main.js
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.camera.position.z = 1;
    this.renderer = new THREE.WebGLRenderer();
    this.container.appendChild(this.renderer.domElement);

    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio, 2);

    // Offscreen canvas for avatar photos
    this.photoCanvas = document.createElement('canvas');
    this.photoCanvas.width = this.w * this.dpr;
    this.photoCanvas.height = this.h * this.dpr;
    this.photoCtx = this.photoCanvas.getContext('2d');

    this.photoTexture = new THREE.CanvasTexture(this.photoCanvas);
    this.photoTexture.minFilter = THREE.LinearFilter;
    this.photoTexture.magFilter = THREE.LinearFilter;

    // Uniform arrays for avatar positions
    const posArray = [];
    const radArray = [];
    for (let i = 0; i < MAX_USERS; i++) {
      posArray.push(new THREE.Vector2(-10, -10));
      radArray.push(0.0);
    }

    // Plane geometry — from codrops main.js
    const geo = new THREE.PlaneGeometry(1, 1);

    // Shader material — from codrops main.js
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        u_mouse: { value: this.vMouseDamp },
        u_resolution: { value: this.vResolution },
        u_pixelRatio: { value: this.dpr },
        u_photos: { value: this.photoTexture },
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

  // Resize — from codrops main.js
  _resize() {
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio, 2);

    this.renderer.setSize(this.w, this.h);
    this.renderer.setPixelRatio(this.dpr);

    this.camera.left = -this.w / 2;
    this.camera.right = this.w / 2;
    this.camera.top = this.h / 2;
    this.camera.bottom = -this.h / 2;
    this.camera.updateProjectionMatrix();

    this.quad.scale.set(this.w, this.h, 1);
    this.vResolution.set(this.w, this.h).multiplyScalar(this.dpr);
    this.material.uniforms.u_pixelRatio.value = this.dpr;

    this.photoCanvas.width = this.w * this.dpr;
    this.photoCanvas.height = this.h * this.dpr;
  }

  _initEvents() {
    // Mouse tracking — from codrops main.js
    const onPointerMove = (e) => {
      this.vMouse.set(
        e.touches ? e.touches[0].pageX : e.pageX,
        e.touches ? e.touches[0].pageY : e.pageY
      );
    };
    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('pointermove', onPointerMove);

    const onDown = (e) => {
      this.vMouse.set(
        e.touches ? e.touches[0].pageX : e.pageX,
        e.touches ? e.touches[0].pageY : e.pageY
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
        const pad = 220;
        const newUser = {
          id: u.id, name: u.name, photo: u.photo,
          x: pad + Math.random() * (this.w - pad * 2),
          y: pad + Math.random() * (this.h - pad * 2),
          vx: (Math.random() - 0.5) * 0.2,
          vy: (Math.random() - 0.5) * 0.2,
          img: null, radius: 180
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

      // Draw photo (larger than SDF radius so stroke expansion reveals it)
      ctx.save();
      ctx.beginPath();
      ctx.arc(u.x, u.y, u.radius + 60, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      if (u.img) {
        const r = u.radius + 60;
        ctx.drawImage(u.img, u.x - r, u.y - r, r * 2, r * 2);
      } else {
        ctx.fillStyle = '#333';
        ctx.fillRect(u.x - 90, u.y - 90, 180, 180);
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
      ctx.fillText(u.name, u.x, u.y + u.radius + 30);
    }
    ctx.restore();
  }

  // Convert pixel position to codrops shader coordinate space
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
    // coord() does: p -= 0.5; p *= vec2(-1, 1);
    // Then main() does: st = coord(...) + 0.5
    // So st = (-1*(x-0.5)+0.5, (y-0.5)+0.5) = (1-x, y)
    return [1.0 - x, y];
  }

  // Animation loop — from codrops main.js
  _animate() {
    if (!this.active) return;
    requestAnimationFrame(() => this._animate());

    const time = performance.now() * 0.001;
    const dt = time - this.lastTime;
    this.lastTime = time;

    // Mouse damping — from codrops main.js
    for (const k of ['x', 'y']) {
      this.vMouseDamp[k] = THREE.MathUtils.damp(this.vMouseDamp[k], this.vMouse[k], 8, dt);
    }

    this._updateHover();

    // Hold logic
    if (this.holding && this.holdTarget) {
      const holdProgress = Math.min((Date.now() - this.holdStart) / 2000, 1.0);
      if (holdProgress >= 1.0) {
        this.holding = false;
        if (this.onCallRequest) this.onCallRequest(this.holdTarget.id);
        this.holdStart = 0;
        this.holdTarget = null;
      }
    }

    this._drawPhotos();
    this.photoTexture.needsUpdate = true;

    // Update avatar uniforms
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
    if (this.renderer?.domElement?.parentNode)
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    this.renderer.dispose();
  }
}
