/* ==========================================================================
   THE THREAT LANDSCAPE
   An interactive 3D pop-up field book. Three.js + CSS3D + GSAP.
   ========================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createPopupLibrary } from './popups.js';

/* --------------------------------------------------------------------------
   Data
   -------------------------------------------------------------------------- */
let SCHEMA;
try {
  const inline = document.getElementById('lesson-data');
  if (inline) {
    SCHEMA = JSON.parse(inline.textContent);
  } else {
    const response = await fetch('./lesson-schema.json');
    if (!response.ok) throw new Error(`Schema fetch failed: ${response.status}`);
    SCHEMA = await response.json();
  }
} catch (error) {
  console.error(error);
  const splash = document.getElementById('splash');
  if (splash) {
    splash.innerHTML = '<div class="splash-inner"><p class="splash-sub">تعذّر تحميل بيانات الدرس. شغّل الكتاب من خلال خادم محلي.</p></div>';
  }
  throw error;
}

/* --------------------------------------------------------------------------
   Constants
   -------------------------------------------------------------------------- */
const PAGE_W = 4.18;
const PAGE_H = 5.42;
const PAGE_CX = PAGE_W / 2;
const DOM_W = 640;
const DOM_H = 830;
const PAGE_DOM_SCALE = PAGE_W / DOM_W;
const PAGE_SURFACE_Y = 0.328;
const PAGE_CSS_Y = 0.337;
const PAGE_POP_Y = 0.334;
const BOOK_W = PAGE_W * 2;
const BOOK_D = PAGE_H;
const SPREAD_FIT_W = BOOK_W + 0.9;
const ACCENT_DEFAULT = '#2f7f78';

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const deg = THREE.MathUtils.degToRad;
const pad2 = (n) => String(n).padStart(2, '0');
const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  idx: 0,
  reduced: reducedQuery.matches,
  sound: false,
  hc: false,
  muted: false,
  flipping: false,
  demo: 'idle',           // idle | playing | paused
  seen: SCHEMA.spreads.map(() => new Set()),
  flapOpen: false,
  answered: false,
  selected: -1,
  focusPage: false,
  readerOpen: false,
  ready: false,
  swatch: ACCENT_DEFAULT
};

/* --------------------------------------------------------------------------
   DOM
   -------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const ui = {
  stage: $('stage'),
  dom3d: $('dom3d'),
  dom2d: $('dom2d'),
  splash: $('splash'),
  caption: $('caption'),
  capKicker: $('capKicker'),
  capText: $('capText'),
  hud: $('hud'),
  hudIndex: $('hudIndex'),
  hudTitle: $('hudTitle'),
  toc: $('toc'),
  tocBtn: $('tocBtn'),
  tocClose: $('tocClose'),
  tocList: $('tocList'),
  tocProgressBar: $('tocProgressBar'),
  tocProgressLabel: $('tocProgressLabel'),
  prevBtn: $('prevBtn'),
  nextBtn: $('nextBtn'),
  playBtn: $('playBtn'),
  soundBtn: $('soundBtn'),
  contrastBtn: $('contrastBtn'),
  motionBtn: $('motionBtn'),
  resetBtn: $('resetBtn'),
  focusBtn: $('focusBtn'),
  reader: $('reader'),
  readerPage: $('readerPage'),
  readerScroll: $('readerScroll'),
  readerIndex: $('readerIndex'),
  readerProgress: $('readerProgress'),
  readerClose: $('readerClose'),
  readerPrev: $('readerPrev'),
  readerNext: $('readerNext'),
  srLive: null
};

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */
function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function seededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hexToRgba(hex, alpha = 1) {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${alpha})`;
}

function setAccent(hex) {
  state.swatch = hex;
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-soft', hexToRgba(hex, 0.12));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', '#17120e');
}

function showCaption(kicker, text, duration = 3600, sticky = false) {
  ui.capKicker.textContent = kicker;
  ui.capText.textContent = text;
  ui.caption.classList.add('is-visible');
  clearTimeout(showCaption._timer);
  if (!sticky) {
    showCaption._timer = setTimeout(() => ui.caption.classList.remove('is-visible'), duration);
  }
}

function hideCaption() {
  clearTimeout(showCaption._timer);
  ui.caption.classList.remove('is-visible');
}

function announce(text) {
  let live = document.getElementById('srLive');
  if (!live) {
    live = document.createElement('p');
    live.id = 'srLive';
    live.className = 'sr-only';
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
  }
  live.textContent = text;
}

/* --------------------------------------------------------------------------
   Renderer, camera, controls, post
   -------------------------------------------------------------------------- */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance'
  });
} catch (error) {
  console.error('WebGL unavailable', error);
  ui.splash.innerHTML = '<div class="splash-inner"><p class="splash-sub">هذا المتصفح لا يستطيع تشغيل WebGL. جرّب متصفحًا حديثًا.</p></div>';
  throw error;
}

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.setAttribute('aria-hidden', 'true');
ui.stage.appendChild(renderer.domElement);

const css3d = new CSS3DRenderer({ element: ui.dom3d });
css3d.setSize(window.innerWidth, window.innerHeight);
const css2d = new CSS2DRenderer({ element: ui.dom2d });
css2d.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x17120e);
scene.fog = new THREE.FogExp2(0x17120e, 0.0115);

const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.1, 140);

/* CSS3DRenderer works in CSS-pixel units, while the WebGL scene is only a few
   units wide. Render a uniformly scaled copy of the book/camera so the paper
   page lands exactly under the 3D geometry instead of being magnified. */
const CSS3D_SCALE = DOM_W / PAGE_W;
const cssScene = new THREE.Scene();
const cssBook = new THREE.Group();
cssScene.add(cssBook);
const cssCamera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.1 * CSS3D_SCALE, 140 * CSS3D_SCALE);

function viewForAspect(aspect, focus = false) {
  if (focus) {
    const fov = 44;
    const pitch = deg(56);
    const dist = 9.2;
    const target = new THREE.Vector3(-PAGE_CX, 0.3, 0.02);
    return {
      fov,
      dist,
      target,
      pos: target.clone().add(new THREE.Vector3(0, Math.sin(pitch) * dist, Math.cos(pitch) * dist))
    };
  }
  if (aspect < 0.85) {
    const fov = 44;
    const pitch = deg(56);
    const need = SPREAD_FIT_W * 1.05;
    const dist = clamp((need / 2) / (Math.tan(deg(fov / 2)) * aspect), 15, 38);
    return {
      fov,
      dist,
      target: new THREE.Vector3(0.02, 0.22, 0.08),
      pos: new THREE.Vector3(0.12, Math.sin(pitch) * dist, Math.cos(pitch) * dist)
    };
  }
  const fov = 36;
  const pitch = deg(56);
  const need = SPREAD_FIT_W * 1.18;
  const dist = clamp((need / 2) / (Math.tan(deg(fov / 2)) * aspect), 9.8, 18);
  return {
    fov,
    dist,
    target: new THREE.Vector3(0, 0.28, 0.1),
    pos: new THREE.Vector3(0.34, Math.sin(pitch) * dist, Math.cos(pitch) * dist)
  };
}

const initialView = viewForAspect(window.innerWidth / window.innerHeight, false);
camera.fov = initialView.fov;
camera.position.copy(initialView.pos);
camera.updateProjectionMatrix();

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(initialView.target);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.rotateSpeed = 0.52;
controls.zoomSpeed = 0.82;
controls.panSpeed = 0.65;
controls.screenSpacePanning = true;
controls.enablePan = true;
controls.minDistance = 4.2;
controls.maxDistance = 38;
controls.minPolarAngle = 0.22;
controls.maxPolarAngle = 1.2;
controls.minAzimuthAngle = -0.78;
controls.maxAzimuthAngle = 0.78;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
controls.update();

/* subtle film grade: paper grain, vignette, warm lift */
const PaperGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uAmount: { value: 0.018 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uAmount;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      float grain = hash(vUv * uResolution + uTime * 0.35) - 0.5;
      color += grain * uAmount;
      float vig = smoothstep(1.18, 0.36, distance(vUv, vec2(0.5)));
      color *= mix(0.90, 1.0, vig);
      color = mix(vec3(dot(color, vec3(0.299, 0.587, 0.114))), color, 1.025);
      gl_FragColor = vec4(color, 1.0);
    }
  `
};

const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));

const gradePass = new ShaderPass(PaperGradeShader);
gradePass.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
composer.addPass(gradePass);
composer.addPass(new OutputPass());

/* --------------------------------------------------------------------------
   Lighting
   -------------------------------------------------------------------------- */
const hemi = new THREE.HemisphereLight(0xffe8c8, 0x2b2118, 0.92);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffd6a0, 3.35);
key.position.set(-5.6, 9.8, 6.8);
key.target.position.set(0, 0, 0.2);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.8;
key.shadow.camera.far = 32;
key.shadow.camera.left = -10;
key.shadow.camera.right = 10;
key.shadow.camera.top = 10;
key.shadow.camera.bottom = -10;
key.shadow.bias = -0.00035;
key.shadow.normalBias = 0.022;
key.shadow.radius = 3.4;
scene.add(key);
scene.add(key.target);

const fill = new THREE.DirectionalLight(0x93b6c9, 0.5);
fill.position.set(6.2, 5.4, -3.6);
scene.add(fill);

const bounce = new THREE.PointLight(0xffa967, 5.5, 17, 2);
bounce.position.set(-3.8, 2.1, 4.4);
scene.add(bounce);

const rim = new THREE.DirectionalLight(0xffe0b1, 0.36);
rim.position.set(3.5, 3.8, -5.5);
scene.add(rim);

/* Invisible blind slats: they write striped sunlight across the desk. */
{
  const blindMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const blind = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(13, 0.12, 0.24), blindMat);
    slat.position.set(-2.2, 6.25, 1.0 + i * 0.52);
    slat.rotation.z = -0.18;
    slat.castShadow = true;
    blind.add(slat);
  }
  scene.add(blind);
}

