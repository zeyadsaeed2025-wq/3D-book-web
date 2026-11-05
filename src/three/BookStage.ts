import * as THREE from 'three';
import gsap from 'gsap';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { LessonSchema, LessonSpread, SceneObjectDef } from '../data/lessonSchema';
import { createProceduralTextures, seededRandom, type ProceduralTextures } from './textures';
import { createPopupLibrary, type BuiltPopup } from './popups';
import { ttsService } from '../services/ttsService';

export type DemoState = 'idle' | 'playing' | 'paused';

export interface BookStageCallbacks {
  onSpreadChange: (index: number) => void;
  onFlippingChange: (flipping: boolean) => void;
  onDemoStateChange: (demo: DemoState) => void;
  onFocusPageChange: (focus: boolean) => void;
  onCaption: (kicker: string, text: string, duration?: number, sticky?: boolean) => void;
  onHideCaption: () => void;
  onAnnounce: (text: string) => void;
  onObjectActivated: (spreadIndex: number, objectId: string, seenSet: Set<string>) => void;
  onReadableTextClick: (payload: { elementId: string; text: string; lang: 'ar' | 'en' | 'auto' }) => void;
}

interface ObjectRecord {
  def: SceneObjectDef;
  spread: LessonSpread;
  spreadIndex: number;
  indexInSpread: number;
  group: THREE.Group;
  tag: CSS2DObject;
  tagEl: HTMLButtonElement;
  hit: THREE.Mesh;
  tagY: number;
  activate: (instant?: boolean) => void;
  update: (dt: number, time: number) => void;
  active: boolean;
}

interface SpreadGroupEntry {
  group: THREE.Group;
  recs: ObjectRecord[];
}

const PAGE_W = 4.18;
const PAGE_H = 5.42;
const PAGE_CX = PAGE_W / 2;
const DOM_W = 640;
const DOM_H = 830;
const CSS3D_SCALE = DOM_W / PAGE_W;
const PAGE_SURFACE_Y = 0.328;
const PAGE_CSS_Y = 0.337;
const PAGE_POP_Y = 0.334;
const BOOK_W = PAGE_W * 2;
const SPREAD_FIT_W = BOOK_W + 0.9;

const clamp = THREE.MathUtils.clamp;
const deg = THREE.MathUtils.degToRad;
const pad2 = (n: number) => String(n).padStart(2, '0');

const _worldScratch = new THREE.Vector3();

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

export class BookStage {
  private readonly schema: LessonSchema;
  private readonly callbacks: BookStageCallbacks;
  private readonly viewportEl: HTMLElement;
  private readonly stageEl: HTMLElement;
  private readonly dom3dEl: HTMLElement;
  private readonly dom2dEl: HTMLElement;
  private readonly cssPageMountEl: HTMLDivElement;

  private readonly isSoftwareGl: boolean;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly gradePass: ShaderPass;
  private readonly css3d: CSS3DRenderer;
  private readonly css2d: CSS2DRenderer;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly cssScene: THREE.Scene;
  private readonly cssBook: THREE.Group;
  private readonly cssCamera: THREE.PerspectiveCamera;
  private readonly envRT: THREE.WebGLRenderTarget;
  private readonly textures: ProceduralTextures;
  private readonly popups: ReturnType<typeof createPopupLibrary>;
  private readonly plateTextures: THREE.CanvasTexture[];

  private readonly book = new THREE.Group();
  private readonly leftPageMat: THREE.MeshStandardMaterial;
  private readonly rightPageMat: THREE.MeshStandardMaterial;
  private readonly sheetPivot = new THREE.Group();
  private readonly sheetGeo: THREE.PlaneGeometry;
  private readonly sheetBasePositions: Float32Array;
  private readonly sheetMaterial: THREE.MeshStandardMaterial;
  private readonly flipState = { p: 0 };

  private readonly dustGeo: THREE.BufferGeometry;
  private readonly dustSeed: { speed: number; phase: number; amp: number }[] = [];
  private readonly dust: THREE.Points;
  private readonly dustCount = 110;

  private readonly MAX_PARTICLES = 420;
  private readonly particlePositions: Float32Array;
  private readonly particleColors: Float32Array;
  private readonly particleVelocities: Float32Array;
  private readonly particleLife: Float32Array;
  private readonly particleBase: Float32Array;
  private readonly particleGeo: THREE.BufferGeometry;
  private particleCursor = 0;
  private readonly flashLight: THREE.PointLight;

  private readonly spreadGroups: SpreadGroupEntry[] = [];
  private readonly seen: Set<string>[];
  private idx = 0;
  private reduced = false;
  private sound = true;
  private flipping = false;
  private demo: DemoState = 'idle';
  private focusPage = false;
  private ready = false;
  private contextLost = false;
  private destroyed = false;

  private cameraTweenToken = 0;
  private demoTimeline: gsap.core.Timeline | null = null;
  private audioCtx: AudioContext | null = null;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private pointerDown: {
    x: number;
    y: number;
    time: number;
    id: number;
    button: number;
    readableEl: HTMLElement | null;
    interruptedDemo: boolean;
  } | null = null;
  private lastHoverCheck = 0;
  private lastPortrait = window.innerWidth / window.innerHeight < 0.85;

  private frameId = 0;
  private afterDrawTimer = 0;
  private lastFrame = performance.now();
  private elapsed = 0;

  constructor(params: {
    schema: LessonSchema;
    viewportEl: HTMLElement;
    stageEl: HTMLElement;
    dom3dEl: HTMLElement;
    dom2dEl: HTMLElement;
    initialReduced: boolean;
    callbacks: BookStageCallbacks;
  }) {
    this.schema = params.schema;
    this.viewportEl = params.viewportEl;
    this.stageEl = params.stageEl;
    this.dom3dEl = params.dom3dEl;
    this.dom2dEl = params.dom2dEl;
    this.reduced = params.initialReduced;
    this.callbacks = params.callbacks;
    this.seen = this.schema.spreads.map(() => new Set<string>());

    this.isSoftwareGl = detectSoftwareWebGL();
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.stageEl.appendChild(this.renderer.domElement);

    this.css3d = new CSS3DRenderer({ element: this.dom3dEl });
    this.css3d.setSize(window.innerWidth, window.innerHeight);
    this.css2d = new CSS2DRenderer({ element: this.dom2dEl });
    this.css2d.setSize(window.innerWidth, window.innerHeight);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x17120e);
    this.scene.fog = new THREE.FogExp2(0x17120e, 0.0115);

    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envRT.texture;
    pmremGenerator.dispose();