/* --------------------------------------------------------------------------
   Procedural textures
   -------------------------------------------------------------------------- */
function makeDeskTexture() {
  const size = 1024;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const rnd = seededRandom(2174);

  ctx.fillStyle = '#4b3d31';
  ctx.fillRect(0, 0, size, size);

  // broad grain bands
  for (let i = 0; i < 120; i++) {
    const y = rnd() * size;
    const w = 1 + rnd() * 7;
    const a = 0.018 + rnd() * 0.06;
    ctx.strokeStyle = rnd() > 0.45 ? `rgba(28,20,14,${a})` : `rgba(168,137,101,${a * 0.75})`;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= size; x += 32) {
      ctx.lineTo(x, y + Math.sin(x * 0.005 + i) * (2.2 + rnd() * 3.6));
    }
    ctx.stroke();
  }

  // fine fibres
  for (let i = 0; i < 3800; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const len = 2 + rnd() * 26;
    ctx.strokeStyle = `rgba(${rnd() > 0.5 ? '214,184,142' : '25,18,13'},${0.012 + rnd() * 0.035})`;
    ctx.lineWidth = 0.5 + rnd() * 0.9;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (rnd() - 0.5) * 2);
    ctx.stroke();
  }

  // soft uneven glaze
  const grad = ctx.createRadialGradient(size * 0.42, size * 0.34, 30, size * 0.5, size * 0.5, size * 0.8);
  grad.addColorStop(0, 'rgba(233,197,149,0.10)');
  grad.addColorStop(0.55, 'rgba(50,36,25,0.05)');
  grad.addColorStop(1, 'rgba(14,10,7,0.18)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4.5, 4.5);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

function makeClothTexture() {
  const size = 512;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const rnd = seededRandom(8819);
  ctx.fillStyle = '#b4873d';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 180; i++) {
    ctx.strokeStyle = `rgba(255,224,164,${0.025 + rnd() * 0.05})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, i * 3 + rnd() * 2);
    ctx.lineTo(size, i * 3 + Math.sin(i) * 1.3);
    ctx.stroke();
  }
  for (let x = 0; x < size; x += 4) {
    ctx.strokeStyle = `rgba(71,47,24,${0.06 + rnd() * 0.06})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + (rnd() - 0.5) * 2, size);
    ctx.stroke();
  }
  for (let y = 0; y < size; y += 4) {
    ctx.strokeStyle = `rgba(255,225,170,${0.03 + rnd() * 0.04})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (rnd() - 0.5) * 2);
    ctx.stroke();
  }
  for (let i = 0; i < 5000; i++) {
    ctx.fillStyle = `rgba(${rnd() > 0.5 ? '255,236,186' : '57,37,18'},${0.015 + rnd() * 0.025})`;
    ctx.fillRect(rnd() * size, rnd() * size, 1, 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2.2, 2.2);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

function makePaperTexture() {
  const size = 512;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const rnd = seededRandom(4331);
  ctx.fillStyle = '#f4ebd8';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 9000; i++) {
    const v = rnd();
    ctx.fillStyle = v > 0.54
      ? `rgba(255,255,246,${0.03 + rnd() * 0.06})`
      : `rgba(105,76,39,${0.015 + rnd() * 0.035})`;
    ctx.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 1.8, 1 + rnd() * 1.4);
  }
  for (let i = 0; i < 80; i++) {
    ctx.strokeStyle = `rgba(134,101,56,${0.014 + rnd() * 0.018})`;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    const y = rnd() * size;
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(size * 0.33, y + 2, size * 0.66, y - 2, size, y + 1);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.4, 1.4);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

function makeHatchTexture() {
  const size = 128;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const rnd = seededRandom(5511);
  ctx.fillStyle = '#f8f0df';
  ctx.fillRect(0, 0, size, size);
  for (let i = -size; i < size * 2; i += 9) {
    ctx.strokeStyle = 'rgba(64,49,29,0.045)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + size, size);
    ctx.stroke();
  }
  for (let i = -size; i < size * 2; i += 17) {
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 0.65;
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i - size, size);
    ctx.stroke();
  }
  for (let i = 0; i < 1600; i++) {
    ctx.fillStyle = `rgba(73,55,31,${0.012 + rnd() * 0.026})`;
    ctx.fillRect(rnd() * size, rnd() * size, 1, 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2.1, 2.1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

function makeRadialTexture(inner = 'rgba(0,0,0,0.62)', outer = 'rgba(0,0,0,0)') {
  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.52, 'rgba(0,0,0,0.28)');
  grad.addColorStop(1, outer);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeDotTexture() {
  const size = 64;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,246,222,1)');
  grad.addColorStop(0.35, 'rgba(255,239,198,0.9)');
  grad.addColorStop(1, 'rgba(255,228,170,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

const TEX = {
  desk: makeDeskTexture(),
  cloth: makeClothTexture(),
  paper: makePaperTexture(),
  hatch: makeHatchTexture(),
  shadow: makeRadialTexture('rgba(0,0,0,0.72)', 'rgba(0,0,0,0)'),
  dot: makeDotTexture()
};

const POP = createPopupLibrary({
  THREE,
  TEX,
  makeCanvas,
  seededRandom,
  maxAnisotropy: renderer.capabilities.getMaxAnisotropy()
});

/* --------------------------------------------------------------------------
   Desk
   -------------------------------------------------------------------------- */
const desk = new THREE.Mesh(
  new THREE.PlaneGeometry(120, 120),
  new THREE.MeshStandardMaterial({
    map: TEX.desk,
    color: 0xffffff,
    roughness: 0.96,
    metalness: 0.0
  })
);
desk.rotation.x = -Math.PI / 2;
desk.position.y = 0;
desk.receiveShadow = true;
scene.add(desk);

const contactShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(13.4, 9.4),
  new THREE.MeshBasicMaterial({
    map: TEX.shadow,
    color: 0x080604,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.NormalBlending
  })
);
contactShadow.rotation.x = -Math.PI / 2;
contactShadow.position.set(0.15, 0.004, 0.35);
scene.add(contactShadow);

/* --------------------------------------------------------------------------
   Book geometry
   -------------------------------------------------------------------------- */
const book = new THREE.Group();
scene.add(book);

const paperMat = new THREE.MeshStandardMaterial({
  map: TEX.hatch,
  color: 0xffffff,
  roughness: 0.94,
  metalness: 0,
  bumpMap: TEX.paper,
  bumpScale: 0.008
});

const paperPlainMat = new THREE.MeshStandardMaterial({
  map: TEX.paper,
  color: 0xfff8ea,
  roughness: 0.95,
  metalness: 0
});

const clothMat = new THREE.MeshStandardMaterial({
  map: TEX.cloth,
  color: 0xffffff,
  roughness: 0.82,
  metalness: 0.02,
  bumpMap: TEX.cloth,
  bumpScale: 0.018
});

const coverMat = new THREE.MeshStandardMaterial({
  map: TEX.cloth,
  color: 0xd2ad63,
  roughness: 0.8,
  metalness: 0.03,
  bumpMap: TEX.cloth,
  bumpScale: 0.016
});

const goldMat = new THREE.MeshStandardMaterial({
  color: 0xd8b56a,
  roughness: 0.34,
  metalness: 0.72
});

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function makeCoverBoard(side) {
  const w = 4.56;
  const h = 5.78;
  const r = 0.12;
  const shape = roundedRectShape(w, h, r);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.142,
    bevelEnabled: true,
    bevelSize: 0.012,
    bevelThickness: 0.012,
    bevelSegments: 2,
    steps: 1,
    curveSegments: 8
  });
  geo.rotateX(-Math.PI / 2);
  const board = new THREE.Mesh(geo, coverMat);
  board.position.set(side * 2.29, 0.012, 0);
  board.castShadow = true;
  board.receiveShadow = true;
  book.add(board);

  // thin gold fillet around the cloth edge, visible in the cover margin
  const inset = 0.075;
  const fw = w - inset * 2;
  const fh = h - inset * 2;
  const fr = Math.max(0.04, r - inset * 0.35);
  const points = [];
  const segs = 8;
  const corners = [
    [fw / 2 - fr, fh / 2 - fr, 0],
    [-fw / 2 + fr, fh / 2 - fr, Math.PI / 2],
    [-fw / 2 + fr, -fh / 2 + fr, Math.PI],
    [fw / 2 - fr, -fh / 2 + fr, Math.PI * 1.5]
  ];
  for (const [cx, cy, start] of corners) {
    for (let j = 0; j <= segs; j++) {
      const a = start + (j / segs) * (Math.PI / 2);
      points.push(new THREE.Vector3(cx + Math.cos(a) * fr, 0, cy + Math.sin(a) * fr));
    }
  }
  const foilGeo = new THREE.BufferGeometry().setFromPoints(points);
  const foil = new THREE.LineLoop(foilGeo, new THREE.LineBasicMaterial({
    color: 0xd2ad63, transparent: true, opacity: 0.66
  }));
  foil.position.set(side * 2.29, 0.157, 0);
  book.add(foil);
}

makeCoverBoard(-1);
makeCoverBoard(1);

/* central cloth spine and gold bands */
const spine = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.19, 5.78), clothMat);
spine.position.set(0, 0.1, 0);
spine.castShadow = true;
spine.receiveShadow = true;
book.add(spine);
[-2.63, 2.63].forEach((z) => {
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.204, 0.055), goldMat);
  band.position.set(0, 0.1, z);
  band.castShadow = true;
  book.add(band);
});

/* stacked page blocks */
for (let side = -1; side <= 1; side += 2) {
  for (let i = 0; i < 7; i++) {
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(PAGE_W - 0.006 - i * 0.002, 0.0224, PAGE_H - 0.006 - i * 0.002),
      new THREE.MeshStandardMaterial({
        color: i % 2 ? 0xe9dcc1 : 0xf1e6d0,
        roughness: 0.96,
        metalness: 0
      })
    );
    slab.position.set(side * PAGE_CX, 0.159 + i * 0.0224, 0);
    slab.castShadow = true;
    slab.receiveShadow = true;
    book.add(slab);
  }
}

/* page surfaces with a gentle gutter dip */
function makePageGeometry(side) {
  const geo = new THREE.PlaneGeometry(PAGE_W, PAGE_H, 48, 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const d = side === 'right' ? x + PAGE_W / 2 : PAGE_W / 2 - x;
    const t = clamp(d / 0.36, 0, 1);
    const smooth = t * t * (3 - 2 * t);
    pos.setY(i, -0.05 * (1 - smooth));
  }
  geo.computeVertexNormals();
  return geo;
}

const leftPageMat = new THREE.MeshStandardMaterial({
  map: TEX.paper,
  color: 0xf8eedb,
  roughness: 0.95,
  metalness: 0,
  bumpMap: TEX.paper,
  bumpScale: 0.009
});
const rightPageMat = new THREE.MeshStandardMaterial({
  map: TEX.paper,
  color: 0xf8eedb,
  roughness: 0.95,
  metalness: 0,
  bumpMap: TEX.paper,
  bumpScale: 0.009
});

const leftPage = new THREE.Mesh(makePageGeometry('left'), leftPageMat);
leftPage.position.set(-PAGE_CX, PAGE_SURFACE_Y, 0);
leftPage.receiveShadow = true;
leftPage.castShadow = false;
book.add(leftPage);

const rightPage = new THREE.Mesh(makePageGeometry('right'), rightPageMat);
rightPage.position.set(PAGE_CX, PAGE_SURFACE_Y, 0);
rightPage.receiveShadow = true;
rightPage.castShadow = false;
book.add(rightPage);

/* a dark seam at the binding */
const gutter = new THREE.Mesh(
  new THREE.BoxGeometry(0.028, 0.025, PAGE_H - 0.08),
  new THREE.MeshStandardMaterial({ color: 0x6d5c44, roughness: 1 })
);
gutter.position.set(0, PAGE_SURFACE_Y - 0.043, 0);
book.add(gutter);

/* --------------------------------------------------------------------------
   Blue cloth bookmark ribbon
   -------------------------------------------------------------------------- */
function ribbonGeometry(points, width) {
  const geo = new THREE.BufferGeometry();
  const vertices = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const wave = Math.sin(i * 1.4) * 0.007;
    vertices.push(p.x - width / 2 + wave, p.y, p.z);
    vertices.push(p.x + width / 2 + wave, p.y, p.z);
    uvs.push(0, i / (points.length - 1), 1, i / (points.length - 1));
    if (i < points.length - 1) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

const ribbonPts = [
  new THREE.Vector3(0.18, PAGE_SURFACE_Y + 0.006, 2.36),
  new THREE.Vector3(0.19, PAGE_SURFACE_Y - 0.005, 2.58),
  new THREE.Vector3(0.22, 0.27, 2.82),
  new THREE.Vector3(0.28, 0.14, 3.04),
  new THREE.Vector3(0.33, 0.04, 3.3),
  new THREE.Vector3(0.35, 0.035, 3.58)
];
const ribbon = new THREE.Mesh(
  ribbonGeometry(ribbonPts, 0.17),
  new THREE.MeshStandardMaterial({
    color: 0x1f4d79,
    roughness: 0.7,
    metalness: 0.02,
    side: THREE.DoubleSide
  })
);
ribbon.castShadow = true;
ribbon.receiveShadow = true;
book.add(ribbon);

/* a second slim ribbon shadow-strip gives the cloth a folded edge */
const ribbonEdge = new THREE.Mesh(
  ribbonGeometry(ribbonPts.map((p) => p.clone().add(new THREE.Vector3(0.078, 0.002, 0.01))), 0.018),
  new THREE.MeshStandardMaterial({ color: 0x9ab0c9, roughness: 0.65, side: THREE.DoubleSide })
);
book.add(ribbonEdge);

/* --------------------------------------------------------------------------
   Desk props: field card + fountain pen
   -------------------------------------------------------------------------- */
function makeFieldCardTexture() {
  const w = 512;
  const h = 660;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const rnd = seededRandom(731);
  ctx.fillStyle = '#e9dfc9';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 3000; i++) {
    ctx.fillStyle = `rgba(85,60,32,${0.012 + rnd() * 0.03})`;
    ctx.fillRect(rnd() * w, rnd() * h, 1, 1);
  }
  ctx.strokeStyle = 'rgba(74,58,35,.32)';
  ctx.lineWidth = 2;
  ctx.strokeRect(30, 30, w - 60, h - 60);
  ctx.strokeStyle = 'rgba(74,58,35,.16)';
  ctx.lineWidth = 1;
  ctx.strokeRect(43, 43, w - 86, h - 86);
  ctx.fillStyle = '#483c2b';
  ctx.textAlign = 'left';
  ctx.font = '500 15px "IBM Plex Mono", monospace';
  ctx.fillText('THE FIELD BOOK / UNIT 02', 64, 92);
  ctx.font = '500 13px "IBM Plex Mono", monospace';
  ctx.fillStyle = '#887253';
  ctx.fillText('CYBER LITERACY — NOTES', 64, 115);
  ctx.fillStyle = '#2e281e';
  ctx.font = '700 40px "Playfair Display", Georgia, serif';
  ctx.fillText('EVERY', 64, 188);
  ctx.fillText('THREAT', 64, 232);
  ctx.fillText('TELLS', 64, 276);
  ctx.fillText('A STORY.', 64, 320);
  ctx.strokeStyle = 'rgba(122,96,55,.38)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(64, 365 + i * 30);
    ctx.lineTo(w - 64, 365 + i * 30);
    ctx.stroke();
  }
  // small archival stamp
  ctx.save();
  ctx.translate(w - 125, h - 125);
  ctx.rotate(-0.13);
  ctx.strokeStyle = 'rgba(142,62,47,.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 53, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 43, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(142,62,47,.65)';
  ctx.font = '500 12px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('ARCHIVE', 0, -3);
  ctx.font = '500 8px "IBM Plex Mono", monospace';
  ctx.fillText('DO NOT REMOVE', 0, 14);
  ctx.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

const fieldCard = new THREE.Mesh(
  new THREE.PlaneGeometry(1.7, 2.19),
  new THREE.MeshStandardMaterial({ map: makeFieldCardTexture(), roughness: 0.94 })
);
fieldCard.rotation.x = -Math.PI / 2;
fieldCard.rotation.z = 0.14;
fieldCard.position.set(-3.68, 0.012, -3.35);
fieldCard.receiveShadow = true;
fieldCard.castShadow = true;
book.add(fieldCard);

const pen = new THREE.Group();
{
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.045, 2.9, 10),
    new THREE.MeshStandardMaterial({ color: 0x28342f, roughness: 0.4, metalness: 0.25 })
  );
  body.rotation.z = Math.PI / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  pen.add(body);

  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.062, 0.055, 0.9, 10),
    new THREE.MeshStandardMaterial({ color: 0x1c2623, roughness: 0.38, metalness: 0.3 })
  );
  cap.rotation.z = Math.PI / 2;
  cap.position.x = -1.86;
  cap.castShadow = true;
  pen.add(cap);

  const band = new THREE.Mesh(new THREE.TorusGeometry(0.061, 0.01, 6, 18), goldMat);
  band.rotation.y = Math.PI / 2;
  band.position.x = -1.4;
  pen.add(band);

  const tip = new THREE.Mesh(
    new THREE.ConeGeometry(0.052, 0.38, 10),
    new THREE.MeshStandardMaterial({ color: 0xc9a55f, roughness: 0.3, metalness: 0.65 })
  );
  tip.rotation.z = -Math.PI / 2;
  tip.position.x = 1.62;
  tip.castShadow = true;
  pen.add(tip);
}
pen.position.set(5.0, 0.09, 2.52);
pen.rotation.y = 0.34;
pen.rotation.z = 0.02;
book.add(pen);

/* --------------------------------------------------------------------------
   Floating dust in the sunbeam
   -------------------------------------------------------------------------- */
const dustCount = 110;
const dustGeo = new THREE.BufferGeometry();
const dustPositions = new Float32Array(dustCount * 3);
const dustSeed = [];
const rndDust = seededRandom(391);
for (let i = 0; i < dustCount; i++) {
  dustPositions[i * 3] = (rndDust() - 0.5) * 12;
  dustPositions[i * 3 + 1] = 0.4 + rndDust() * 4.2;
  dustPositions[i * 3 + 2] = (rndDust() - 0.5) * 8;
  dustSeed.push({ speed: 0.03 + rndDust() * 0.08, phase: rndDust() * Math.PI * 2, amp: 0.04 + rndDust() * 0.2 });
}
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
const dustMat = new THREE.PointsMaterial({
  size: 0.026,
  map: TEX.dot,
  color: 0xffe6b7,
  transparent: true,
  opacity: 0.42,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true
});
const dust = new THREE.Points(dustGeo, dustMat);
scene.add(dust);

/* ==========================================================================
   PART 3 — Printed pages, CSS3D reading page, pop-up assembly
   ========================================================================== */
try {
  await Promise.race([
    document.fonts.ready,
    new Promise((resolve) => setTimeout(resolve, 1600))
  ]);
} catch (error) {
  console.warn('Fonts did not settle in time', error);
}

/* Right-hand printed plate per spread. */
const plateTextures = SCHEMA.spreads.map((spread, i) => POP.makePlateTexture(spread, i));
rightPageMat.map = plateTextures[0];
rightPageMat.color.set(0xffffff);
rightPageMat.needsUpdate = true;

/* --------------------------------------------------------------------------
   Page-turn sheet
   -------------------------------------------------------------------------- */
const sheetPivot = new THREE.Group();
sheetPivot.position.set(0, PAGE_SURFACE_Y + 0.048, 0);
sheetPivot.visible = false;
book.add(sheetPivot);

const sheetGeo = new THREE.PlaneGeometry(PAGE_W, PAGE_H, 42, 1);
sheetGeo.rotateX(-Math.PI / 2);
const sheetBasePositions = new Float32Array(sheetGeo.attributes.position.array);
const sheetMaterial = new THREE.MeshStandardMaterial({
  map: plateTextures[0],
  color: 0xfff8e8,
  roughness: 0.94,
  metalness: 0,
  side: THREE.DoubleSide,
  bumpMap: TEX.paper,
  bumpScale: 0.007
});
const turnSheet = new THREE.Mesh(sheetGeo, sheetMaterial);
turnSheet.position.x = PAGE_CX;
turnSheet.castShadow = true;
turnSheet.receiveShadow = true;
sheetPivot.add(turnSheet);

const flipState = { p: 0 };

function bendTurnSheet(amount) {
  const positions = sheetGeo.attributes.position;
  const count = positions.count;
  for (let i = 0; i < count; i++) {
    const x = sheetBasePositions[i * 3];
    const y = sheetBasePositions[i * 3 + 1];
    const z = sheetBasePositions[i * 3 + 2];
    const u = clamp((x + PAGE_W / 2) / PAGE_W, 0, 1);
    positions.setXYZ(i, x, y + Math.sin(u * Math.PI) * amount, z);
  }
  positions.needsUpdate = true;
  sheetGeo.computeVertexNormals();
}

function applyFlipState() {
  sheetPivot.rotation.z = flipState.p * Math.PI;
  const bulge = Math.sin(Math.PI * clamp(flipState.p, 0, 1)) * 0.26;
  bendTurnSheet(bulge);
}

/* --------------------------------------------------------------------------
   CSS3D reading page
   -------------------------------------------------------------------------- */
const pageEl = document.createElement('div');
pageEl.className = 'paper-page';
pageEl.id = 'paperPage';
pageEl.dir = 'rtl';
pageEl.style.width = `${DOM_W}px`;
pageEl.style.height = `${DOM_H}px`;
pageEl.style.left = '0';
pageEl.style.top = '0';
pageEl.style.pointerEvents = 'none';

const pageObject = new CSS3DObject(pageEl);
pageObject.rotation.x = -Math.PI / 2;
pageObject.position.set(-PAGE_CX * CSS3D_SCALE, PAGE_CSS_Y * CSS3D_SCALE, 0);
cssBook.add(pageObject);

let pageRefs = null;
let readerRefs = null;
let readerLastFocus = null;

function titleSizeFor(title) {
  if (title.length > 27) return 'xs';
  if (title.length > 20) return 'sm';
  if (title.length > 13) return 'md';
  return 'lg';
}

function pageTemplate(spread, index, surface = 'page') {
  const size = titleSizeFor(spread.title);
  const stampLabel = state.seen[index].size === 3 ? 'اكتملت الجولة' : 'بانتظار الجولة';
  return `
    <div class="page-gutter" aria-hidden="true"></div>
    <div class="page-content">
      <header class="lesson-head">
        <div class="kicker">
          <span class="kicker-en">${spread.eyebrow}</span>
          <span class="kicker-line"></span>
          <span class="kicker-ar">${spread.kicker}</span>
        </div>
        <h2 class="page-title" data-size="${size}">${spread.title}</h2>
        <div class="title-underline" aria-hidden="true">
          <svg viewBox="0 0 116 8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M2 4.8c17-2.7 37-3.6 56-2.7 21 1 38 2.7 56 1.5"/>
            <path d="M8 7c23-1.7 49-1.5 71-0.8" opacity=".45" stroke-width="1.2"/>
          </svg>
        </div>
        <p class="page-summary">${spread.summary}</p>
      </header>

      <section class="lesson-block" aria-label="${spread.principle.caption}">
        <div class="block-head">
          <span class="sec-num" aria-hidden="true">01</span>
          <span class="sec-ar">${spread.principle.caption}</span>
          <span class="sec-en">PRINCIPLE</span>
        </div>
        <div class="principle-box">
          <p class="principle-rule">${spread.principle.rule}</p>
          <p class="principle-code">${spread.principle.code}</p>
        </div>
      </section>

      <section class="lesson-block" aria-label="المصطلحات الأساسية">
        <div class="block-head">
          <span class="sec-num" aria-hidden="true">02</span>
          <span class="sec-ar">المصطلحات الأساسية</span>
          <span class="sec-en">KEY TERMS</span>
        </div>
        <div class="terms-grid">
          ${spread.vocab.map((term, i) => `
            <div class="term">
              <div class="term-name"><span class="term-i">0${i + 1}</span>${term.term}</div>
              <div class="term-def">${term.def}</div>
            </div>`).join('')}
        </div>
      </section>

      <section class="lesson-block" aria-label="توقّع ثم اكتشف">
        <div class="block-head">
          <span class="sec-num" aria-hidden="true">03</span>
          <span class="sec-ar">توقّع ثم اكتشف</span>
          <span class="sec-en">PREDICT</span>
        </div>
        <div class="quiz" role="radiogroup" aria-label="${spread.predict.question}">
          <p class="quiz-q">${spread.predict.question}</p>
          ${spread.predict.options.map((option, i) => `
            <label class="opt${i === spread.predict.correct ? ' is-correct' : ''}">
              <input type="radio" name="predict-${index}-${surface}" value="${i}">
              <span class="radio" aria-hidden="true"></span>
              <span class="opt-text">${option}</span>
              <span class="answer-mark" aria-hidden="true">✓</span>
            </label>`).join('')}
        </div>
        <div class="flap-card">
          <button class="flap-cover" type="button" disabled aria-expanded="false" aria-controls="whyAnswer-${index}-${surface}">
            <span class="flap-face">
              <span class="flap-lock" aria-hidden="true"><svg><use href="#i-lock"/></svg></span>
              <span class="flap-main">${spread.flap.locked}</span>
              <span class="flap-hint">WHY?</span>
            </span>
            <span class="flap-back" aria-hidden="true">؟</span>
          </button>
          <div class="flap-answer" id="whyAnswer-${index}-${surface}">
            <div class="why-label">WHY THIS MATTERS</div>
            <p>${spread.predict.why}</p>
            <p class="answer-note">${spread.scene.note}</p>
            <button class="flap-close" type="button">${spread.flap.close}</button>
          </div>
        </div>
      </section>

      <aside class="margin-note" aria-label="ملاحظة ميدانية">
        <div class="note-rule" aria-hidden="true"><span></span><i></i></div>
        <div class="note-head">
          <span class="note-kicker">FIELD NOTE · ${spread.scene.figure}</span>
          <span class="note-legend">${spread.scene.legend}</span>
        </div>
        <p>${spread.scene.note}</p>
      </aside>
    </div>

    <div class="page-foot">
      <div class="stamp" role="img" aria-label="تقدّم جولة الصفحة: ${state.seen[index].size} من 3">
        <svg class="stamp-ring" viewBox="0 0 76 76" aria-hidden="true">
          <circle cx="38" cy="38" r="35"/>
        </svg>
        <div class="stamp-inner">
          <span class="stamp-en">FIELD REVIEW</span>
          <span class="stamp-ar">${stampLabel}</span>
          <span class="stamp-count">${state.seen[index].size} / 3</span>
        </div>
      </div>
      <div class="folio-wrap">
        <span class="folio-kicker">THE THREAT LANDSCAPE · UNIT 02</span>
        <span class="folio">P.${spread.page} — ${pad2(spread.n)} / 05</span>
      </div>
    </div>`;

}

function activePageRefs() {
  return [pageRefs, readerRefs].filter(Boolean);
}

function selectOption(i, spread) {
  if (state.flipping) return;
  state.answered = true;
  state.selected = i;
  activePageRefs().forEach((refs) => {
    refs.labels.forEach((label, li) => label.classList.toggle('is-selected', li === i));
    if (refs.inputs[i]) refs.inputs[i].checked = true;
    refs.cover.disabled = false;
    refs.coverMain.textContent = spread.flap.reveal;
    refs.cover.setAttribute('aria-label', spread.flap.reveal);
  });
  announce('تم تسجيل توقعك. ارفع الغطاء الآن لمعرفة السبب.');
  playUiSound('select');
}

function setFlap(open, spread, silent = false) {
  state.flapOpen = open;
  activePageRefs().forEach((refs) => {
    refs.flapCard.classList.toggle('is-open', open);
    refs.root.classList.toggle('is-flap-open', open);
    refs.cover.setAttribute('aria-expanded', String(open));
    refs.quiz.classList.toggle('show-answer', open);
  });
  if (silent) return;
  if (open) {
    announce(spread.predict.why);
    playUiSound('reveal');
  } else {
    playUiSound('click');
  }
}

function syncPageRefs(refs, spread) {
  if (state.selected >= 0 && refs.inputs[state.selected]) {
    refs.inputs[state.selected].checked = true;
    refs.labels.forEach((label, li) => label.classList.toggle('is-selected', li === state.selected));
    refs.cover.disabled = false;
    refs.coverMain.textContent = spread.flap.reveal;
    refs.cover.setAttribute('aria-label', spread.flap.reveal);
  }
  refs.flapCard.classList.toggle('is-open', state.flapOpen);
  refs.root.classList.toggle('is-flap-open', state.flapOpen);
  refs.cover.setAttribute('aria-expanded', String(state.flapOpen));
  refs.quiz.classList.toggle('show-answer', state.flapOpen);
}

function bindPage(root, spread, index) {
  const refs = {
    root,
    quiz: root.querySelector('.quiz'),
    flapCard: root.querySelector('.flap-card'),
    cover: root.querySelector('.flap-cover'),
    coverMain: root.querySelector('.flap-main'),
    answer: root.querySelector('.flap-answer'),
    close: root.querySelector('.flap-close'),
    stamp: root.querySelector('.stamp'),
    stampAr: root.querySelector('.stamp-ar'),
    stampCount: root.querySelector('.stamp-count'),
    labels: [...root.querySelectorAll('.opt')],
    inputs: [...root.querySelectorAll('.opt input')]
  };

  refs.inputs.forEach((input, i) => {
    input.addEventListener('change', () => selectOption(i, spread));
  });

  refs.cover.addEventListener('click', (event) => {
    event.stopPropagation();
    if (refs.cover.disabled || state.flipping) return;
    setFlap(!state.flapOpen, spread);
  });

  refs.close.addEventListener('click', (event) => {
    event.stopPropagation();
    setFlap(false, spread, true);
  });

  syncPageRefs(refs, spread);
  return refs;
}

function renderPage(spread, index) {
  pageEl.innerHTML = pageTemplate(spread, index, 'page');
  state.flapOpen = false;
  state.answered = false;
  state.selected = -1;
  pageRefs = bindPage(pageEl, spread, index);
  updateStampUI();
}

function closeFlap() {
  setFlap(false, SCHEMA.spreads[state.idx], true);
}

/* --------------------------------------------------------------------------
   Mobile reading overlay
   -------------------------------------------------------------------------- */
function renderReader() {
  if (!state.readerOpen) return;
  const spread = SCHEMA.spreads[state.idx];
  ui.readerPage.innerHTML = pageTemplate(spread, state.idx, 'reader');
  readerRefs = bindPage(ui.readerPage, spread, state.idx);
  updateStampUI();

  const total = state.seen.reduce((sum, set) => sum + set.size, 0);
  ui.readerIndex.textContent = `${pad2(spread.n)} / ${pad2(SCHEMA.spreads.length)}`;
  ui.readerProgress.textContent = `${total} / ${SCHEMA.spreads.length * 3}`;
  ui.readerProgress.setAttribute('aria-label', `${total} من ${SCHEMA.spreads.length * 3} نموذجًا مستكشفًا.`);
  ui.readerPrev.disabled = state.idx === 0;
  ui.readerNext.disabled = state.idx === SCHEMA.spreads.length - 1;
  ui.readerScroll.scrollTop = 0;
}

function openReader() {
  if (state.readerOpen) return;
  stopDemo();
  closeToc();
  readerLastFocus = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : ui.focusBtn;
  state.readerOpen = true;
  ui.focusBtn.setAttribute('aria-pressed', 'true');
  document.body.classList.add('reader-open');
  ui.reader.classList.add('is-open');
  ui.reader.setAttribute('aria-hidden', 'false');
  renderReader();
  requestAnimationFrame(() => ui.readerClose.focus({ preventScroll: true }));
  announce('وضع القراءة. استخدم زرّي السابق والتالي للتنقل، أو اسحب للأسفل لقراءة الصفحة.');
}

function closeReader() {
  if (!state.readerOpen) return;
  state.readerOpen = false;
  ui.focusBtn.setAttribute('aria-pressed', 'false');
  document.body.classList.remove('reader-open');
  ui.reader.classList.remove('is-open');
  ui.reader.setAttribute('aria-hidden', 'true');
  readerRefs = null;
  const target = readerLastFocus && document.contains(readerLastFocus) ? readerLastFocus : ui.focusBtn;
  requestAnimationFrame(() => target.focus({ preventScroll: true }));
  announce('عُدنا إلى الكتاب.');
}

function toggleReader() {
  if (state.readerOpen) closeReader();
  else openReader();
}

function readerGoTo(next) {
  const target = clamp(next, 0, SCHEMA.spreads.length - 1);
  if (target === state.idx) return;
  setFlap(false, SCHEMA.spreads[state.idx], true);
  setSpread(target, { instant: false, animatePopups: false });
  playUiSound('turn');
}

/* --------------------------------------------------------------------------
   Stamp, tags, pop-up records
   -------------------------------------------------------------------------- */
function updateStampUI() {
  const count = state.seen[state.idx] ? state.seen[state.idx].size : 0;
  const done = count === 3;
  activePageRefs().forEach((refs) => {
    refs.stamp.classList.toggle('is-stamped', done);
    refs.stampCount.textContent = `${count} / 3`;
    refs.stampAr.textContent = done ? 'اكتملت الجولة' : 'بانتظار الجولة';
    refs.stamp.setAttribute('aria-label', done
      ? 'اكتملت جولة الصفحة: ثلاثة من ثلاثة.'
      : `تقدّم جولة الصفحة: ${count} من 3.`);
  });
  if (state.readerOpen) {
    const total = state.seen.reduce((sum, set) => sum + set.size, 0);
    ui.readerProgress.textContent = `${total} / ${SCHEMA.spreads.length * 3}`;
    ui.readerProgress.setAttribute('aria-label', `${total} من ${SCHEMA.spreads.length * 3} نموذجًا مستكشفًا.`);
  }
  updateTocState();
}

const spreadGroups = [];
const hitboxes = [];
const objectRecords = [];

function createPopup(def, spread, spreadIndex, indexInSpread, parent) {
  const built = POP.buildPopup(def, spread);
  built.group.position.set(def.pos[0], 0, def.pos[1]);
  parent.add(built.group);

  const tagEl = document.createElement('button');
  tagEl.type = 'button';
  tagEl.className = 'obj-tag';
  tagEl.setAttribute('aria-pressed', 'false');
  tagEl.setAttribute('aria-label', `اكتشف ${def.label}`);
  tagEl.innerHTML = `<span class="obj-num">${pad2(indexInSpread + 1)}</span><span class="obj-name">${def.label}</span>`;
  tagEl.addEventListener('pointerdown', (event) => event.stopPropagation());
  tagEl.addEventListener('click', (event) => {
    event.stopPropagation();
    if (state.flipping) return;
    if (state.demo !== 'idle') stopDemo();
    activateObject(record);
  });

  const tag = new CSS2DObject(tagEl);
  tag.position.set(0, built.tagY, 0);
  tag.center.set(0.5, 1);
  tag.visible = false;
  built.group.add(tag);

  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(def.hit[0], def.hit[1], def.hit[2]),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hit.position.y = def.hit[1] / 2 + 0.02;
  built.group.add(hit);

  const record = {
    def,
    spread,
    spreadIndex,
    indexInSpread,
    group: built.group,
    tag,
    tagEl,
    hit,
    tagY: built.tagY,
    activate: built.activate,
    update: built.update || (() => {}),
    active: false
  };
  hit.userData.record = record;
  hitboxes.push(hit);
  objectRecords.push(record);
  return record;
}

SCHEMA.spreads.forEach((spread, si) => {
  const group = new THREE.Group();
  group.position.set(PAGE_CX, PAGE_POP_Y, 0);
  group.visible = false;
  book.add(group);
  const recs = spread.scene.objects.map((def, oi) => createPopup(def, spread, si, oi, group));
  spreadGroups.push({ group, recs });
});

/* --------------------------------------------------------------------------
   Spread swapping
   -------------------------------------------------------------------------- */
function popupSpread(si, instant = false) {
  const entry = spreadGroups[si];
  if (!entry) return;
  entry.group.visible = true;
  entry.recs.forEach((record, i) => {
    gsap.killTweensOf(record.group.rotation);
    gsap.killTweensOf(record.group.scale);
    record.tag.visible = false;
    if (instant) {
      record.group.rotation.x = 0;
      record.group.scale.setScalar(1);
      record.tag.visible = true;
    } else {
      record.group.rotation.x = -1.32;
      record.group.scale.setScalar(0.88);
      gsap.to(record.group.rotation, {
        x: 0, duration: 0.82, delay: i * 0.1, ease: 'back.out(1.25)'
      });
      gsap.to(record.group.scale, {
        x: 1, y: 1, z: 1, duration: 0.68, delay: i * 0.1, ease: 'power3.out'
      });
      gsap.delayedCall(0.58 + i * 0.1, () => {
        if (spreadGroups[state.idx] === entry) record.tag.visible = true;
      });
    }
    const seen = state.seen[si].has(record.def.id);
    record.tagEl.classList.toggle('is-active', seen);
    record.tagEl.setAttribute('aria-pressed', String(seen));
    record.active = seen;
    if (seen) record.activate(true);
  });
}

function foldSpread(si, instant = false) {
  const entry = spreadGroups[si];
  if (!entry) return Promise.resolve();
  entry.recs.forEach((record) => { record.tag.visible = false; });
  if (instant) {
    entry.recs.forEach((record) => {
      record.group.rotation.x = -1.32;
      record.group.scale.setScalar(0.88);
    });
    entry.group.visible = false;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const tl = gsap.timeline({ onComplete: () => { entry.group.visible = false; resolve(); } });
    entry.recs.forEach((record, i) => {
      tl.to(record.group.rotation, {
        x: -1.38, duration: 0.4, ease: 'power2.in'
      }, i * 0.035);
      tl.to(record.group.scale, {
        x: 0.9, y: 0.9, z: 0.9, duration: 0.35, ease: 'power2.in'
      }, i * 0.035);
    });
  });
}

function setSpread(si, { instant = false, animatePopups = true } = {}) {
  const safe = clamp(si, 0, SCHEMA.spreads.length - 1);
  spreadGroups.forEach((entry, i) => {
    if (i !== safe) {
      entry.group.visible = false;
      entry.recs.forEach((record) => { record.tag.visible = false; });
    }
  });
  state.idx = safe;
  const spread = SCHEMA.spreads[safe];
  setAccent(spread.scene.accent);
  rightPageMat.map = plateTextures[safe];
  rightPageMat.needsUpdate = true;
  renderPage(spread, safe);
  ui.hudIndex.textContent = `${pad2(spread.n)} / ${pad2(SCHEMA.spreads.length)}`;
  ui.hudTitle.textContent = spread.title;
  ui.prevBtn.disabled = safe === 0;
  ui.nextBtn.disabled = safe === SCHEMA.spreads.length - 1;
  popupSpread(safe, instant || !animatePopups || state.reduced);
  updateTocState();
  if (state.readerOpen) renderReader();
}

/* ==========================================================================
   PART 4 — Interaction, particles, demo, page turns, boot
   ========================================================================== */

/* --------------------------------------------------------------------------
   A tiny analogue synth for paper clicks and page turns
   -------------------------------------------------------------------------- */
let audioCtx = null;

function ensureAudio() {
  if (audioCtx) return audioCtx;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  audioCtx = new AudioContextClass();
  return audioCtx;
}

function tone(freq, duration, type = 'sine', gainValue = 0.05, when = 0) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const t = ctx.currentTime + when;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(gainValue, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + duration + 0.03);
}

function noise(duration = 0.25, gainValue = 0.04) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const length = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1400;
  filter.Q.value = 0.7;
  const gain = ctx.createGain();
  gain.gain.value = gainValue;
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start();
}

function playUiSound(kind) {
  if (!state.sound) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  if (kind === 'select') {
    tone(520, 0.07, 'sine', 0.035);
  } else if (kind === 'reveal') {
    tone(392, 0.12, 'triangle', 0.04);
    tone(587, 0.18, 'triangle', 0.03, 0.06);
  } else if (kind === 'discover') {
    tone(330, 0.13, 'sine', 0.045);
    tone(494, 0.15, 'sine', 0.035, 0.07);
    tone(659, 0.2, 'sine', 0.025, 0.14);
  } else if (kind === 'stamp') {
    tone(116, 0.15, 'square', 0.03);
    tone(174, 0.2, 'triangle', 0.025, 0.02);
  } else if (kind === 'turn') {
    noise(0.34, 0.032);
    tone(180, 0.22, 'sine', 0.02);
  } else if (kind === 'click') {
    tone(740, 0.03, 'square', 0.018);
  }
}

/* --------------------------------------------------------------------------
   Ink-and-light particle bursts
   -------------------------------------------------------------------------- */
const MAX_PARTICLES = 420;
const particlePositions = new Float32Array(MAX_PARTICLES * 3);
const particleColors = new Float32Array(MAX_PARTICLES * 3);
const particleVelocities = new Float32Array(MAX_PARTICLES * 3);
const particleLife = new Float32Array(MAX_PARTICLES);
const particleBase = new Float32Array(MAX_PARTICLES * 3);
let particleCursor = 0;

for (let i = 0; i < MAX_PARTICLES; i++) {
  particlePositions[i * 3 + 1] = -40;
}

const particleGeo = new THREE.BufferGeometry();
particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
particleGeo.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
const particleMat = new THREE.PointsMaterial({
  size: 0.055,
  map: TEX.dot,
  vertexColors: true,
  transparent: true,
  opacity: 0.95,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true
});
const particles = new THREE.Points(particleGeo, particleMat);
particles.frustumCulled = false;
scene.add(particles);

function spawnBurst(worldPosition, hex, count = 34) {
  if (state.reduced) return;
  const color = new THREE.Color(hex);
  for (let n = 0; n < count; n++) {
    const i = particleCursor % MAX_PARTICLES;
    particleCursor++;
    const angle = Math.random() * Math.PI * 2;
    const radius = 0.25 + Math.random() * 0.9;
    const lift = 0.4 + Math.random() * 1.5;
    particlePositions[i * 3] = worldPosition.x + Math.cos(angle) * 0.12;
    particlePositions[i * 3 + 1] = worldPosition.y + Math.random() * 0.25;
    particlePositions[i * 3 + 2] = worldPosition.z + Math.sin(angle) * 0.12;
    particleVelocities[i * 3] = Math.cos(angle) * radius;
    particleVelocities[i * 3 + 1] = lift;
    particleVelocities[i * 3 + 2] = Math.sin(angle) * radius;
    particleLife[i] = 0.9 + Math.random() * 0.7;
    const warm = color.clone().lerp(new THREE.Color(0xfff1c9), Math.random() * 0.55);
    particleBase[i * 3] = warm.r;
    particleBase[i * 3 + 1] = warm.g;
    particleBase[i * 3 + 2] = warm.b;
    particleColors[i * 3] = warm.r;
    particleColors[i * 3 + 1] = warm.g;
    particleColors[i * 3 + 2] = warm.b;
  }
  particleGeo.attributes.position.needsUpdate = true;
  particleGeo.attributes.color.needsUpdate = true;
}

function updateParticles(dt) {
  let touched = false;
  for (let i = 0; i < MAX_PARTICLES; i++) {
    if (particleLife[i] <= 0) continue;
    touched = true;
    particleLife[i] -= dt;
    if (particleLife[i] <= 0) {
      particlePositions[i * 3 + 1] = -40;
      particleColors[i * 3] = 0;
      particleColors[i * 3 + 1] = 0;
      particleColors[i * 3 + 2] = 0;
      continue;
    }
    particleVelocities[i * 3 + 1] -= 1.35 * dt;
    particlePositions[i * 3] += particleVelocities[i * 3] * dt;
    particlePositions[i * 3 + 1] += particleVelocities[i * 3 + 1] * dt;
    particlePositions[i * 3 + 2] += particleVelocities[i * 3 + 2] * dt;
    const fade = clamp(particleLife[i] / 1.1, 0, 1);
    particleColors[i * 3] = particleBase[i * 3] * fade;
    particleColors[i * 3 + 1] = particleBase[i * 3 + 1] * fade;
    particleColors[i * 3 + 2] = particleBase[i * 3 + 2] * fade;
  }
  if (touched) {
    particleGeo.attributes.position.needsUpdate = true;
    particleGeo.attributes.color.needsUpdate = true;
  }
}

const flashLight = new THREE.PointLight(0xffca82, 0, 8, 2);
scene.add(flashLight);

function flashAt(worldPosition, hex) {
  if (state.reduced) return;
  flashLight.color.set(hex);
  flashLight.position.copy(worldPosition);
  gsap.killTweensOf(flashLight);
  gsap.fromTo(flashLight, { intensity: 0 }, {
    intensity: 9, duration: 0.22, ease: 'power2.out',
    onComplete: () => gsap.to(flashLight, { intensity: 0, duration: 0.8, ease: 'power2.in' })
  });
}

const worldScratch = new THREE.Vector3();

function activateObject(record, { instant = false, silent = false } = {}) {
  if (state.flipping) return;
  const spreadIndex = record.spreadIndex;
  const wasComplete = state.seen[spreadIndex].size === 3;
  const first = !state.seen[spreadIndex].has(record.def.id);
  state.seen[spreadIndex].add(record.def.id);
  record.active = true;
  record.activate(instant);
  record.tagEl.classList.add('is-active');
  record.tagEl.setAttribute('aria-pressed', 'true');
  updateStampUI();

  record.group.getWorldPosition(worldScratch);
  worldScratch.y += Math.min(1.1, 0.5 + record.indexInSpread * 0.02);

  if (!instant) {
    spawnBurst(worldScratch, record.spread.scene.accent, first ? 46 : 26);
    flashAt(worldScratch, record.spread.scene.accent);
    playUiSound(first ? 'discover' : 'select');
  }

  if (!silent) {
    showCaption(
      `${record.spread.scene.figure} · ${pad2(record.indexInSpread + 1)} / 03`,
      `${record.def.label} — ${record.def.caption}`,
      4800
    );
    announce(`${record.def.label}. ${record.def.caption}`);
  }

  if (!wasComplete && state.seen[spreadIndex].size === 3) {
    setTimeout(() => {
      if (state.idx !== spreadIndex) return;
      showCaption('FIELD REVIEW', 'اكتملت جولة الصفحة: عرفت الدرع، المسار، ونقطة الانكشاف.', 5200);
      playUiSound('stamp');
      const stamp = pageRefs && pageRefs.stamp;
      if (stamp && !state.reduced) {
        gsap.fromTo(stamp, { scale: 1.25, rotate: -18 }, {
          scale: 1, rotate: -9, duration: 0.5, ease: 'back.out(2)'
        });
      }
    }, 420);
  }
}

/* --------------------------------------------------------------------------
   Table of contents and HUD state
   -------------------------------------------------------------------------- */
function buildToc() {
  ui.tocList.innerHTML = SCHEMA.spreads.map((spread, i) => `
    <button class="toc-item" type="button" data-index="${i}" aria-label="الانتقال إلى ${spread.title}">
      <span class="toc-num">${pad2(spread.n)}</span>
      <span class="toc-copy">
        <span class="toc-item-title">${spread.title}</span>
        <span class="toc-item-en">${spread.eyebrow.split(' / ')[1] || spread.eyebrow}</span>
      </span>
      <span class="toc-page">ص ${spread.page}</span>
      <span class="toc-check" aria-hidden="true">✓</span>
    </button>`).join('');
  ui.tocList.querySelectorAll('.toc-item').forEach((button) => {
    button.addEventListener('click', () => {
      const i = Number(button.dataset.index);
      closeToc();
      goToSpread(i);
    });
  });
}

function updateTocState() {
  if (!ui.tocList) return;
  let total = 0;
  SCHEMA.spreads.forEach((spread, i) => { total += state.seen[i].size; });
  ui.tocList.querySelectorAll('.toc-item').forEach((button) => {
    const i = Number(button.dataset.index);
    button.classList.toggle('is-current', i === state.idx);
    button.classList.toggle('is-done', state.seen[i].size === 3);
  });
  const max = SCHEMA.spreads.length * 3;
  ui.tocProgressBar.style.width = `${(total / max) * 100}%`;
  ui.tocProgressLabel.textContent = `${total} / ${max}`;
}

function openToc() {
  ui.toc.classList.add('is-open');
  ui.toc.setAttribute('aria-hidden', 'false');
  ui.tocBtn.setAttribute('aria-expanded', 'true');
}

function closeToc() {
  ui.toc.classList.remove('is-open');
  ui.toc.setAttribute('aria-hidden', 'true');
  ui.tocBtn.setAttribute('aria-expanded', 'false');
}

function toggleToc() {
  if (ui.toc.classList.contains('is-open')) closeToc();
  else openToc();
}

function syncPlayButton() {
  const playing = state.demo === 'playing';
  ui.playBtn.classList.toggle('is-playing', playing);
  ui.playBtn.setAttribute('aria-label', playing ? 'إيقاف العرض الموجّه مؤقتًا' : 'تشغيل العرض الموجّه');
  ui.playBtn.title = playing ? 'إيقاف مؤقت' : 'عرض موجّه';
}

function syncSoundButton() {
  ui.soundBtn.setAttribute('aria-pressed', String(state.sound));
  ui.soundBtn.setAttribute('aria-label', state.sound ? 'كتم الصوت' : 'تشغيل الصوت');
}

function syncContrastButton() {
  ui.contrastBtn.setAttribute('aria-pressed', String(state.hc));
  ui.contrastBtn.setAttribute('aria-label', state.hc ? 'إيقاف التباين العالي' : 'تبديل التباين العالي');
}

function syncMotionButton() {
  ui.motionBtn.setAttribute('aria-pressed', String(state.reduced));
  ui.motionBtn.setAttribute('aria-label', state.reduced ? 'تشغيل الحركة' : 'تقليل الحركة');
}

/* --------------------------------------------------------------------------
   Camera choreography helpers
   -------------------------------------------------------------------------- */
let cameraTweenToken = 0;

function tweenCamera(view, duration = 1.05) {
  const token = ++cameraTweenToken;
  const dur = state.reduced ? 0.001 : duration;
  gsap.killTweensOf(camera.position);
  gsap.killTweensOf(controls.target);
  gsap.killTweensOf(camera);
  gsap.to(camera.position, {
    x: view.pos.x, y: view.pos.y, z: view.pos.z,
    duration: dur, ease: 'power3.inOut'
  });
  gsap.to(controls.target, {
    x: view.target.x, y: view.target.y, z: view.target.z,
    duration: dur, ease: 'power3.inOut'
  });
  gsap.to(camera, {
    fov: view.fov, duration: dur, ease: 'power2.inOut',
    onUpdate: () => {
      if (token === cameraTweenToken) camera.updateProjectionMatrix();
    }
  });
}

function objectView(record) {
  const world = new THREE.Vector3();
  record.group.getWorldPosition(world);
  world.y += Math.min(0.9, record.tagY * 0.38);
  const target = world.clone();
  const offset = new THREE.Vector3(0.45, 3.1, 5.5);
  return {
    fov: 40,
    target,
    pos: target.clone().add(offset)
  };
}

/* --------------------------------------------------------------------------
   Guided demo
   -------------------------------------------------------------------------- */
let demoTimeline = null;

function startDemo() {
  if (state.reduced || state.flipping) return;
  closeToc();
  closeFlap();
  state.demo = 'playing';
  controls.enabled = false;
  syncPlayButton();
  hideCaption();

  const spread = SCHEMA.spreads[state.idx];
  const entry = spreadGroups[state.idx];
  const base = viewForAspect(window.innerWidth / window.innerHeight, false);
  const tl = gsap.timeline({
    onComplete: finishDemo,
    onUpdate: () => camera.updateProjectionMatrix()
  });
  demoTimeline = tl;

  tl.call(() => {
    showCaption('WATCH DEMO', `جولة موجّهة داخل «${spread.scene.title}» — راقب النماذج وهي تنهض.`, 4600, true);
  });
  tl.to(camera.position, {
    x: base.pos.x, y: base.pos.y, z: base.pos.z, duration: 0.9, ease: 'power2.inOut'
  }, 0);
  tl.to(controls.target, {
    x: base.target.x, y: base.target.y, z: base.target.z, duration: 0.9, ease: 'power2.inOut'
  }, 0);
  tl.to(camera, { fov: base.fov, duration: 0.9 }, 0);
  tl.to({}, { duration: 1.1 });

  entry.recs.forEach((record, i) => {
    const at = 1.9 + i * 2.55;
    const view = objectView(record);
    tl.to(camera.position, {
      x: view.pos.x, y: view.pos.y, z: view.pos.z, duration: 1.25, ease: 'power2.inOut'
    }, at);
    tl.to(controls.target, {
      x: view.target.x, y: view.target.y, z: view.target.z, duration: 1.25, ease: 'power2.inOut'
    }, at);
    tl.to(camera, { fov: view.fov, duration: 1.25 }, at);
    tl.call(() => {
      showCaption(
        `${spread.scene.figure} · ${pad2(i + 1)} / 03`,
        `${record.def.label} — ${record.def.caption}`,
        6000,
        true
      );
      activateObject(record, { silent: true });
    }, null, at + 1.05);
    tl.to({}, { duration: 1.25 }, at + 1.05);
  });

  const endAt = 1.9 + entry.recs.length * 2.55 + 0.1;
  tl.to(camera.position, {
    x: base.pos.x, y: base.pos.y, z: base.pos.z, duration: 1.3, ease: 'power3.inOut'
  }, endAt);
  tl.to(controls.target, {
    x: base.target.x, y: base.target.y, z: base.target.z, duration: 1.3, ease: 'power3.inOut'
  }, endAt);
  tl.to(camera, { fov: base.fov, duration: 1.3 }, endAt);
  tl.call(() => hideCaption(), null, endAt + 1.25);
}

function finishDemo() {
  state.demo = 'idle';
  demoTimeline = null;
  controls.enabled = true;
  syncPlayButton();
  hideCaption();
}

function stopDemo() {
  if (state.demo === 'idle') return;
  if (demoTimeline) {
    demoTimeline.kill();
    demoTimeline = null;
  }
  state.demo = 'idle';
  controls.enabled = !state.flipping;
  syncPlayButton();
  hideCaption();
}

function toggleDemo() {
  if (state.reduced) return;
  if (state.demo === 'playing') {
    demoTimeline.pause();
    state.demo = 'paused';
    syncPlayButton();
    showCaption('DEMO PAUSED', 'العرض متوقف مؤقتًا. اضغط متابعة أو اسحب الكتاب لإنهائه.', 3600);
    return;
  }
  if (state.demo === 'paused') {
    state.demo = 'playing';
    demoTimeline.resume();
    syncPlayButton();
    hideCaption();
    return;
  }
  startDemo();
}

/* --------------------------------------------------------------------------
   Reset and reading focus
   -------------------------------------------------------------------------- */
function resetView() {
  stopDemo();
  closeToc();
  if (state.readerOpen) closeReader();
  state.focusPage = false;
  ui.focusBtn.setAttribute('aria-pressed', 'false');
  ui.dom2d.classList.remove('is-hidden');
  const view = viewForAspect(window.innerWidth / window.innerHeight, false);
  tweenCamera(view, 1.1);
  showCaption('VIEW RESET', 'عاد الكتاب إلى زاويته الافتتاحية. اسحب بحرية للاستكشاف.', 2800);
}

function toggleFocus() {
  stopDemo();
  state.focusPage = !state.focusPage;
  ui.focusBtn.setAttribute('aria-pressed', String(state.focusPage));
  ui.dom2d.classList.toggle('is-hidden', state.focusPage);
  const view = viewForAspect(window.innerWidth / window.innerHeight, state.focusPage);
  tweenCamera(view, 1.05);
  showCaption(
    state.focusPage ? 'READING VIEW' : 'SPREAD VIEW',
    state.focusPage ? 'تكبير صفحة القراءة. اضغط مرة أخرى للعودة إلى المشهد الكامل.' : 'عدنا إلى المشهد الكامل للكتاب.',
    2800
  );
}

/* --------------------------------------------------------------------------
   Page turns
   -------------------------------------------------------------------------- */
let flipBusy = false;

async function goToSpread(next) {
  if (flipBusy || state.flipping) return;
  const target = clamp(next, 0, SCHEMA.spreads.length - 1);
  if (target === state.idx) return;
  stopDemo();
  closeToc();
  closeFlap();

  if (state.reduced || !state.ready) {
    const old = state.idx;
    setSpread(target, { instant: true });
    if (old !== target) playUiSound('turn');
    return;
  }

  flipBusy = true;
  state.flipping = true;
  controls.enabled = false;
  document.body.classList.add('is-busy');
  playUiSound('turn');

  const oldIdx = state.idx;
  const forward = target > oldIdx;
  pageEl.style.transition = 'opacity .24s ease';
  pageEl.style.opacity = '0';
  pageEl.style.visibility = 'hidden';

  await foldSpread(oldIdx, false);

  sheetMaterial.map = plateTextures[oldIdx];
  sheetMaterial.needsUpdate = true;
  flipState.p = forward ? 0 : 1;
  applyFlipState();
  sheetPivot.visible = true;

  await new Promise((resolve) => {
    const duration = 1.12;
    const tl = gsap.timeline({ onComplete: resolve });
    tl.to(flipState, {
      p: forward ? 1 : 0,
      duration,
      ease: 'power2.inOut',
      onUpdate: applyFlipState
    }, 0.04);
    tl.call(() => {
      state.idx = target;
      const spread = SCHEMA.spreads[target];
      setAccent(spread.scene.accent);
      rightPageMat.map = plateTextures[target];
      rightPageMat.needsUpdate = true;
      renderPage(spread, target);
      ui.hudIndex.textContent = `${pad2(spread.n)} / ${pad2(SCHEMA.spreads.length)}`;
      ui.hudTitle.textContent = spread.title;
      ui.prevBtn.disabled = target === 0;
      ui.nextBtn.disabled = target === SCHEMA.spreads.length - 1;
      updateTocState();
      spreadGroups.forEach((entry, i) => {
        if (i !== target) {
          entry.group.visible = false;
          entry.recs.forEach((record) => { record.tag.visible = false; });
        }
      });
    }, null, 0.62);
  });

  sheetPivot.visible = false;
  pageEl.style.visibility = 'visible';
  pageEl.style.opacity = '1';
  popupSpread(target, false);
  controls.enabled = true;
  state.flipping = false;
  flipBusy = false;
  document.body.classList.remove('is-busy');
  gsap.delayedCall(0.12, () => {
    showCaption(
      `${SCHEMA.spreads[target].scene.figure} · ${SCHEMA.spreads[target].scene.title}`,
      SCHEMA.spreads[target].scene.hint,
      5200
    );
  });
}

/* --------------------------------------------------------------------------
   Picking, hover, click-versus-drag
   -------------------------------------------------------------------------- */
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
let pointerDown = null;
let lastHoverCheck = 0;

function recordAt(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  const entry = spreadGroups[state.idx];
  if (!entry) return null;
  const hits = raycaster.intersectObjects(entry.recs.map((record) => record.hit), false);
  return hits.length ? hits[0].object.userData.record || null : null;
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (state.demo !== 'idle') stopDemo();
  pointerDown = {
    x: event.clientX,
    y: event.clientY,
    time: performance.now(),
    id: event.pointerId
  };
});

renderer.domElement.addEventListener('pointerup', (event) => {
  if (!pointerDown || pointerDown.id !== event.pointerId) {
    pointerDown = null;
    return;
  }
  const dx = event.clientX - pointerDown.x;
  const dy = event.clientY - pointerDown.y;
  const dist = Math.hypot(dx, dy);
  const elapsed = performance.now() - pointerDown.time;
  pointerDown = null;
  if (state.flipping || state.demo !== 'idle') return;
  if (dist > 7 || elapsed > 750) return;
  const record = recordAt(event.clientX, event.clientY);
  if (record) activateObject(record);
});

renderer.domElement.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'touch' || pointerDown) return;
  const now = performance.now();
  if (now - lastHoverCheck < 55) return;
  lastHoverCheck = now;
  const record = recordAt(event.clientX, event.clientY);
  renderer.domElement.style.cursor = record ? 'pointer' : '';
});

renderer.domElement.addEventListener('pointerleave', () => {
  renderer.domElement.style.cursor = '';
});

controls.addEventListener('start', () => {
  if (state.demo !== 'idle') stopDemo();
});

/* Any interaction with the physical book ends a paused or playing demo. */
window.addEventListener('pointerdown', (event) => {
  if (state.demo === 'idle') return;
  const target = event.target;
  if (target && target.closest && target.closest('.hud, .topbar, .toc')) return;
  stopDemo();
}, true);

/* --------------------------------------------------------------------------
   Resize
   -------------------------------------------------------------------------- */
let lastPortrait = window.innerWidth / window.innerHeight < 0.85;

function onResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  composer.setSize(width, height);
  css3d.setSize(width, height);
  css2d.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  cssCamera.aspect = camera.aspect;
  cssCamera.updateProjectionMatrix();
  gradePass.uniforms.uResolution.value.set(width, height);

  const portrait = width / height < 0.85;
  if (portrait !== lastPortrait) {
    lastPortrait = portrait;
    if (!state.flipping && state.demo === 'idle') {
      tweenCamera(viewForAspect(width / height, state.focusPage), 0.6);
    }
  }
}

window.addEventListener('resize', onResize);

/* --------------------------------------------------------------------------
   Accessibility & theme controls
   -------------------------------------------------------------------------- */
let motionOverride = false;

function setReduced(reduced) {
  state.reduced = reduced;
  document.body.classList.toggle('reduced', reduced);
  ui.playBtn.disabled = reduced;
  ui.playBtn.title = reduced ? 'العرض الموجّه معطّل عند تقليل الحركة' : 'عرض موجّه';
  if (reduced) {
    stopDemo();
    dust.visible = false;
  } else {
    dust.visible = true;
  }
  syncMotionButton();
}

function toggleHighContrast() {
  state.hc = !state.hc;
  document.body.classList.toggle('hc', state.hc);
  syncContrastButton();
  playUiSound('click');
  announce(state.hc ? 'تم تشغيل التباين العالي.' : 'تم إيقاف التباين العالي.');
}

function toggleSound() {
  if (!state.sound) {
    const ctx = ensureAudio();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }
  state.sound = !state.sound;
  syncSoundButton();
  if (state.sound) playUiSound('click');
  announce(state.sound ? 'تم تشغيل الصوت.' : 'تم كتم الصوت.');
}

function toggleMotion() {
  motionOverride = true;
  setReduced(!state.reduced);
  announce(state.reduced ? 'تم تقليل الحركة.' : 'تم تشغيل الحركة الكاملة.');
}

/* --------------------------------------------------------------------------
   Keyboard
   -------------------------------------------------------------------------- */
window.addEventListener('keydown', (event) => {
  const target = event.target;
  const typing = target && target.closest && target.closest('button, input, textarea, select, [contenteditable="true"]');
  if (state.readerOpen) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeReader();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      readerGoTo(state.idx + 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      readerGoTo(state.idx - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      readerGoTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      readerGoTo(SCHEMA.spreads.length - 1);
    } else if (/^[1-5]$/.test(event.key)) {
      event.preventDefault();
      readerGoTo(Number(event.key) - 1);
    }
    return;
  }
  if (event.key === 'Escape') {
    if (ui.toc.classList.contains('is-open')) closeToc();
    else if (state.demo !== 'idle') stopDemo();
    return;
  }
  if (typing) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    goToSpread(state.idx + 1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    goToSpread(state.idx - 1);
  } else if (event.key === ' ' || event.code === 'Space') {
    event.preventDefault();
    toggleDemo();
  } else if (event.key === 'Home') {
    event.preventDefault();
    goToSpread(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    goToSpread(SCHEMA.spreads.length - 1);
  } else if (/^[1-5]$/.test(event.key)) {
    event.preventDefault();
    goToSpread(Number(event.key) - 1);
  }
});

/* --------------------------------------------------------------------------
   Animation loop
   -------------------------------------------------------------------------- */
const gradeTimeUniform = gradePass.uniforms.uTime;
let lastFrame = performance.now();
let elapsed = 0;

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
  lastFrame = now;
  elapsed += dt;

  if (!state.reduced) {
    const positions = dustGeo.attributes.position;
    for (let i = 0; i < dustCount; i++) {
      const seed = dustSeed[i];
      let x = positions.getX(i);
      let y = positions.getY(i);
      y += seed.speed * dt;
      x += Math.sin(elapsed * 0.18 + seed.phase) * 0.0009;
      if (y > 4.8) {
        y = 0.25 + Math.random() * 0.7;
        x = (Math.random() - 0.5) * 11;
      }
      positions.setX(i, x);
      positions.setY(i, y);
    }
    positions.needsUpdate = true;
    updateParticles(dt);
  }

  const entry = spreadGroups[state.idx];
  if (entry && entry.group.visible) {
    entry.recs.forEach((record) => record.update(dt, elapsed));
  }

  gradeTimeUniform.value = elapsed;
  controls.update();

  /* Keep the CSS3D page locked to the book's transform. */
  cssBook.position.copy(book.position).multiplyScalar(CSS3D_SCALE);
  cssBook.rotation.copy(book.rotation);
  cssBook.updateMatrixWorld(true);
  cssCamera.position.copy(camera.position).multiplyScalar(CSS3D_SCALE);
  cssCamera.quaternion.copy(camera.quaternion);
  cssCamera.fov = camera.fov;
  cssCamera.updateProjectionMatrix();
  cssCamera.updateMatrixWorld(true);

  composer.render();
  css3d.render(cssScene, cssCamera);
  css2d.render(scene, camera);
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */
buildToc();
setSpread(0, { instant: true });
syncPlayButton();
syncSoundButton();
syncContrastButton();
setReduced(reducedQuery.matches);
ui.focusBtn.setAttribute('aria-pressed', 'false');

window.__BOOK__ = {
  THREE, scene, camera, controls, renderer, book, cssScene, cssCamera, pageObject,
  state, viewForAspect, goToSpread, resetView, toggleFocus,
  openReader, closeReader, toggleReader, readerGoTo
};

const mediaListener = (event) => {
  if (!motionOverride) setReduced(event.matches);
};
if (reducedQuery.addEventListener) reducedQuery.addEventListener('change', mediaListener);
else if (reducedQuery.addListener) reducedQuery.addListener(mediaListener);

ui.tocBtn.addEventListener('click', toggleToc);
ui.tocClose.addEventListener('click', closeToc);
ui.prevBtn.addEventListener('click', () => goToSpread(state.idx - 1));
ui.nextBtn.addEventListener('click', () => goToSpread(state.idx + 1));
ui.playBtn.addEventListener('click', toggleDemo);
ui.soundBtn.addEventListener('click', toggleSound);
ui.contrastBtn.addEventListener('click', toggleHighContrast);
ui.motionBtn.addEventListener('click', toggleMotion);
ui.resetBtn.addEventListener('click', resetView);
ui.focusBtn.addEventListener('click', toggleReader);
ui.readerClose.addEventListener('click', closeReader);
ui.readerPrev.addEventListener('click', () => readerGoTo(state.idx - 1));
ui.readerNext.addEventListener('click', () => readerGoTo(state.idx + 1));
ui.reader.addEventListener('click', (event) => {
  if (event.target === ui.reader) closeReader();
});

window.addEventListener('pointerdown', (event) => {
  if (!ui.toc.classList.contains('is-open')) return;
  const target = event.target;
  if (target && target.closest && (target.closest('.toc') || target.closest('#tocBtn'))) return;
  closeToc();
});

const homeView = viewForAspect(window.innerWidth / window.innerHeight, false);
camera.position.copy(homeView.pos).add(new THREE.Vector3(0, 0.9, 2.7));
camera.fov = homeView.fov + 4;
camera.updateProjectionMatrix();
controls.target.copy(homeView.target);

requestAnimationFrame(animate);

window.setTimeout(() => {
  if (ui.splash) ui.splash.classList.add('is-done');
  state.ready = true;
  tweenCamera(viewForAspect(window.innerWidth / window.innerHeight, false), 1.7);
  popupSpread(0, false);
  const narrow = window.matchMedia('(max-width: 720px)').matches;
  showCaption(
    'FIELD BOOK · UNIT 02',
    narrow
      ? 'اضغط «قراءة» أعلى الشاشة لنسخة مكبّرة تناسب الهاتف، أو اسحب لتدوير الكتاب والمس النماذج.'
      : 'اسحب لتدوير الكتاب · استخدم العجلة للتكبير · المس النماذج المرفوعة، أو شغّل العرض الموجّه.',
    narrow ? 7800 : 6200
  );
  if (!state.reduced) {
    gsap.from(book.position, { y: -0.28, duration: 1.8, ease: 'power3.out' });
  }
}, 720);