    this.camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.1, 140);

    this.cssScene = new THREE.Scene();
    this.cssBook = new THREE.Group();
    this.cssScene.add(this.cssBook);
    this.cssCamera = new THREE.PerspectiveCamera(
      36,
      window.innerWidth / window.innerHeight,
      0.1 * CSS3D_SCALE,
      140 * CSS3D_SCALE,
    );

    const initialView = this.viewForAspect(window.innerWidth / window.innerHeight, false);
    this.camera.fov = initialView.fov;
    this.camera.position.copy(initialView.pos);
    this.camera.updateProjectionMatrix();

    // Attach OrbitControls to viewportEl so both 3D canvas drags and drags starting
    // over non-interactive CSS3D text smoothly orbit, pan, and pinch-zoom the book.
    this.controls = new OrbitControls(this.camera, this.viewportEl);
    this.controls.target.copy(initialView.target);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.52;
    this.controls.zoomSpeed = 0.85;
    this.controls.panSpeed = 0.65;
    this.controls.screenSpacePanning = true;
    this.controls.enablePan = true;
    this.controls.minDistance = 4.0;
    this.controls.maxDistance = 32;
    this.controls.minPolarAngle = 0.18;
    this.controls.maxPolarAngle = 1.18;
    this.controls.minAzimuthAngle = -0.85;
    this.controls.maxAzimuthAngle = 0.85;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.update();

    const PaperGradeShader = {
      uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        uAmount: { value: 0.018 },
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
      `,
    };

    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.gradePass = new ShaderPass(PaperGradeShader);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(new OutputPass());

    this.setupLighting();

    this.textures = createProceduralTextures(this.renderer.capabilities.getMaxAnisotropy());
    this.popups = createPopupLibrary({
      TEX: this.textures,
      maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy(),
    });

    this.leftPageMat = new THREE.MeshStandardMaterial({
      map: this.textures.paper,
      color: 0xf8eedb,
      roughness: 0.95,
      metalness: 0,
      bumpMap: this.textures.paper,
      bumpScale: 0.009,
    });
    this.rightPageMat = new THREE.MeshStandardMaterial({
      map: this.textures.paper,
      color: 0xf8eedb,
      roughness: 0.95,
      metalness: 0,
      bumpMap: this.textures.paper,
      bumpScale: 0.009,
    });

    this.setupDeskAndBook();

    this.plateTextures = this.schema.spreads.map((spread, i) => this.popups.makePlateTexture(spread, i));
    this.rightPageMat.map = this.plateTextures[0];
    this.rightPageMat.color.set(0xffffff);
    this.rightPageMat.needsUpdate = true;

    this.sheetPivot.position.set(0, PAGE_SURFACE_Y + 0.048, 0);
    this.sheetPivot.visible = false;
    this.book.add(this.sheetPivot);

    this.sheetGeo = new THREE.PlaneGeometry(PAGE_W, PAGE_H, 42, 1);
    this.sheetGeo.rotateX(-Math.PI / 2);
    this.sheetBasePositions = new Float32Array(this.sheetGeo.attributes.position.array);
    this.sheetMaterial = new THREE.MeshStandardMaterial({
      map: this.plateTextures[0],
      color: 0xfff8e8,
      roughness: 0.94,
      metalness: 0,
      side: THREE.DoubleSide,
      bumpMap: this.textures.paper,
      bumpScale: 0.007,
    });
    const turnSheet = new THREE.Mesh(this.sheetGeo, this.sheetMaterial);
    turnSheet.position.x = PAGE_CX;
    turnSheet.castShadow = true;
    turnSheet.receiveShadow = true;
    this.sheetPivot.add(turnSheet);

    // Mount container for CSS3D left-hand page
    this.cssPageMountEl = document.createElement('div');
    this.cssPageMountEl.style.width = `${DOM_W}px`;
    this.cssPageMountEl.style.height = `${DOM_H}px`;
    this.cssPageMountEl.style.pointerEvents = 'none';
    const pageObject = new CSS3DObject(this.cssPageMountEl);
    pageObject.rotation.x = -Math.PI / 2;
    pageObject.position.set(-PAGE_CX * CSS3D_SCALE, PAGE_CSS_Y * CSS3D_SCALE, 0);
    this.cssBook.add(pageObject);

    // Sunbeam dust motes
    this.dustGeo = new THREE.BufferGeometry();
    const dustPositions = new Float32Array(this.dustCount * 3);
    const rndDust = seededRandom(391);
    for (let i = 0; i < this.dustCount; i++) {
      dustPositions[i * 3] = (rndDust() - 0.5) * 12;
      dustPositions[i * 3 + 1] = 0.4 + rndDust() * 4.2;
      dustPositions[i * 3 + 2] = (rndDust() - 0.5) * 8;
      this.dustSeed.push({
        speed: 0.03 + rndDust() * 0.08,
        phase: rndDust() * Math.PI * 2,
        amp: 0.04 + rndDust() * 0.2,
      });
    }
    this.dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
    const dustMat = new THREE.PointsMaterial({
      size: 0.026,
      map: this.textures.dot,
      color: 0xffe6b7,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.dust = new THREE.Points(this.dustGeo, dustMat);
    this.dust.visible = !this.reduced;
    this.scene.add(this.dust);

    // Ink-and-light burst particles
    this.particlePositions = new Float32Array(this.MAX_PARTICLES * 3);
    this.particleColors = new Float32Array(this.MAX_PARTICLES * 3);
    this.particleVelocities = new Float32Array(this.MAX_PARTICLES * 3);
    this.particleLife = new Float32Array(this.MAX_PARTICLES);
    this.particleBase = new Float32Array(this.MAX_PARTICLES * 3);
    for (let i = 0; i < this.MAX_PARTICLES; i++) {
      this.particlePositions[i * 3 + 1] = -40;
    }
    this.particleGeo = new THREE.BufferGeometry();
    this.particleGeo.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
    this.particleGeo.setAttribute('color', new THREE.BufferAttribute(this.particleColors, 3));
    const particleMat = new THREE.PointsMaterial({
      size: 0.055,
      map: this.textures.dot,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const particles = new THREE.Points(this.particleGeo, particleMat);
    particles.frustumCulled = false;
    this.scene.add(particles);

    this.flashLight = new THREE.PointLight(0xffca82, 0, 8, 2);
    this.scene.add(this.flashLight);

    this.buildAllSpreads();
    this.bindEvents();

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.setSpread(0, { instant: true });
    this.runIntroCameraAndPopup();
    this.scheduleNextFrame();
  }

  getCssPageMount(): HTMLDivElement {
    return this.cssPageMountEl;
  }

  getSeenSets(): Set<string>[] {
    return this.seen;
  }

  setReduced(reduced: boolean) {
    this.reduced = reduced;
    this.dust.visible = !reduced;
    if (reduced) {
      // If a camera-driven demo is running, stop camera tweens immediately
      if (this.demoTimeline) {
        this.demoTimeline.kill();
        this.demoTimeline = null;
      }
      gsap.killTweensOf(this.camera.position);
      gsap.killTweensOf(this.controls.target);
      gsap.killTweensOf(this.camera);
      this.controls.enabled = !this.flipping;
      if (this.demo !== 'idle') {
        this.demo = 'idle';
        this.callbacks.onDemoStateChange('idle');
        this.callbacks.onHideCaption();
      }
    }
  }

  setSound(sound: boolean) {
    if (sound) {
      const ctx = this.ensureAudio();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    }
    this.sound = sound;
    if (sound) this.playUiSound('click');
  }

  playUiSound(kind: 'select' | 'reveal' | 'discover' | 'stamp' | 'turn' | 'click') {
    if (!this.sound) return;
    const ctx = this.ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    if (kind === 'select') {
      this.tone(520, 0.07, 'sine', 0.035);
    } else if (kind === 'reveal') {
      this.tone(392, 0.12, 'triangle', 0.04);
      this.tone(587, 0.18, 'triangle', 0.03, 0.06);
    } else if (kind === 'discover') {
      this.tone(330, 0.13, 'sine', 0.045);
      this.tone(494, 0.15, 'sine', 0.035, 0.07);
      this.tone(659, 0.2, 'sine', 0.025, 0.14);
    } else if (kind === 'stamp') {
      this.tone(116, 0.15, 'square', 0.03);
      this.tone(174, 0.2, 'triangle', 0.025, 0.02);
    } else if (kind === 'turn') {
      this.noise(0.34, 0.032);
      this.tone(180, 0.22, 'sine', 0.02);
    } else if (kind === 'click') {
      this.tone(740, 0.03, 'square', 0.018);
    }
  }

  resetView() {
    this.stopDemo();
    this.focusPage = false;
    this.callbacks.onFocusPageChange(false);
    this.dom2dEl.classList.remove('is-hidden');
    const view = this.viewForAspect(window.innerWidth / window.innerHeight, false);
    this.tweenCamera(view, 1.1);
    this.callbacks.onCaption('VIEW RESET', 'عاد الكتاب إلى زاويته الافتتاحية. اسحب بحرية للاستكشاف.', 2800);
  }

  toggleFocus() {
    this.stopDemo();
    this.focusPage = !this.focusPage;
    this.callbacks.onFocusPageChange(this.focusPage);
    this.dom2dEl.classList.toggle('is-hidden', this.focusPage);
    const view = this.viewForAspect(window.innerWidth / window.innerHeight, this.focusPage);
    this.tweenCamera(view, 1.05);
    this.callbacks.onCaption(
      this.focusPage ? 'READING VIEW' : 'SPREAD VIEW',
      this.focusPage
        ? 'تكبير صفحة القراءة. اضغط مرة أخرى للعودة إلى المشهد الكامل.'
        : 'عدنا إلى المشهد الكامل للكتاب.',
      2800,
    );
  }

  toggleDemo() {
    if (this.flipping) return;
    ttsService.unlockAudio();
    if (this.demo === 'playing' && this.demoTimeline) {
      this.demoTimeline.pause();
      this.demo = 'paused';
      this.callbacks.onDemoStateChange('paused');
      this.callbacks.onCaption('DEMO PAUSED', 'العرض متوقف مؤقتًا. اضغط متابعة أو اسحب الكتاب لإنهائه.', 3600);
      return;
    }
    if (this.demo === 'paused' && this.demoTimeline) {
      this.demo = 'playing';
      this.callbacks.onDemoStateChange('playing');
      this.callbacks.onHideCaption();
      this.demoTimeline.resume();
      return;
    }
    this.startDemo();
  }

  stopDemo() {
    if (this.demo === 'idle') return;
    if (this.demoTimeline) {
      this.demoTimeline.kill();
      this.demoTimeline = null;
    }
    gsap.killTweensOf(this.camera.position);
    gsap.killTweensOf(this.controls.target);
    gsap.killTweensOf(this.camera);
    this.clearDemoTagHighlights();
    this.demo = 'idle';
    this.controls.enabled = !this.flipping;
    this.callbacks.onDemoStateChange('idle');
    this.callbacks.onHideCaption();
  }

  async goToSpread(next: number, opts: { immediateFlip?: boolean } = {}): Promise<void> {
    if (this.flipping) return;
    const target = clamp(next, 0, this.schema.spreads.length - 1);
    if (target === this.idx) return;
    this.stopDemo();

    if (this.reduced || !this.ready || opts.immediateFlip) {
      const old = this.idx;
      this.setSpread(target, { instant: true });
      if (old !== target) this.playUiSound('turn');
      return;
    }

    this.flipping = true;
    this.callbacks.onFlippingChange(true);
    this.controls.enabled = false;
    document.body.classList.add('is-busy');
    this.playUiSound('turn');

    const oldIdx = this.idx;
    const forward = target > oldIdx;
    this.cssPageMountEl.style.transition = 'opacity .24s ease';
    this.cssPageMountEl.style.opacity = '0';
    this.cssPageMountEl.style.visibility = 'hidden';

    await this.foldSpread(oldIdx, false);

    this.sheetMaterial.map = this.plateTextures[oldIdx];
    this.sheetMaterial.needsUpdate = true;
    this.flipState.p = forward ? 0 : 1;
    this.applyFlipState();
    this.sheetPivot.visible = true;

    await new Promise<void>((resolve) => {
      const duration = 1.12;
      const tl = gsap.timeline({ onComplete: resolve });
      tl.to(
        this.flipState,
        {
          p: forward ? 1 : 0,
          duration,
          ease: 'power2.inOut',
          onUpdate: () => this.applyFlipState(),
        },
        0.04,
      );
      tl.call(
        () => {
          this.idx = target;
          const spread = this.schema.spreads[target];
          this.rightPageMat.map = this.plateTextures[target];
          this.rightPageMat.needsUpdate = true;
          this.callbacks.onSpreadChange(target);
          this.spreadGroups.forEach((entry, i) => {
            if (i !== target) {
              entry.group.visible = false;
              entry.recs.forEach((record) => {
                record.tag.visible = false;
              });
            }
          });
        },
        undefined,
        0.62,
      );
    });

    this.sheetPivot.visible = false;
    this.cssPageMountEl.style.visibility = 'visible';
    this.cssPageMountEl.style.opacity = '1';
    this.popupSpread(target, false);
    this.controls.enabled = true;
    this.flipping = false;
    this.callbacks.onFlippingChange(false);
    document.body.classList.remove('is-busy');

    gsap.delayedCall(0.12, () => {
      const sp = this.schema.spreads[target];
      this.callbacks.onCaption(`${sp.scene.figure} · ${sp.scene.title}`, sp.scene.hint, 5200);
    });
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frameId);
    window.clearTimeout(this.afterDrawTimer);
    if (this.demoTimeline) {
      this.demoTimeline.kill();
      this.demoTimeline = null;
    }
    gsap.killTweensOf(this.camera.position);
    gsap.killTweensOf(this.controls.target);
    gsap.killTweensOf(this.camera);
    gsap.killTweensOf(this.flashLight);
    gsap.killTweensOf(this.book.position);

    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pointerup', this.onWindowPointerUp);
    this.viewportEl.removeEventListener('pointerdown', this.onViewportPointerDownCapture, { capture: true });
    this.viewportEl.removeEventListener('pointermove', this.onViewportPointerMove);
    this.viewportEl.removeEventListener('pointerleave', this.onViewportPointerLeave);
    this.viewportEl.removeEventListener('wheel', this.onViewportWheel);
    this.controls.dispose();

    this.plateTextures.forEach((t) => t.dispose());
    this.popups.dispose();
    this.textures.dispose();
    this.dustGeo.dispose();
    this.particleGeo.dispose();
    this.sheetGeo.dispose();
    this.envRT.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Scene Setup                                                        */
  /* ------------------------------------------------------------------ */
  private setupLighting() {
    const hemi = new THREE.HemisphereLight(0xffe8c8, 0x2b2118, 0.92);
    this.scene.add(hemi);

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
    this.scene.add(key);
    this.scene.add(key.target);

    const fill = new THREE.DirectionalLight(0x93b6c9, 0.5);
    fill.position.set(6.2, 5.4, -3.6);
    this.scene.add(fill);

    const bounce = new THREE.PointLight(0xffa967, 5.5, 17, 2);
    bounce.position.set(-3.8, 2.1, 4.4);
    this.scene.add(bounce);

    const rim = new THREE.DirectionalLight(0xffe0b1, 0.36);
    rim.position.set(3.5, 3.8, -5.5);
    this.scene.add(rim);

    // Invisible blind slats casting striped window sunlight across the desk
    const blindMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const blind = new THREE.Group();
    for (let i = 0; i < 7; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(13, 0.12, 0.24), blindMat);
      slat.position.set(-2.2, 6.25, 1.0 + i * 0.52);
      slat.rotation.z = -0.18;
      slat.castShadow = true;
      blind.add(slat);
    }
    this.scene.add(blind);
  }

  private setupDeskAndBook() {
    const desk = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({
        map: this.textures.desk,
        color: 0xffffff,
        roughness: 0.96,
        metalness: 0.0,
      }),
    );
    desk.rotation.x = -Math.PI / 2;
    desk.position.y = 0;
    desk.receiveShadow = true;
    this.scene.add(desk);

    const contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(13.4, 9.4),
      new THREE.MeshBasicMaterial({
        map: this.textures.shadow,
        color: 0x080604,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.NormalBlending,
      }),
    );
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.set(0.15, 0.004, 0.35);
    this.scene.add(contactShadow);

    this.scene.add(this.book);

    const clothMat = new THREE.MeshStandardMaterial({
      map: this.textures.cloth,
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.02,
      bumpMap: this.textures.cloth,
      bumpScale: 0.018,
    });

    const coverMat = new THREE.MeshStandardMaterial({
      map: this.textures.cloth,
      color: 0xd2ad63,
      roughness: 0.8,
      metalness: 0.03,
      bumpMap: this.textures.cloth,
      bumpScale: 0.016,
    });

    const goldMat = new THREE.MeshStandardMaterial({
      color: 0xd8b56a,
      roughness: 0.28,
      metalness: 0.82,
    });

    const roundedRectShape = (w: number, h: number, r: number) => {
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
    };

    const makeCoverBoard = (side: -1 | 1) => {
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
        curveSegments: 8,
      });
      geo.rotateX(-Math.PI / 2);
      const board = new THREE.Mesh(geo, coverMat);
      board.position.set(side * 2.29, 0.012, 0);
      board.castShadow = true;
      board.receiveShadow = true;
      this.book.add(board);

      const inset = 0.075;
      const fw = w - inset * 2;
      const fh = h - inset * 2;
      const fr = Math.max(0.04, r - inset * 0.35);
      const points: THREE.Vector3[] = [];
      const segs = 8;
      const corners: [number, number, number][] = [
        [fw / 2 - fr, fh / 2 - fr, 0],
        [-fw / 2 + fr, fh / 2 - fr, Math.PI / 2],
        [-fw / 2 + fr, -fh / 2 + fr, Math.PI],
        [fw / 2 - fr, -fh / 2 + fr, Math.PI * 1.5],
      ];
      for (const [cx, cy, start] of corners) {
        for (let j = 0; j <= segs; j++) {
          const a = start + (j / segs) * (Math.PI / 2);
          points.push(new THREE.Vector3(cx + Math.cos(a) * fr, 0, cy + Math.sin(a) * fr));
        }
      }
      const foilGeo = new THREE.BufferGeometry().setFromPoints(points);
      const foil = new THREE.LineLoop(
        foilGeo,
        new THREE.LineBasicMaterial({ color: 0xd2ad63, transparent: true, opacity: 0.66 }),
      );
      foil.position.set(side * 2.29, 0.157, 0);
      this.book.add(foil);
    };

    makeCoverBoard(-1);
    makeCoverBoard(1);

    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.19, 5.78), clothMat);
    spine.position.set(0, 0.1, 0);
    spine.castShadow = true;
    spine.receiveShadow = true;
    this.book.add(spine);
    [-2.63, 2.63].forEach((z) => {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.204, 0.055), goldMat);
      band.position.set(0, 0.1, z);
      band.castShadow = true;
      this.book.add(band);
    });

    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 7; i++) {
        const slab = new THREE.Mesh(
          new THREE.BoxGeometry(PAGE_W - 0.006 - i * 0.002, 0.0224, PAGE_H - 0.006 - i * 0.002),
          new THREE.MeshStandardMaterial({
            color: i % 2 ? 0xe9dcc1 : 0xf1e6d0,
            roughness: 0.96,
            metalness: 0,
          }),
        );
        slab.position.set(side * PAGE_CX, 0.159 + i * 0.0224, 0);
        slab.castShadow = true;
        slab.receiveShadow = true;
        this.book.add(slab);
      }
    }

    const makePageGeometry = (side: 'left' | 'right') => {
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
    };

    const leftPage = new THREE.Mesh(makePageGeometry('left'), this.leftPageMat);
    leftPage.position.set(-PAGE_CX, PAGE_SURFACE_Y, 0);
    leftPage.receiveShadow = true;
    leftPage.castShadow = false;
    this.book.add(leftPage);

    const rightPage = new THREE.Mesh(makePageGeometry('right'), this.rightPageMat);
    rightPage.position.set(PAGE_CX, PAGE_SURFACE_Y, 0);
    rightPage.receiveShadow = true;
    rightPage.castShadow = false;
    this.book.add(rightPage);

    const gutter = new THREE.Mesh(
      new THREE.BoxGeometry(0.028, 0.025, PAGE_H - 0.08),
      new THREE.MeshStandardMaterial({ color: 0x6d5c44, roughness: 1 }),
    );
    gutter.position.set(0, PAGE_SURFACE_Y - 0.043, 0);
    this.book.add(gutter);

    // Blue fabric bookmark ribbon
    const ribbonGeometry = (points: THREE.Vector3[], width: number) => {
      const geo = new THREE.BufferGeometry();
      const vertices: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];
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
    };

    const ribbonPts = [
      new THREE.Vector3(0.18, PAGE_SURFACE_Y + 0.006, 2.36),
      new THREE.Vector3(0.19, PAGE_SURFACE_Y - 0.005, 2.58),
      new THREE.Vector3(0.22, 0.27, 2.82),
      new THREE.Vector3(0.28, 0.14, 3.04),
      new THREE.Vector3(0.33, 0.04, 3.3),
      new THREE.Vector3(0.35, 0.035, 3.58),
    ];
    const ribbon = new THREE.Mesh(
      ribbonGeometry(ribbonPts, 0.17),
      new THREE.MeshStandardMaterial({
        color: 0x1f4d79,
        roughness: 0.7,
        metalness: 0.02,
        side: THREE.DoubleSide,
      }),
    );
    ribbon.castShadow = true;
    ribbon.receiveShadow = true;
    this.book.add(ribbon);

    const ribbonEdge = new THREE.Mesh(
      ribbonGeometry(
        ribbonPts.map((p) => p.clone().add(new THREE.Vector3(0.078, 0.002, 0.01))),
        0.018,
      ),
      new THREE.MeshStandardMaterial({ color: 0x9ab0c9, roughness: 0.65, side: THREE.DoubleSide }),
    );
    this.book.add(ribbonEdge);

    // Desk props: field card + fountain pen
    const fieldCard = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 2.19),
      new THREE.MeshStandardMaterial({ map: this.textures.fieldCard, roughness: 0.94 }),
    );
    fieldCard.rotation.x = -Math.PI / 2;
    fieldCard.rotation.z = 0.14;
    fieldCard.position.set(-3.68, 0.012, -3.35);
    fieldCard.receiveShadow = true;
    fieldCard.castShadow = true;
    this.book.add(fieldCard);

    const pen = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.045, 2.9, 10),
      new THREE.MeshStandardMaterial({ color: 0x28342f, roughness: 0.4, metalness: 0.25 }),
    );
    body.rotation.z = Math.PI / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    pen.add(body);

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.062, 0.055, 0.9, 10),
      new THREE.MeshStandardMaterial({ color: 0x1c2623, roughness: 0.38, metalness: 0.3 }),
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
      new THREE.MeshStandardMaterial({ color: 0xc9a55f, roughness: 0.26, metalness: 0.8 }),
    );
    tip.rotation.z = -Math.PI / 2;
    tip.position.x = 1.62;
    tip.castShadow = true;
    pen.add(tip);

    pen.position.set(5.0, 0.09, 2.52);
    pen.rotation.y = 0.34;
    pen.rotation.z = 0.02;
    this.book.add(pen);
  }

  private buildAllSpreads() {
    this.schema.spreads.forEach((spread, si) => {
      const group = new THREE.Group();
      group.position.set(PAGE_CX, PAGE_POP_Y, 0);
      group.visible = false;
      this.book.add(group);
      const recs = spread.scene.objects.map((def, oi) => this.createPopup(def, spread, si, oi, group));
      this.spreadGroups.push({ group, recs });
    });
  }

  private createPopup(
    def: SceneObjectDef,
    spread: LessonSpread,
    spreadIndex: number,
    indexInSpread: number,
    parent: THREE.Group,
  ): ObjectRecord {
    const built: BuiltPopup = this.popups.buildPopup(def, spread);
    built.group.position.set(def.pos[0], 0, def.pos[1]);
    parent.add(built.group);

    const tagEl = document.createElement('button');
    tagEl.type = 'button';
    tagEl.className = 'obj-tag';
    tagEl.setAttribute('aria-pressed', 'false');
    tagEl.setAttribute('aria-label', `اكتشف ${def.label}`);
    tagEl.innerHTML = `<span class="obj-num">${pad2(indexInSpread + 1)}</span><span class="obj-name">${def.label}</span>`;

    tagEl.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });
    tagEl.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.flipping) return;
      if (this.demo !== 'idle') this.stopDemo();
      this.activateObject(record);
    });

    const tag = new CSS2DObject(tagEl);
    tag.position.set(0, built.tagY, 0);
    tag.center.set(0.5, 1);
    tag.visible = false;
    built.group.add(tag);

    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(def.hit[0], def.hit[1], def.hit[2]),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.y = def.hit[1] / 2 + 0.02;
    built.group.add(hit);

    const record: ObjectRecord = {
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
      update: built.update,
      active: false,
    };
    hit.userData.record = record;
    return record;
  }

  /* ------------------------------------------------------------------ */
  /* Spread Swapping & Pop-up Spring Physics (`scale.y` 0.01 -> 1.0)    */
  /* ------------------------------------------------------------------ */
  setSpread(si: number, { instant = false, animatePopups = true } = {}) {
    const safe = clamp(si, 0, this.schema.spreads.length - 1);
    this.spreadGroups.forEach((entry, i) => {
      if (i !== safe) {
        entry.group.visible = false;
        entry.recs.forEach((record) => {
          record.tag.visible = false;
        });
      }
    });
    this.idx = safe;
    const spread = this.schema.spreads[safe];
    this.rightPageMat.map = this.plateTextures[safe];
    this.rightPageMat.needsUpdate = true;
    this.callbacks.onSpreadChange(safe);
    this.popupSpread(safe, instant || !animatePopups || this.reduced);
  }

  private popupSpread(si: number, instant = false) {
    const entry = this.spreadGroups[si];
    if (!entry) return;
    entry.group.visible = true;
    entry.recs.forEach((record, i) => {
      gsap.killTweensOf(record.group.rotation);
      gsap.killTweensOf(record.group.scale);
      record.tag.visible = false;
      if (instant || this.reduced) {
        record.group.rotation.x = 0;
        record.group.scale.set(1, 1, 1);
        record.tag.visible = true;
      } else {
        record.group.rotation.x = -1.26;
        record.group.scale.set(0.92, 0.01, 0.92);
        gsap.to(record.group.scale, {
          x: 1,
          y: 1,
          z: 1,
          duration: 0.82,
          delay: i * 0.1,
          ease: 'elastic.out(1, 0.6)',
        });
        gsap.to(record.group.rotation, {
          x: 0,
          duration: 0.72,
          delay: i * 0.1,
          ease: 'back.out(1.28)',
        });
        gsap.delayedCall(0.56 + i * 0.1, () => {
          if (!this.destroyed && this.spreadGroups[this.idx] === entry) {
            record.tag.visible = true;
          }
        });
      }
      const seen = this.seen[si].has(record.def.id);
      record.tagEl.classList.toggle('is-active', seen);
      record.tagEl.setAttribute('aria-pressed', String(seen));
      record.active = seen;
      if (seen) record.activate(true);
    });
  }

  private foldSpread(si: number, instant = false): Promise<void> {
    const entry = this.spreadGroups[si];
    if (!entry) return Promise.resolve();
    entry.recs.forEach((record) => {
      record.tag.visible = false;
    });
    if (instant || this.reduced) {
      entry.recs.forEach((record) => {
        record.group.rotation.x = -1.32;
        record.group.scale.set(0.92, 0.01, 0.92);
      });
      entry.group.visible = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const tl = gsap.timeline({
        onComplete: () => {
          entry.group.visible = false;
          resolve();
        },
      });
      entry.recs.forEach((record, i) => {
        tl.to(
          record.group.rotation,
          { x: -1.36, duration: 0.38, ease: 'power2.in' },
          i * 0.035,
        );
        tl.to(
          record.group.scale,
          { x: 0.92, y: 0.01, z: 0.92, duration: 0.36, ease: 'power2.in' },
          i * 0.035,
        );
      });
    });
  }

  private bendTurnSheet(amount: number) {
    const positions = this.sheetGeo.attributes.position;
    const count = positions.count;
    for (let i = 0; i < count; i++) {
      const x = this.sheetBasePositions[i * 3];
      const y = this.sheetBasePositions[i * 3 + 1];
      const z = this.sheetBasePositions[i * 3 + 2];
      const u = clamp((x + PAGE_W / 2) / PAGE_W, 0, 1);
      positions.setXYZ(i, x, y + Math.sin(u * Math.PI) * amount, z);
    }
    positions.needsUpdate = true;
    this.sheetGeo.computeVertexNormals();
  }

  private applyFlipState() {
    this.sheetPivot.rotation.z = this.flipState.p * Math.PI;
    const bulge = Math.sin(Math.PI * clamp(this.flipState.p, 0, 1)) * 0.26;
    this.bendTurnSheet(bulge);
  }

  /* ------------------------------------------------------------------ */
  /* Object Activation, Particles & Light Flashes                         */
  /* ------------------------------------------------------------------ */
  activateObject(record: ObjectRecord, { instant = false, silent = false } = {}) {
    if (this.flipping) return;
    const spreadIndex = record.spreadIndex;
    const wasComplete = this.seen[spreadIndex].size === 3;
    const first = !this.seen[spreadIndex].has(record.def.id);
    this.seen[spreadIndex].add(record.def.id);
    record.active = true;
    record.activate(instant);
    record.tagEl.classList.add('is-active');
    record.tagEl.setAttribute('aria-pressed', 'true');
    this.callbacks.onObjectActivated(spreadIndex, record.def.id, new Set(this.seen[spreadIndex]));

    record.group.getWorldPosition(_worldScratch);
    _worldScratch.y += Math.min(1.1, 0.5 + record.indexInSpread * 0.02);

    if (!instant && !this.reduced) {
      this.spawnBurst(_worldScratch, record.spread.scene.accent, first ? 46 : 26);
      this.flashAt(_worldScratch, record.spread.scene.accent);
    }
    if (!instant) {
      this.playUiSound(first ? 'discover' : 'select');
    }

    if (!silent) {
      this.callbacks.onCaption(
        `${record.spread.scene.figure} · ${pad2(record.indexInSpread + 1)} / 03`,
        `${record.def.label} — ${record.def.caption}`,
        4800,
      );
      this.callbacks.onAnnounce(`${record.def.label}. ${record.def.caption}`);
      if (!instant) {
        void ttsService.speak(`${record.def.label} — ${record.def.caption}`, {
          elementId: `obj-${record.def.id}`,
          lang: 'ar',
          autoEnable: false,
        });
      }
    }

    if (!wasComplete && this.seen[spreadIndex].size === 3) {
      window.setTimeout(() => {
        if (this.destroyed || this.idx !== spreadIndex) return;
        this.callbacks.onCaption(
          'FIELD REVIEW',
          'اكتملت جولة الصفحة: استكشفت العناصر الثلاثة وتُختم الورقة الآن.',
          5200,
        );
        this.playUiSound('stamp');
      }, 420);
    }
  }

  private spawnBurst(worldPosition: THREE.Vector3, hex: string, count = 34) {
    if (this.reduced) return;
    const color = new THREE.Color(hex);
    for (let n = 0; n < count; n++) {
      const i = this.particleCursor % this.MAX_PARTICLES;
      this.particleCursor++;
      const angle = Math.random() * Math.PI * 2;
      const radius = 0.25 + Math.random() * 0.9;
      const lift = 0.4 + Math.random() * 1.5;
      this.particlePositions[i * 3] = worldPosition.x + Math.cos(angle) * 0.12;
      this.particlePositions[i * 3 + 1] = worldPosition.y + Math.random() * 0.25;
      this.particlePositions[i * 3 + 2] = worldPosition.z + Math.sin(angle) * 0.12;
      this.particleVelocities[i * 3] = Math.cos(angle) * radius;
      this.particleVelocities[i * 3 + 1] = lift;
      this.particleVelocities[i * 3 + 2] = Math.sin(angle) * radius;
      this.particleLife[i] = 0.9 + Math.random() * 0.7;
      const warm = color.clone().lerp(new THREE.Color(0xfff1c9), Math.random() * 0.55);
      this.particleBase[i * 3] = warm.r;
      this.particleBase[i * 3 + 1] = warm.g;
      this.particleBase[i * 3 + 2] = warm.b;
      this.particleColors[i * 3] = warm.r;
      this.particleColors[i * 3 + 1] = warm.g;
      this.particleColors[i * 3 + 2] = warm.b;
    }
    this.particleGeo.attributes.position.needsUpdate = true;
    this.particleGeo.attributes.color.needsUpdate = true;
  }

  private updateParticles(dt: number) {
    let touched = false;
    for (let i = 0; i < this.MAX_PARTICLES; i++) {
      if (this.particleLife[i] <= 0) continue;
      touched = true;
      this.particleLife[i] -= dt;
      if (this.particleLife[i] <= 0) {
        this.particlePositions[i * 3 + 1] = -40;
        this.particleColors[i * 3] = 0;
        this.particleColors[i * 3 + 1] = 0;
        this.particleColors[i * 3 + 2] = 0;
        continue;
      }
      this.particleVelocities[i * 3 + 1] -= 1.35 * dt;
      this.particlePositions[i * 3] += this.particleVelocities[i * 3] * dt;
      this.particlePositions[i * 3 + 1] += this.particleVelocities[i * 3 + 1] * dt;
      this.particlePositions[i * 3 + 2] += this.particleVelocities[i * 3 + 2] * dt;
      const fade = clamp(this.particleLife[i] / 1.1, 0, 1);
      this.particleColors[i * 3] = this.particleBase[i * 3] * fade;
      this.particleColors[i * 3 + 1] = this.particleBase[i * 3 + 1] * fade;
      this.particleColors[i * 3 + 2] = this.particleBase[i * 3 + 2] * fade;
    }
    if (touched) {
      this.particleGeo.attributes.position.needsUpdate = true;
      this.particleGeo.attributes.color.needsUpdate = true;
    }
  }

  private flashAt(worldPosition: THREE.Vector3, hex: string) {
    if (this.reduced) return;
    this.flashLight.color.set(hex);
    this.flashLight.position.copy(worldPosition);
    gsap.killTweensOf(this.flashLight);
    gsap.fromTo(
      this.flashLight,
      { intensity: 0 },
      {
        intensity: 9,
        duration: 0.22,
        ease: 'power2.out',
        onComplete: () => {
          gsap.to(this.flashLight, { intensity: 0, duration: 0.8, ease: 'power2.in' });
        },
      },
    );
  }

  /* ------------------------------------------------------------------ */
  /* Camera Choreography & Guided Demo                                  */
  /* ------------------------------------------------------------------ */
  private viewForAspect(aspect: number, focus = false) {
    if (focus) {
      const fov = 44;
      const pitch = deg(56);
      const dist = 9.2;
      const target = new THREE.Vector3(-PAGE_CX, 0.3, 0.02);
      return {
        fov,
        dist,
        target,
        pos: target.clone().add(new THREE.Vector3(0, Math.sin(pitch) * dist, Math.cos(pitch) * dist)),
      };
    }
    if (aspect < 0.85) {
      const fov = 44;
      const pitch = deg(56);
      const need = SPREAD_FIT_W * 1.05;
      const dist = clamp((need / 2) / (Math.tan(deg(fov / 2)) * aspect), 15, 32);
      return {
        fov,
        dist,
        target: new THREE.Vector3(0.02, 0.22, 0.08),
        pos: new THREE.Vector3(0.12, Math.sin(pitch) * dist, Math.cos(pitch) * dist),
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
      pos: new THREE.Vector3(0.34, Math.sin(pitch) * dist, Math.cos(pitch) * dist),
    };
  }

  private tweenCamera(
    view: { fov: number; target: THREE.Vector3; pos: THREE.Vector3 },
    duration = 1.05,
  ) {
    const token = ++this.cameraTweenToken;
    gsap.killTweensOf(this.camera.position);
    gsap.killTweensOf(this.controls.target);
    gsap.killTweensOf(this.camera);

    // When Reduced Motion is active, snap immediately without automatic camera travel
    if (this.reduced) {
      this.camera.position.copy(view.pos);
      this.controls.target.copy(view.target);
      this.camera.fov = view.fov;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      return;
    }

    gsap.to(this.camera.position, {
      x: view.pos.x,
      y: view.pos.y,
      z: view.pos.z,
      duration,
      ease: 'power3.inOut',
    });
    gsap.to(this.controls.target, {
      x: view.target.x,
      y: view.target.y,
      z: view.target.z,
      duration,
      ease: 'power3.inOut',
    });
    gsap.to(this.camera, {
      fov: view.fov,
      duration,
      ease: 'power2.inOut',
      onUpdate: () => {
        if (token === this.cameraTweenToken) this.camera.updateProjectionMatrix();
      },
    });
  }

  private objectView(record: ObjectRecord) {
    const world = new THREE.Vector3();
    record.group.getWorldPosition(world);
    world.y += Math.min(0.9, record.tagY * 0.38);
    const target = world.clone();
    const offset = new THREE.Vector3(0.45, 2.95, 5.2);
    return {
      fov: 40,
      target,
      pos: target.clone().add(offset),
    };
  }

  private clearDemoTagHighlights() {
    this.spreadGroups.forEach((entry) => {
      entry.recs.forEach((r) => r.tagEl.classList.remove('is-demo-focus'));
    });
  }

  private startDemo() {
    if (this.flipping) return;
    this.demo = 'playing';
    this.callbacks.onDemoStateChange('playing');
    this.callbacks.onHideCaption();
    this.clearDemoTagHighlights();

    const spread = this.schema.spreads[this.idx];
    const entry = this.spreadGroups[this.idx];
    if (!entry) return;

    // When Reduced Motion is enabled, do NOT move the camera automatically;
    // keep manual camera control available and highlight/focus each object sequentially.
    if (this.reduced) {
      this.controls.enabled = true;
      const tl = gsap.timeline({
        onComplete: () => this.finishDemo(),
      });
      this.demoTimeline = tl;

      tl.call(() => {
        this.callbacks.onCaption(
          'WATCH DEMO',
          `تركيز متتابع داخل «${spread.scene.title}» دون تحريك الكاميرا.`,
          4600,
          true,
        );
      }, undefined, 0);

      entry.recs.forEach((record, i) => {
        const at = 0.6 + i * 2.8;
        tl.call(() => {
          this.clearDemoTagHighlights();
          record.tagEl.classList.add('is-demo-focus');
          this.callbacks.onCaption(
            `${spread.scene.figure} · ${pad2(i + 1)} / 03`,
            `${record.def.label} — ${record.def.caption}`,
            5500,
            true,
          );
          this.activateObject(record, { instant: true, silent: true });
          void ttsService.speak(`${record.def.label} — ${record.def.caption}`, {
            elementId: `obj-${record.def.id}`,
            lang: 'ar',
            autoEnable: false,
          });
        }, undefined, at);
      });

      const endAt = 0.6 + entry.recs.length * 2.8 + 1.8;
      tl.call(() => {
        this.clearDemoTagHighlights();
        this.callbacks.onHideCaption();
      }, undefined, endAt);
      return;
    }

    // Full camera choreography: disable manual controls while camera glides between close-ups
    this.controls.enabled = false;
    const base = this.viewForAspect(window.innerWidth / window.innerHeight, false);
    const tl = gsap.timeline({
      onComplete: () => this.finishDemo(),
      onUpdate: () => this.camera.updateProjectionMatrix(),
    });
    this.demoTimeline = tl;

    tl.call(() => {
      this.callbacks.onCaption(
        'WATCH DEMO',
        `جولة موجّهة داخل «${spread.scene.title}» — راقب النماذج وهي تنهض.`,
        4600,
        true,
      );
    });
    tl.to(
      this.camera.position,
      { x: base.pos.x, y: base.pos.y, z: base.pos.z, duration: 0.9, ease: 'power2.inOut' },
      0,
    );
    tl.to(
      this.controls.target,
      { x: base.target.x, y: base.target.y, z: base.target.z, duration: 0.9, ease: 'power2.inOut' },
      0,
    );
    tl.to(this.camera, { fov: base.fov, duration: 0.9 }, 0);
    tl.to({}, { duration: 1.1 });

    entry.recs.forEach((record, i) => {
      const at = 1.9 + i * 3.1;
      const view = this.objectView(record);
      tl.to(
        this.camera.position,
        { x: view.pos.x, y: view.pos.y, z: view.pos.z, duration: 1.25, ease: 'power2.inOut' },
        at,
      );
      tl.to(
        this.controls.target,
        { x: view.target.x, y: view.target.y, z: view.target.z, duration: 1.25, ease: 'power2.inOut' },
        at,
      );
      tl.to(this.camera, { fov: view.fov, duration: 1.25 }, at);
      tl.call(
        () => {
          this.clearDemoTagHighlights();
          record.tagEl.classList.add('is-demo-focus');
          this.callbacks.onCaption(
            `${spread.scene.figure} · ${pad2(i + 1)} / 03`,
            `${record.def.label} — ${record.def.caption}`,
            6000,
            true,
          );
          this.activateObject(record, { silent: true });
          void ttsService.speak(`${record.def.label} — ${record.def.caption}`, {
            elementId: `obj-${record.def.id}`,
            lang: 'ar',
            autoEnable: false,
          });
        },
        undefined,
        at + 1.05,
      );
      tl.to({}, { duration: 1.8 }, at + 1.05);
    });

    const endAt = 1.9 + entry.recs.length * 3.1 + 0.1;
    tl.to(
      this.camera.position,
      { x: base.pos.x, y: base.pos.y, z: base.pos.z, duration: 1.3, ease: 'power3.inOut' },
      endAt,
    );
    tl.to(
      this.controls.target,
      { x: base.target.x, y: base.target.y, z: base.target.z, duration: 1.3, ease: 'power3.inOut' },
      endAt,
    );
    tl.to(this.camera, { fov: base.fov, duration: 1.3 }, endAt);
    tl.call(
      () => {
        this.clearDemoTagHighlights();
        this.callbacks.onHideCaption();
      },
      undefined,
      endAt + 1.25,
    );
  }

  private finishDemo() {
    this.clearDemoTagHighlights();
    this.demo = 'idle';
    this.demoTimeline = null;
    this.controls.enabled = !this.flipping;
    this.callbacks.onDemoStateChange('idle');
    this.callbacks.onHideCaption();
  }

  private runIntroCameraAndPopup() {
    const homeView = this.viewForAspect(window.innerWidth / window.innerHeight, false);
    if (this.reduced) {
      this.ready = true;
      this.camera.position.copy(homeView.pos);
      this.controls.target.copy(homeView.target);
      this.camera.fov = homeView.fov;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.popupSpread(0, true);
      this.callbacks.onCaption(
        'FIELD BOOK · UNIT 02',
        'اسحب لتدوير الكتاب · استخدم العجلة للتكبير · المس النماذج المرفوعة أو اضغط أي نص لقراءته.',
        6200,
      );
      return;
    }

    this.camera.position.copy(homeView.pos).add(new THREE.Vector3(0, 0.9, 2.7));
    this.camera.fov = homeView.fov + 4;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(homeView.target);

    window.setTimeout(() => {
      if (this.destroyed) return;
      this.ready = true;
      this.tweenCamera(this.viewForAspect(window.innerWidth / window.innerHeight, false), 1.7);
      this.popupSpread(0, false);
      const narrow = window.matchMedia('(max-width: 720px)').matches;
      this.callbacks.onCaption(
        'FIELD BOOK · UNIT 02',
        narrow
          ? 'اضغط «قراءة» أعلى الشاشة لنسخة مكبّرة تناسب الهاتف، أو اسحب لتدوير الكتاب والمس النماذج.'
          : 'اسحب لتدوير الكتاب · استخدم العجلة للتكبير · المس النماذج المرفوعة أو اضغط أي نص لقراءته.',
        narrow ? 7800 : 6200,
      );
      if (!this.reduced) {
        gsap.from(this.book.position, { y: -0.28, duration: 1.8, ease: 'power3.out' });
      }
    }, 520);
  }

  /* ------------------------------------------------------------------ */
  /* Interaction, Raycasting, Bounds Clamping                           */
  /* ------------------------------------------------------------------ */
  private recordAt(clientX: number, clientY: number): ObjectRecord | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const entry = this.spreadGroups[this.idx];
    if (!entry) return null;
    const hits = this.raycaster.intersectObjects(
      entry.recs.map((record) => record.hit),
      false,
    );
    return hits.length ? (hits[0].object.userData.record as ObjectRecord) || null : null;
  }

  private readonly onViewportPointerDownCapture = (event: PointerEvent) => {
    ttsService.unlockAudio();
    const ctx = this.ensureAudio();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const targetEl = event.target as HTMLElement | null;
    const isInteractiveWidget = Boolean(
      targetEl &&
        targetEl.closest('.obj-tag, .opt, .flap-cover, .flap-close, .self-assess-btn'),
    );
    if (isInteractiveWidget) return;

    let interruptedDemo = false;
    if (this.demo !== 'idle' && !this.flipping) {
      // Stop guided camera choreography immediately and return control so the current drag orbits right away
      this.stopDemo();
      interruptedDemo = true;
    }

    let readableEl = targetEl ? (targetEl.closest('.tts-readable') as HTMLElement | null) : null;
    if (!readableEl && targetEl?.closest('.paper-page')) {
      const container = targetEl.closest(
        '.block-head, .principle-box, .term, .quiz, .flap-answer, .margin-note, .stamp, .folio-wrap',
      );
      readableEl = (container?.querySelector('.tts-readable') as HTMLElement | null) ?? null;
    }

    this.pointerDown = {
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
      id: event.pointerId,
      button: event.button,
      readableEl,
      interruptedDemo,
    };
  };

  private readonly onWindowPointerUp = (event: PointerEvent) => {
    if (!this.pointerDown || this.pointerDown.id !== event.pointerId) {
      return;
    }
    const down = this.pointerDown;
    this.pointerDown = null;

    const dx = event.clientX - down.x;
    const dy = event.clientY - down.y;
    const dist = Math.hypot(dx, dy);
    const elapsed = performance.now() - down.time;

    if (this.flipping || this.demo !== 'idle') return;
    const maxDist = down.readableEl ? 18 : 9;
    const maxElapsed = down.readableEl ? 1400 : 850;
    if (down.button !== 0 || dist > maxDist || elapsed > maxElapsed) return;

    // 1. Check if the click was on a readable text line/element in the CSS3D book page
    if (down.readableEl) {
      const elementId = down.readableEl.getAttribute('data-tts-id') || '';
      const text =
        down.readableEl.getAttribute('data-tts-text') ||
        down.readableEl.textContent?.trim() ||
        '';
      const langAttr = down.readableEl.getAttribute('data-tts-lang');
      const lang: 'ar' | 'en' | 'auto' =
        langAttr === 'ar' || langAttr === 'en' ? langAttr : 'auto';
      if (text) {
        this.callbacks.onReadableTextClick({ elementId, text, lang });
      }
      return;
    }

    // 2. Otherwise check 3D pop-up raycast hitboxes on the right page
    const record = this.recordAt(event.clientX, event.clientY);
    if (record) {
      this.activateObject(record);
    }
  };

  private readonly onViewportPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || this.pointerDown) return;
    const now = performance.now();
    if (now - this.lastHoverCheck < 55) return;
    this.lastHoverCheck = now;

    const targetEl = event.target as HTMLElement | null;
    if (targetEl?.closest('.tts-readable, .obj-tag, .opt, .flap-cover, .flap-close')) {
      this.viewportEl.style.cursor = 'pointer';
      return;
    }
    const record = this.recordAt(event.clientX, event.clientY);
    this.viewportEl.style.cursor = record ? 'pointer' : 'grab';
  };

  private readonly onViewportPointerLeave = () => {
    this.viewportEl.style.cursor = '';
  };

  private readonly onViewportWheel = () => {
    if (this.demo !== 'idle' && !this.flipping && !this.reduced) {
      this.stopDemo();
    }
  };

  private readonly onResize = () => {
    if (this.destroyed) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const pixelRatio = this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.css3d.setSize(width, height);
    this.css2d.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.cssCamera.aspect = this.camera.aspect;
    this.cssCamera.updateProjectionMatrix();
    this.gradePass.uniforms.uResolution.value.set(width, height);

    const portrait = width / height < 0.85;
    if (portrait !== this.lastPortrait) {
      this.lastPortrait = portrait;
      if (!this.flipping && this.demo === 'idle') {
        this.tweenCamera(this.viewForAspect(width / height, this.focusPage), 0.6);
      }
    }
  };

  private bindEvents() {
    this.viewportEl.addEventListener('pointerdown', this.onViewportPointerDownCapture, { capture: true });
    window.addEventListener('pointerup', this.onWindowPointerUp);
    this.viewportEl.addEventListener('pointermove', this.onViewportPointerMove);
    this.viewportEl.addEventListener('pointerleave', this.onViewportPointerLeave);
    this.viewportEl.addEventListener('wheel', this.onViewportWheel, { passive: true });
    window.addEventListener('resize', this.onResize);

    // Prevent panning or zooming below the desk or clipping through the book
    this.controls.addEventListener('change', () => {
      this.controls.target.x = clamp(this.controls.target.x, -4.4, 4.4);
      this.controls.target.y = clamp(this.controls.target.y, 0.18, 2.2);
      this.controls.target.z = clamp(this.controls.target.z, -3.2, 3.2);
      if (this.camera.position.y < 1.35) {
        this.camera.position.y = 1.35;
      }
    });

    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      if (!this.isSoftwareGl) {
        this.renderer.compile(this.scene, this.camera);
      }
      this.scheduleNextFrame();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Render Loop (with Software-WebGL GPU Fence Pacing)                 */
  /* ------------------------------------------------------------------ */
  private afterDraw(cb: () => void) {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = typeof gl.fenceSync === 'function' ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
    gl.flush();
    if (!sync) {
      this.afterDrawTimer = window.setTimeout(cb, 80);
      return;
    }
    const poll = () => {
      if (this.destroyed) {
        gl.deleteSync(sync);
        return;
      }
      const syncState = gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (syncState === gl.UNSIGNALED) {
        this.afterDrawTimer = window.setTimeout(poll, 5);
      } else {
        gl.deleteSync(sync);
        this.afterDrawTimer = window.setTimeout(cb, 80);
      }
    };
    this.afterDrawTimer = window.setTimeout(poll, 5);
  }

  private scheduleNextFrame() {
    if (this.destroyed || this.contextLost) return;
    if (this.isSoftwareGl) {
      this.afterDraw(() => this.tick());
    } else {
      this.frameId = requestAnimationFrame(() => this.tick());
    }
  }

  private tick() {
    if (this.destroyed || this.contextLost) return;
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.elapsed += dt;

    if (!this.reduced) {
      const positions = this.dustGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < this.dustCount; i++) {
        const seed = this.dustSeed[i];
        let x = positions.getX(i);
        let y = positions.getY(i);
        y += seed.speed * dt;
        x += Math.sin(this.elapsed * 0.18 + seed.phase) * 0.0009;
        if (y > 4.8) {
          y = 0.25 + Math.random() * 0.7;
          x = (Math.random() - 0.5) * 11;
        }
        positions.setX(i, x);
        positions.setY(i, y);
      }
      positions.needsUpdate = true;
      this.updateParticles(dt);
    }

    const entry = this.spreadGroups[this.idx];
    if (entry && entry.group.visible) {
      entry.recs.forEach((record) => record.update(dt, this.elapsed));
    }

    this.gradePass.uniforms.uTime.value = this.elapsed;
    this.controls.update();

    this.cssBook.position.copy(this.book.position).multiplyScalar(CSS3D_SCALE);
    this.cssBook.rotation.copy(this.book.rotation);
    this.cssBook.updateMatrixWorld(true);
    this.cssCamera.position.copy(this.camera.position).multiplyScalar(CSS3D_SCALE);
    this.cssCamera.quaternion.copy(this.camera.quaternion);
    this.cssCamera.fov = this.camera.fov;
    this.cssCamera.updateProjectionMatrix();
    this.cssCamera.updateMatrixWorld(true);

    if (this.isSoftwareGl) {
      this.renderer.render(this.scene, this.camera);
    } else {
      this.composer.render();
    }
    this.css3d.render(this.cssScene, this.cssCamera);
    this.css2d.render(this.scene, this.camera);

    this.scheduleNextFrame();
  }

  /* ------------------------------------------------------------------ */
  /* Analogue Paper Audio Synth                                         */
  /* ------------------------------------------------------------------ */
  private ensureAudio(): AudioContext | null {
    if (this.audioCtx) return this.audioCtx;
    const AudioContextClass =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return null;
    this.audioCtx = new AudioContextClass();
    return this.audioCtx;
  }

  private tone(freq: number, duration: number, type: OscillatorType = 'sine', gainValue = 0.05, when = 0) {
    const ctx = this.ensureAudio();
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

  private noise(duration = 0.25, gainValue = 0.04) {
    const ctx = this.ensureAudio();
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
}
