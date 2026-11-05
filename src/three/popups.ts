import * as THREE from 'three';
import gsap from 'gsap';
import type { LessonSpread, SceneObjectDef } from '../data/lessonSchema';
import { makeCanvas, seededRandom, type ProceduralTextures } from './textures';

export interface BuiltPopup {
  group: THREE.Group;
  tagY: number;
  activate: (instant?: boolean) => void;
  update: (dt: number, time: number) => void;
}

export interface PopupLibrary {
  buildPopup: (def: SceneObjectDef, spread: LessonSpread) => BuiltPopup;
  makePlateTexture: (spread: LessonSpread, index?: number) => THREE.CanvasTexture;
  dispose: () => void;
}

const INK = 0x2b2318;
const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;

export function createPopupLibrary({
  TEX,
  maxAnisotropy = 8,
}: {
  TEX: ProceduralTextures;
  maxAnisotropy?: number;
}): PopupLibrary {
  const createdTextures: THREE.CanvasTexture[] = [];
  const cache = new Map<string, THREE.CanvasTexture>();

  function canvasTexture(
    w: number,
    h: number,
    draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
  ): THREE.CanvasTexture {
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    draw(ctx, w, h);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, Math.max(1, maxAnisotropy));
    createdTextures.push(texture);
    return texture;
  }

  function cachedTexture(
    key: string,
    w: number,
    h: number,
    draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
  ): THREE.CanvasTexture {
    const existing = cache.get(key);
    if (existing) return existing;
    const tex = canvasTexture(w, h, draw);
    cache.set(key, tex);
    return tex;
  }

  function paperMaterial(
    hex = 0xf3e7cf,
    opts: {
      roughness?: number;
      metalness?: number;
      side?: THREE.Side;
      emissive?: THREE.ColorRepresentation;
      emissiveIntensity?: number;
      transparent?: boolean;
      opacity?: number;
    } = {},
  ): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      map: TEX.hatch,
      color: hex,
      roughness: opts.roughness ?? 0.91,
      metalness: opts.metalness ?? 0,
      side: opts.side ?? THREE.FrontSide,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 0,
      bumpMap: TEX.paper,
      bumpScale: 0.006,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
    });
  }

  function inkLineMaterial(opacity = 0.82): THREE.LineBasicMaterial {
    return new THREE.LineBasicMaterial({
      color: INK,
      transparent: true,
      opacity,
      depthWrite: false,
    });
  }

  function addOutline(mesh: THREE.Mesh, opacity = 0.8): THREE.LineSegments {
    const edges = new THREE.EdgesGeometry(mesh.geometry, 26);
    const line = new THREE.LineSegments(edges, inkLineMaterial(opacity));
    line.renderOrder = 3;
    mesh.add(line);
    return line;
  }

  function extrude(shape: THREE.Shape, depth = 0.06, bevel = 0.007): THREE.ExtrudeGeometry {
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      steps: 1,
      curveSegments: 20,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 2,
    });
    geometry.translate(0, 0, -depth / 2);
    return geometry;
  }

  function rounded(w: number, h: number, r: number): THREE.Shape {
    const shape = new THREE.Shape();
    const x = -w / 2;
    const y = -h / 2;
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + h - r);
    shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    shape.lineTo(x + r, y + h);
    shape.quadraticCurveTo(x, y + h, x, y + h - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);
    return shape;
  }

  function roundedMesh(
    w: number,
    h: number,
    r: number,
    depth: number,
    color: number,
    opts: Parameters<typeof paperMaterial>[1] & { bevel?: number; outline?: number } = {},
  ): THREE.Mesh {
    const geometry = extrude(rounded(w, h, r), depth, opts.bevel ?? 0.005);
    const mesh = new THREE.Mesh(geometry, paperMaterial(color, opts));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    addOutline(mesh, opts.outline ?? 0.78);
    return mesh;
  }

  function barBetween(
    a: THREE.Vector3,
    b: THREE.Vector3,
    radius: number,
    material: THREE.Material,
    segments = 7,
  ): THREE.Mesh {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const geometry = new THREE.CylinderGeometry(radius, radius, len, segments);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    mesh.castShadow = true;
    return mesh;
  }

  function flat(
    shape: THREE.Shape,
    color: THREE.ColorRepresentation,
    opts: {
      emissive?: THREE.ColorRepresentation;
      emissiveIntensity?: number;
      transparent?: boolean;
      opacity?: number;
    } = {},
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.ShapeGeometry(shape, 20),
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.92,
        metalness: 0,
        side: THREE.DoubleSide,
        emissive: opts.emissive ?? 0x000000,
        emissiveIntensity: opts.emissiveIntensity ?? 0,
        transparent: opts.transparent ?? false,
        opacity: opts.opacity ?? 1,
      }),
    );
    mesh.castShadow = true;
    return mesh;
  }

  function textPlane(
    texture: THREE.Texture,
    w: number,
    h: number,
    opts: {
      transparent?: boolean;
      opacity?: number;
      side?: THREE.Side;
      depthWrite?: boolean;
    } = {},
  ): THREE.Mesh {
    return new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: opts.transparent ?? false,
        opacity: opts.opacity ?? 1,
        side: opts.side ?? THREE.FrontSide,
        depthWrite: opts.depthWrite ?? true,
        toneMapped: false,
      }),
    );
  }

  function lighten(hex: THREE.ColorRepresentation, amount = 0.6): THREE.Color {
    return new THREE.Color(hex).lerp(new THREE.Color(0xfff8eb), amount);
  }

  function glowSprite(hex: THREE.ColorRepresentation, size = 0.9): THREE.Sprite {
    const material = new THREE.SpriteMaterial({
      map: TEX.dot,
      color: hex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.setScalar(size);
    return sprite;
  }

  /* ------------------------------------------------------------------ */
  /* Printed textures                                                    */
  /* ------------------------------------------------------------------ */
  function screenTexture(lines: string[], accent = '#74e6a4', title = 'SECURE CONSOLE'): THREE.CanvasTexture {
    return canvasTexture(512, 312, (ctx, w, h) => {
      ctx.fillStyle = '#0d211c';
      ctx.fillRect(0, 0, w, h);
      const grad = ctx.createRadialGradient(w * 0.5, h * 0.3, 20, w * 0.5, h * 0.5, w * 0.8);
      grad.addColorStop(0, 'rgba(74,167,132,.18)');
      grad.addColorStop(1, 'rgba(4,12,10,.55)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(133,232,183,.22)';
      ctx.lineWidth = 1;
      for (let y = 4; y < h; y += 4) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.fillStyle = accent;
      ctx.font = '500 15px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(title, 26, 36);
      ctx.strokeStyle = 'rgba(133,232,183,.35)';
      ctx.beginPath();
      ctx.moveTo(26, 48);
      ctx.lineTo(w - 26, 48);
      ctx.stroke();
      ctx.font = '400 20px "IBM Plex Mono", monospace';
      lines.forEach((line, i) => {
        ctx.fillStyle = line.startsWith('!') ? '#ff9a6b' : accent;
        ctx.fillText(line.replace(/^!/, ''), 28, 92 + i * 39);
      });
      ctx.fillStyle = accent;
      ctx.fillRect(28, h - 42, 11, 20);
      ctx.globalAlpha = 0.45;
      ctx.font = '400 10px "IBM Plex Mono", monospace';
      ctx.fillText('ROOT@FIELD-BOOK  /  SESSION 0x2A', 52, h - 26);
    });
  }

  function noteTexture(): THREE.CanvasTexture {
    return cachedTexture('ransom-note', 460, 600, (ctx, w, h) => {
      const rnd = seededRandom(9241);
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      const steps = 46;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        ctx.lineTo(t * w, 8 + (i % 2 ? rnd() * 9 : -rnd() * 5));
      }
      for (let i = steps; i >= 0; i--) {
        const t = i / steps;
        ctx.lineTo(w - 8 + (i % 2 ? rnd() * 8 : 0), t * h);
      }
      for (let i = steps; i >= 0; i--) {
        const t = i / steps;
        ctx.lineTo(t * w, h - 10 - (i % 2 ? rnd() * 7 : 0));
      }
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        ctx.lineTo(9 + (i % 2 ? rnd() * 7 : 0), t * h);
      }
      ctx.closePath();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = '#efe2c6';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 2600; i++) {
        ctx.fillStyle = `rgba(92,64,30,${0.01 + rnd() * 0.035})`;
        ctx.fillRect(rnd() * w, rnd() * h, 1, 1);
      }
      ctx.strokeStyle = 'rgba(72,37,22,.7)';
      ctx.lineWidth = 22;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(176,94,42,.55)';
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.translate(w / 2, 0);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#26201a';
      const words = ['YOUR', 'FILES ARE', 'ENCRYPTED'];
      words.forEach((word, wi) => {
        let x = -w * 0.38;
        const y = 110 + wi * 62;
        for (const ch of word) {
          const size = 30 + rnd() * 12;
          ctx.save();
          ctx.translate(x, y + (rnd() - 0.5) * 10);
          ctx.rotate((rnd() - 0.5) * 0.2);
          ctx.font = `700 ${size}px "IBM Plex Mono", monospace`;
          ctx.fillStyle = wi === 2 ? '#a63d26' : '#2a241d';
          ctx.fillText(ch, 0, 0);
          ctx.restore();
          x += ctx.measureText('M').width * 0.52 * (size / 30);
        }
      });
      ctx.fillStyle = '#4d4335';
      ctx.font = '400 14px "IBM Plex Mono", monospace';
      ctx.fillText('ALL 12,480 FILES HAVE BEEN SEALED.', 0, 330);
      ctx.fillText('THE KEY LIVES ON OUR SERVER.', 0, 352);
      ctx.strokeStyle = 'rgba(80,60,36,.35)';
      ctx.beginPath();
      ctx.moveTo(-150, 374);
      ctx.lineTo(150, 374);
      ctx.stroke();
      ctx.fillStyle = '#9e3524';
      ctx.font = '700 29px "IBM Plex Mono", monospace';
      ctx.fillText('PAY 2.4 BTC', 0, 428);
      ctx.fillStyle = '#423a2d';
      ctx.font = '400 12px "IBM Plex Mono", monospace';
      ctx.fillText('bc1q7…threat…archive', 0, 456);
      const qx = -56;
      const qy = 480;
      for (let gy = 0; gy < 15; gy++) {
        for (let gx = 0; gx < 15; gx++) {
          if (rnd() > 0.52) {
            ctx.fillRect(qx + gx * 7.2, qy + gy * 7.2, 6, 6);
          }
        }
      }
      ctx.fillStyle = 'rgba(158,53,36,.85)';
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      ctx.fillText('DO NOT CONTACT AUTHORITIES', 0, 584);
      ctx.restore();
    });
  }

  function letterTexture(): THREE.CanvasTexture {
    return cachedTexture('phish-letter', 440, 310, (ctx, w, h) => {
      ctx.fillStyle = '#f5edd9';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(110,84,46,.24)';
      ctx.lineWidth = 2;
      ctx.strokeRect(18, 18, w - 36, h - 36);
      ctx.fillStyle = '#6b4b8a';
      ctx.font = '500 12px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('FROM: accounts@payroll-secure.example', 34, 52);
      ctx.fillText('SUBJECT: URGENT — VERIFY IN 2 HOURS', 34, 74);
      ctx.fillStyle = '#9f3529';
      ctx.font = '700 22px "Amiri", serif';
      ctx.textAlign = 'right';
      ctx.fillText('تأكيد بيانات الراتب', w - 34, 116);
      ctx.fillStyle = '#4f4638';
      ctx.font = '400 14px "Amiri", serif';
      ctx.textAlign = 'right';
      ctx.fillText('انقر الرابط أدناه قبل نهاية اليوم وإلا سيُعلَّق حسابك.', w - 34, 148);
      ctx.fillText('إدارة الموارد البشرية — قسم الرواتب', w - 34, 176);
      ctx.fillStyle = '#6b4b8a';
      ctx.font = '500 14px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('https://payroll-verify.example/login', 34, 225);
      ctx.strokeStyle = '#6b4b8a';
      ctx.beginPath();
      ctx.moveTo(34, 232);
      ctx.lineTo(302, 232);
      ctx.stroke();
      ctx.fillStyle = 'rgba(107,75,138,.2)';
      ctx.fillRect(34, 250, 120, 24);
      ctx.fillStyle = '#5a4770';
      ctx.font = '500 11px "IBM Plex Mono", monospace';
      ctx.fillText('VERIFY NOW', 58, 266);
    });
  }

  function badgeFrontTexture(): THREE.CanvasTexture {
    return cachedTexture('badge-front', 360, 500, (ctx, w, h) => {
      ctx.fillStyle = '#f2e5cd';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#233b3a';
      ctx.fillRect(0, 0, w, 74);
      ctx.fillStyle = '#e7d6b3';
      ctx.font = '500 11px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('FIELD OPERATIONS / CONTRACTOR', 22, 30);
      ctx.font = '700 22px "Playfair Display", serif';
      ctx.fillStyle = '#f4e9d2';
      ctx.fillText('VISITOR 04', 22, 58);
      ctx.fillStyle = '#c9bda4';
      ctx.beginPath();
      ctx.arc(w / 2, 158, 56, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#8c9b91';
      ctx.beginPath();
      ctx.arc(w / 2, 143, 22, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(w / 2, 196, 40, 30, 0, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#2f2920';
      ctx.textAlign = 'center';
      ctx.font = '700 24px "Amiri", serif';
      ctx.fillText('نادر حسن', w / 2, 270);
      ctx.font = '500 11px "IBM Plex Mono", monospace';
      ctx.fillStyle = '#7f7159';
      ctx.fillText('IT SUPPORT · TEMP ACCESS', w / 2, 292);
      ctx.strokeStyle = 'rgba(70,52,28,.3)';
      ctx.beginPath();
      ctx.moveTo(30, 318);
      ctx.lineTo(w - 30, 318);
      ctx.stroke();
      for (let i = 0; i < 38; i++) {
        ctx.fillStyle = i % 3 ? '#3b3326' : '#8f7d5f';
        const bw = i % 4 === 0 ? 4 : 2;
        ctx.fillRect(34 + i * 7.7, 340, bw, 44);
      }
      ctx.fillStyle = '#7f7159';
      ctx.font = '400 9px "IBM Plex Mono", monospace';
      ctx.fillText('ID 7F-22-091 · EXPIRES 09/26', w / 2, 414);
      ctx.fillStyle = '#6b4b8a';
      ctx.fillRect(0, h - 18, w, 18);
    });
  }

  function badgeBackTexture(): THREE.CanvasTexture {
    return cachedTexture('badge-back', 360, 500, (ctx, w, h) => {
      ctx.fillStyle = '#e8dcc2';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(83,63,35,.3)';
      ctx.lineWidth = 2;
      ctx.strokeRect(20, 20, w - 40, h - 40);
      ctx.fillStyle = '#6b4b8a';
      ctx.font = '700 96px "Amiri", serif';
      ctx.textAlign = 'center';
      ctx.fillText('؟', w / 2, 212);
      ctx.fillStyle = '#493d2c';
      ctx.font = '500 12px "IBM Plex Mono", monospace';
      ctx.fillText('IDENTITY UNVERIFIED', w / 2, 262);
      ctx.fillStyle = '#9f3529';
      ctx.font = '700 21px "IBM Plex Mono", monospace';
      ctx.fillText('SPOOFED', w / 2, 296);
      ctx.fillStyle = '#6d5d45';
      ctx.font = '400 13px "Amiri", serif';
      ctx.fillText('صفة موثوقة… لا وجود لها.', w / 2, 330);
      ctx.strokeStyle = 'rgba(159,53,41,.42)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(40, 400);
      ctx.lineTo(w - 40, 366);
      ctx.stroke();
    });
  }

  function drawIcon(
    ctx: CanvasRenderingContext2D,
    type: 'lock' | 'hook' | 'network',
    cx: number,
    cy: number,
    size: number,
    color: string,
  ) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(3, size * 0.075);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (type === 'lock') {
      ctx.strokeRect(-size * 0.34, -size * 0.02, size * 0.68, size * 0.58);
      ctx.beginPath();
      ctx.arc(0, -size * 0.03, size * 0.22, Math.PI, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, size * 0.22, size * 0.055, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, size * 0.27);
      ctx.lineTo(0, size * 0.4);
      ctx.stroke();
    } else if (type === 'hook') {
      ctx.beginPath();
      ctx.moveTo(size * 0.26, -size * 0.4);
      ctx.lineTo(size * 0.26, size * 0.06);
      ctx.arc(0, size * 0.06, size * 0.26, 0, Math.PI, false);
      ctx.lineTo(-size * 0.26, size * 0.24);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(size * 0.26, -size * 0.4);
      ctx.lineTo(size * 0.26, -size * 0.52);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-size * 0.26, size * 0.24);
      ctx.lineTo(-size * 0.09, size * 0.31);
      ctx.lineTo(-size * 0.25, size * 0.39);
      ctx.closePath();
      ctx.fill();
    } else {
      const nodes: [number, number][] = [
        [-0.34, 0.02],
        [0.02, -0.28],
        [0.34, 0.06],
        [0.02, 0.32],
      ];
      const pts = nodes.map(([x, y]) => [x * size, y * size]);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
      ctx.lineTo(pts[2][0], pts[2][1]);
      ctx.lineTo(pts[3][0], pts[3][1]);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[3][0], pts[3][1]);
      ctx.stroke();
      pts.forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, size * 0.075, 0, TAU);
        ctx.fill();
      });
    }
    ctx.restore();
  }

  function reviewFrontTexture(icon: 'lock' | 'hook' | 'network', label: string, en: string): THREE.CanvasTexture {
    return cachedTexture(`review-front-${icon}`, 400, 560, (ctx, w, h) => {
      const paper = ctx.createLinearGradient(0, 0, w, h);
      paper.addColorStop(0, '#f6efdd');
      paper.addColorStop(1, '#e9dcc1');
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(80,61,34,.3)';
      ctx.lineWidth = 2;
      ctx.strokeRect(20, 20, w - 40, h - 40);
      ctx.fillStyle = '#7b6b50';
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('FIELD CARD / REVIEW', 40, 52);
      ctx.fillStyle = '#4a6a3a';
      drawIcon(ctx, icon, w / 2, 188, 138, '#4a6a3a');
      ctx.fillStyle = '#2e2a20';
      ctx.textAlign = 'center';
      ctx.font = '700 34px "Amiri", serif';
      ctx.fillText(label, w / 2, 352);
      ctx.fillStyle = '#807259';
      ctx.font = '500 11px "IBM Plex Mono", monospace';
      ctx.fillText(en, w / 2, 382);
      ctx.strokeStyle = 'rgba(78,106,58,.5)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(74, 420);
      ctx.lineTo(326, 420);
      ctx.stroke();
      ctx.fillStyle = '#5c503c';
      ctx.font = '400 15px "Amiri", serif';
      ctx.fillText('اقلب البطاقة لمراجعة الآلية.', w / 2, 462);
      ctx.fillStyle = '#9a8a6e';
      ctx.font = '500 9px "IBM Plex Mono", monospace';
      ctx.fillText('TAP OR CLICK TO FLIP', w / 2, 512);
    });
  }

  function reviewBackTexture(icon: 'lock' | 'hook' | 'network', en: string): THREE.CanvasTexture {
    return cachedTexture(`review-back-${icon}`, 400, 560, (ctx, w, h) => {
      ctx.fillStyle = '#e3d7be';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(80,61,34,.28)';
      ctx.lineWidth = 2;
      ctx.strokeRect(20, 20, w - 40, h - 40);
      ctx.fillStyle = 'rgba(74,106,58,.12)';
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 150, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(74,106,58,.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 146, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = '#3f5b35';
      drawIcon(ctx, icon, w / 2, 214, 150, '#3f5b35');
      ctx.textAlign = 'center';
      ctx.fillStyle = '#3b3326';
      ctx.font = '700 40px "IBM Plex Mono", monospace';
      ctx.fillText(en, w / 2, 374);
      ctx.fillStyle = '#6b5d45';
      ctx.font = '400 16px "Amiri", serif';
      ctx.fillText('المفهوم الذي تشرحه هو الذي فهمته.', w / 2, 426);
      ctx.fillStyle = '#7b6b50';
      ctx.font = '500 9px "IBM Plex Mono", monospace';
      ctx.fillText('UNIT 02 · SELF REVIEW', w / 2, 506);
    });
  }

  function usbFlagTexture(): THREE.CanvasTexture {
    return cachedTexture('usb-flag', 300, 160, (ctx, w, h) => {
      ctx.fillStyle = '#f2e6ce';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#9f3529';
      ctx.lineWidth = 4;
      ctx.strokeRect(9, 9, w - 18, h - 18);
      ctx.fillStyle = '#9f3529';
      ctx.textAlign = 'center';
      ctx.font = '700 30px "IBM Plex Mono", monospace';
      ctx.fillText('AUTORUN', w / 2, 72);
      ctx.fillStyle = '#4c4030';
      ctx.font = '400 14px "Amiri", serif';
      ctx.fillText('فضولك هو باب الدخول', w / 2, 108);
      ctx.fillStyle = '#8e7c5d';
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      ctx.fillText('FREE DRIVER · 8GB', w / 2, 132);
    });
  }

  function serverPanelTexture(row: number): THREE.CanvasTexture {
    return cachedTexture(`server-panel-${row}`, 256, 88, (ctx, w, h) => {
      ctx.fillStyle = '#e7dac0';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(66,52,32,.5)';
      ctx.lineWidth = 2;
      ctx.strokeRect(4, 4, w - 8, h - 8);
      ctx.fillStyle = 'rgba(61,48,31,.72)';
      ctx.font = '500 12px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`NODE 0${row + 1}`, 16, 24);
      ctx.fillStyle = 'rgba(74,61,42,.28)';
      for (let i = 0; i < 7; i++) {
        ctx.fillRect(16, 38 + i * 6, 140 - (i % 3) * 12, 2);
      }
      ctx.fillStyle = '#8c7a5b';
      ctx.font = '400 9px "IBM Plex Mono", monospace';
      ctx.fillText('LOAD', 174, 30);
      ctx.strokeStyle = '#3f5b35';
      ctx.fillStyle = '#3f5b35';
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(176 + i * 16, 40, 10, 22);
      }
      ctx.fillStyle = '#7b6b50';
      ctx.fillText('MEM', 176, 78);
    });
  }

  function gaugeTexture(): THREE.CanvasTexture {
    return cachedTexture('server-gauge', 300, 220, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#efe4cc';
      ctx.beginPath();
      ctx.arc(w / 2, h / 2 + 20, 92, Math.PI, TAU);
      ctx.lineTo(w / 2 + 92, h / 2 + 30);
      ctx.lineTo(w / 2 - 92, h / 2 + 30);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#4a3c2a';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(74,60,42,.55)';
      ctx.lineWidth = 2;
      for (let i = 0; i <= 12; i++) {
        const a = Math.PI + (i / 12) * Math.PI;
        const r1 = 76;
        const r2 = i % 3 === 0 ? 62 : 68;
        ctx.beginPath();
        ctx.moveTo(w / 2 + Math.cos(a) * r1, h / 2 + 20 + Math.sin(a) * r1);
        ctx.lineTo(w / 2 + Math.cos(a) * r2, h / 2 + 20 + Math.sin(a) * r2);
        ctx.stroke();
      }
      ctx.fillStyle = '#7b6b50';
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('LOAD', w / 2, h - 30);
      ctx.fillStyle = '#a63d26';
      ctx.fillRect(w / 2 + 42, h / 2 + 52, 22, 12);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Right page plate: printed annotations, leader lines, legend         */
  /* ------------------------------------------------------------------ */
  const PLATE_W = 1024;
  const PLATE_H = 1327;
  const PAGE_W = 4.18;
  const PAGE_H = 5.42;

  function wrapText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
  ): number {
    const words = String(text).split(/\s+/);
    let line = '';
    let yy = y;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, yy);
        line = word;
        yy += lineHeight;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x, yy);
    return yy;
  }

  function hexA(hex: THREE.ColorRepresentation, a: number): string {
    const c = new THREE.Color(hex);
    return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
  }

  function makePlateTexture(spread: LessonSpread, index = 0): THREE.CanvasTexture {
    const accent = spread.scene.accent;
    const rnd = seededRandom(1907 + index * 811);
    return canvasTexture(PLATE_W, PLATE_H, (ctx, w, h) => {
      ctx.direction = 'rtl';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#f3e9d4';
      ctx.fillRect(0, 0, w, h);

      for (let i = 0; i < 9000; i++) {
        ctx.fillStyle =
          rnd() > 0.52
            ? `rgba(255,255,248,${0.02 + rnd() * 0.05})`
            : `rgba(104,76,42,${0.012 + rnd() * 0.03})`;
        ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 1.6, 1 + rnd() * 1.3);
      }
      for (let i = 0; i < 90; i++) {
        ctx.strokeStyle = `rgba(124,91,49,${0.012 + rnd() * 0.018})`;
        ctx.lineWidth = 0.7;
        const y = rnd() * h;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(w * 0.3, y + 3, w * 0.7, y - 3, w, y + 1);
        ctx.stroke();
      }

      const gutter = ctx.createLinearGradient(0, 0, 140, 0);
      gutter.addColorStop(0, 'rgba(86,60,30,.28)');
      gutter.addColorStop(0.55, 'rgba(86,60,30,.06)');
      gutter.addColorStop(1, 'rgba(86,60,30,0)');
      ctx.fillStyle = gutter;
      ctx.fillRect(0, 0, 160, h);

      const edge = ctx.createRadialGradient(w * 0.55, h * 0.46, h * 0.2, w * 0.5, h * 0.5, h * 0.78);
      edge.addColorStop(0, 'rgba(255,255,255,0)');
      edge.addColorStop(1, 'rgba(82,56,27,.14)');
      ctx.fillStyle = edge;
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.globalAlpha = 0.055;
      ctx.fillStyle = accent;
      ctx.font = '700 270px "Playfair Display", serif';
      ctx.textAlign = 'left';
      ctx.fillText(String(spread.n).padStart(2, '0'), 34, 330);
      ctx.restore();

      ctx.textAlign = 'left';
      ctx.fillStyle = '#8a7350';
      ctx.font = '500 13px "IBM Plex Mono", monospace';
      ctx.fillText(spread.eyebrow, 72, 68);
      ctx.fillStyle = accent;
      ctx.fillRect(72, 82, 52, 3);
      ctx.fillStyle = '#a08a63';
      ctx.font = '400 11px "IBM Plex Mono", monospace';
      ctx.fillText(`${spread.scene.figure}  ·  FIELD PLATE`, 72, 108);

      const title = spread.scene.title;
      const titleSize = title.length > 24 ? 38 : title.length > 17 ? 46 : 54;
      ctx.textAlign = 'right';
      ctx.direction = 'rtl';
      ctx.fillStyle = '#241f17';
      ctx.font = `700 ${titleSize}px "Amiri", serif`;
      ctx.fillText(title, w - 72, 142);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(w - 72, 164);
      ctx.bezierCurveTo(w - 250, 158, w - 390, 172, w - 510, 162);
      ctx.stroke();

      ctx.fillStyle = '#6f6049';
      ctx.font = '400 20px "Amiri", serif';
      ctx.textAlign = 'right';
      wrapText(ctx, spread.scene.hint, w - 72, 202, 540, 29);

      ctx.strokeStyle = 'rgba(112,87,51,.4)';
      ctx.lineWidth = 1.4;
      [
        [54, 224],
        [w - 54, 224],
        [54, h - 190],
        [w - 54, h - 190],
      ].forEach(([x, y], i) => {
        const sx = i % 2 === 0 ? 1 : -1;
        const sy = i < 2 ? 1 : -1;
        ctx.beginPath();
        ctx.moveTo(x, y + sy * 13);
        ctx.lineTo(x, y);
        ctx.lineTo(x + sx * 13, y);
        ctx.stroke();
      });

      const mapPos = (p: [number, number, number]): [number, number] => [
        ((p[0] + PAGE_W / 2) / PAGE_W) * w,
        ((p[2] + PAGE_H / 2) / PAGE_H) * h,
      ];
      const anchors: Record<string, [number, number]> = {};
      spread.scene.objects.forEach((obj) => {
        anchors[obj.id] = mapPos(obj.pos);
      });

      spread.scene.links.forEach((link, i) => {
        const a = anchors[link.from];
        const b = anchors[link.to];
        if (!a || !b) return;
        const mx = (a[0] + b[0]) / 2;
        const my = (a[1] + b[1]) / 2;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const bow = i % 2 === 0 ? 54 : -54;
        const cx = mx + nx * bow;
        const cy = my + ny * bow;
        ctx.save();
        ctx.strokeStyle = hexA(accent, 0.62);
        ctx.lineWidth = 2.2;
        ctx.setLineDash([8, 8]);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.quadraticCurveTo(cx, cy, b[0], b[1]);
        ctx.stroke();
        ctx.setLineDash([]);
        const angle = Math.atan2(b[1] - cy, b[0] - cx);
        ctx.translate(b[0], b[1]);
        ctx.rotate(angle);
        ctx.fillStyle = hexA(accent, 0.72);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-15, 6);
        ctx.lineTo(-11, 0);
        ctx.lineTo(-15, -6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        const t = 0.52;
        const lx = (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * cx + t * t * b[0];
        const ly = (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * cy + t * t * b[1];
        ctx.save();
        ctx.fillStyle = '#f3e9d4';
        ctx.fillRect(lx - 44, ly - 13, 88, 22);
        ctx.fillStyle = '#806b4b';
        ctx.font = '500 11px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(link.label || '').toUpperCase(), lx, ly + 4);
        ctx.restore();
      });

      spread.scene.objects.forEach((obj, i) => {
        const [x, y] = anchors[obj.id];
        ctx.save();
        ctx.strokeStyle = hexA(accent, 0.8);
        ctx.fillStyle = 'rgba(243,233,212,.94)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 19, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(x, y, 25, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = accent;
        ctx.font = '700 12px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';
        ctx.direction = 'ltr';
        ctx.fillText(String(i + 1).padStart(2, '0'), x, y + 4);
        ctx.restore();
      });

      ctx.save();
      ctx.direction = 'rtl';
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,.34)';
      ctx.fillRect(72, h - 184, w - 144, 84);
      ctx.strokeStyle = hexA(accent, 0.6);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(w - 72, h - 184);
      ctx.lineTo(w - 72, h - 100);
      ctx.stroke();
      ctx.fillStyle = '#584b38';
      ctx.font = '400 20px "Amiri", serif';
      wrapText(ctx, spread.scene.note, w - 90, h - 148, w - 190, 28);
      ctx.restore();

      ctx.textAlign = 'left';
      ctx.direction = 'ltr';
      ctx.fillStyle = '#8a7452';
      ctx.font = '500 11px "IBM Plex Mono", monospace';
      ctx.fillText('LEGEND', 72, h - 60);
      ctx.fillStyle = accent;
      ctx.fillRect(142, h - 68, 22, 5);
      ctx.fillStyle = '#6f6049';
      ctx.font = '400 15px "Amiri", serif';
      ctx.textAlign = 'right';
      ctx.direction = 'rtl';
      ctx.fillText(spread.scene.legend, w - 72, h - 58);

      ctx.textAlign = 'center';
      ctx.direction = 'ltr';
      ctx.fillStyle = '#8a7452';
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      ctx.fillText(`P. ${spread.page}  ·  ${String(spread.n).padStart(2, '0')} / 05`, w / 2, h - 24);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 01 — Shield, network, laptop                                        */
  /* ------------------------------------------------------------------ */
  function buildShield(_def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    const accent = new THREE.Color(spread.scene.accent);
    const group = new THREE.Group();
    const root = new THREE.Group();
    root.rotation.x = -0.07;
    group.add(root);
    const cream = lighten(accent, 0.82).getHex();

    const shape = new THREE.Shape();
    shape.moveTo(0, 1.3);
    shape.bezierCurveTo(0.22, 1.24, 0.44, 1.12, 0.58, 0.92);
    shape.lineTo(0.58, 0.58);
    shape.bezierCurveTo(0.57, 0.22, 0.3, 0.0, 0, -0.18);
    shape.bezierCurveTo(-0.3, 0.0, -0.57, 0.22, -0.58, 0.58);
    shape.lineTo(-0.58, 0.92);
    shape.bezierCurveTo(-0.44, 1.12, -0.22, 1.24, 0, 1.3);

    const shieldMat = paperMaterial(cream);
    const shield = new THREE.Mesh(extrude(shape, 0.085, 0.012), shieldMat);
    shield.position.y = 0.15;
    shield.castShadow = true;
    shield.receiveShadow = true;
    addOutline(shield, 0.88);
    root.add(shield);

    const innerMat = new THREE.MeshStandardMaterial({
      color: accent.clone().lerp(new THREE.Color(0xffffff), 0.22),
      roughness: 0.8,
      metalness: 0.02,
      emissive: accent,
      emissiveIntensity: 0,
    });
    const innerGeo = new THREE.ShapeGeometry(shape, 24);
    innerGeo.scale(0.66, 0.66, 1);
    const inner = new THREE.Mesh(innerGeo, innerMat);
    inner.position.set(0, 0.38, 0.056);
    root.add(inner);

    const emblemMat = new THREE.MeshStandardMaterial({
      color: 0x201c16,
      roughness: 0.65,
      metalness: 0.15,
      emissive: accent,
      emissiveIntensity: 0.05,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.021, 8, 30), emblemMat);
    ring.position.set(0, 0.87, 0.075);
    root.add(ring);
    const keyStem = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.15, 0.03), emblemMat);
    keyStem.position.set(0, 0.75, 0.075);
    root.add(keyStem);

    // Dynamic vertical defense meter beside shield
    const meterGroup = new THREE.Group();
    meterGroup.position.set(-0.68, 0.02, 0.05);
    root.add(meterGroup);
    const meterHousing = roundedMesh(0.11, 0.78, 0.03, 0.04, cream, { bevel: 0.003 });
    meterHousing.position.y = 0.39;
    meterGroup.add(meterHousing);
    const meterFillMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.15,
      roughness: 0.35,
    });
    const meterFill = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.64, 0.022), meterFillMat);
    meterFill.geometry.translate(0, 0.32, 0);
    meterFill.position.set(0, 0.06, 0.022);
    meterFill.scale.y = 0.16;
    meterGroup.add(meterFill);

    const footMat = paperMaterial(lighten(accent, 0.72).getHex(), { side: THREE.DoubleSide });
    [-1, 1].forEach((s) => {
      const pts = [
        new THREE.Vector3(s * 0.36, 0.02, -0.02),
        new THREE.Vector3(s * 0.66, 0.02, 0.22),
        new THREE.Vector3(s * 0.28, 0.02, 0.28),
      ];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      geo.setIndex([0, 1, 2]);
      geo.computeVertexNormals();
      root.add(new THREE.Mesh(geo, footMat));
    });

    const ringMats: THREE.MeshBasicMaterial[] = [];
    const rings: THREE.Mesh[] = [];
    [0.82, 1.04, 1.27].forEach((radius, i) => {
      const mat = new THREE.MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.011, 5, 72), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.016 + i * 0.004;
      root.add(mesh);
      ringMats.push(mat);
      rings.push(mesh);
    });

    let active = false;

    function activate(instant = false) {
      active = true;
      if (instant) {
        innerMat.emissiveIntensity = 0.48;
        meterFill.scale.y = 1;
        meterFillMat.emissiveIntensity = 0.75;
        ringMats.forEach((m) => {
          m.opacity = 0.3;
        });
        return;
      }
      gsap.killTweensOf(innerMat);
      gsap.to(innerMat, { emissiveIntensity: 0.55, duration: 0.5, ease: 'power2.out' });
      gsap.to(meterFill.scale, { y: 1, duration: 0.75, ease: 'power3.out' });
      gsap.to(meterFillMat, { emissiveIntensity: 0.85, duration: 0.5 });
      ringMats.forEach((mat, i) => {
        gsap.fromTo(mat, { opacity: 0.58 }, { opacity: 0.3, duration: 1.6, delay: i * 0.12, ease: 'power2.out' });
      });
      gsap.fromTo(
        shield.scale,
        { x: 1, y: 1, z: 1 },
        { x: 1.045, y: 1.045, z: 1.045, duration: 0.32, yoyo: true, repeat: 1, ease: 'power2.out' },
      );
    }

    function update(_dt: number, time: number) {
      if (!active) return;
      ringMats.forEach((mat, i) => {
        mat.opacity = 0.22 + 0.13 * Math.sin(time * 1.6 + i * 1.2);
        rings[i].scale.setScalar(0.98 + 0.035 * Math.sin(time * 1.4 + i));
        rings[i].rotation.z = time * 0.12 * (i % 2 ? -1 : 1);
      });
      innerMat.emissiveIntensity = 0.42 + 0.12 * Math.sin(time * 2.2);
      meterFillMat.emissiveIntensity = 0.65 + 0.22 * Math.sin(time * 2.6);
      ring.rotation.z = Math.sin(time * 0.7) * 0.08;
    }

    return { group, tagY: 1.62, activate, update };
  }

  function buildNetwork(_def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    const accent = new THREE.Color(spread.scene.accent);
    const group = new THREE.Group();
    const root = new THREE.Group();
    group.add(root);
    const cream = lighten(accent, 0.8).getHex();
    const stemMat = paperMaterial(lighten(accent, 0.66).getHex());
    const gemMat = new THREE.MeshStandardMaterial({
      color: accent.clone().lerp(new THREE.Color(0xffffff), 0.15),
      roughness: 0.55,
      metalness: 0.1,
      emissive: accent,
      emissiveIntensity: 0,
    });

    const nodes: [number, number, number][] = [
      [-0.58, 0.22, 0.18],
      [-0.2, 0.52, 0.52],
      [0.32, 0.36, 0.44],
      [0.62, 0.23, -0.14],
      [-0.05, 0.46, -0.46],
    ];
    const tops: THREE.Vector3[] = [];
    const gems: THREE.Mesh[] = [];
    nodes.forEach(([x, h, z]) => {
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.095, 0.11, 0.035, 20),
        paperMaterial(cream),
      );
      base.position.set(x, 0.028, z);
      base.castShadow = true;
      base.receiveShadow = true;
      root.add(base);
      const top = new THREE.Vector3(x, h, z);
      root.add(barBetween(new THREE.Vector3(x, 0.04, z), top, 0.013, stemMat));
      const gem = new THREE.Mesh(new THREE.IcosahedronGeometry(0.072, 0), gemMat);
      gem.position.copy(top);
      gem.castShadow = true;
      root.add(gem);
      addOutline(gem, 0.6);
      tops.push(top);
      gems.push(gem);
    });

    const path = [0, 1, 2, 3];
    const wireInk = new THREE.MeshBasicMaterial({ color: 0x4c3f2d, transparent: true, opacity: 0.55 });
    const secretInk = new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
    });
    const glowMat = new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const connect = (a: number, b: number, mat: THREE.Material, radius: number) =>
      root.add(barBetween(tops[a], tops[b], radius, mat));
    for (let i = 0; i < path.length - 1; i++) connect(path[i], path[i + 1], wireInk, 0.008);
    connect(0, 4, secretInk, 0.011);
    connect(4, 2, secretInk, 0.011);
    for (let i = 0; i < path.length - 1; i++) connect(path[i], path[i + 1], glowMat, 0.017);
    connect(0, 4, glowMat, 0.02);
    connect(4, 2, glowMat, 0.02);

    const packet = new THREE.Mesh(
      new THREE.BoxGeometry(0.075, 0.05, 0.075),
      new THREE.MeshStandardMaterial({
        color: 0xffe6b4,
        emissive: accent,
        emissiveIntensity: 1.4,
        roughness: 0.45,
      }),
    );
    packet.position.copy(tops[0]);
    root.add(packet);
    const routeCurve = new THREE.CatmullRomCurve3([
      tops[0],
      tops[1],
      tops[2],
      tops[3],
      tops[2],
      tops[4],
      tops[0],
    ]);

    let active = false;
    function activate(instant = false) {
      active = true;
      if (instant) {
        secretInk.opacity = 0.6;
        glowMat.opacity = 0.34;
        gemMat.emissiveIntensity = 0.4;
        packet.visible = true;
        return;
      }
      gsap.to(secretInk, { opacity: 0.62, duration: 0.7 });
      gsap.to(glowMat, { opacity: 0.34, duration: 0.9 });
      gsap.to(gemMat, { emissiveIntensity: 0.42, duration: 0.6 });
      gems.forEach((gem, i) => {
        gsap.fromTo(
          gem.scale,
          { x: 0.8, y: 0.8, z: 0.8 },
          {
            x: 1.18,
            y: 1.18,
            z: 1.18,
            duration: 0.36,
            delay: i * 0.07,
            yoyo: true,
            repeat: 1,
            ease: 'power2.out',
          },
        );
      });
    }
    function update(dt: number, time: number) {
      if (!active) return;
      packet.position.copy(routeCurve.getPoint((time * 0.13) % 1));
      packet.rotation.y += dt * 2.4;
      glowMat.opacity = 0.26 + 0.12 * Math.sin(time * 3.2);
      gemMat.emissiveIntensity = 0.34 + 0.12 * Math.sin(time * 2.6);
    }

    return { group, tagY: 1.05, activate, update };
  }

  function buildLaptop(_def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    const accent = new THREE.Color(spread.scene.accent);
    const group = new THREE.Group();
    const root = new THREE.Group();
    group.add(root);
    const cream = lighten(accent, 0.86).getHex();

    const base = roundedMesh(1.34, 0.9, 0.09, 0.07, cream);
    base.rotation.x = -Math.PI / 2;
    base.position.y = 0.055;
    root.add(base);

    const keyboard = textPlane(
      cachedTexture('keyboard', 512, 330, (ctx, w, h) => {
        ctx.fillStyle = '#d9c9ac';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(66,52,32,.42)';
        ctx.lineWidth = 2;
        for (let row = 0; row < 5; row++) {
          for (let col = 0; col < 12; col++) {
            ctx.strokeRect(18 + col * 39, 18 + row * 42, 30, 28);
          }
        }
        ctx.fillStyle = 'rgba(66,52,32,.26)';
        ctx.fillRect(160, 234, 200, 68);
        ctx.strokeStyle = 'rgba(66,52,32,.42)';
        ctx.strokeRect(160, 234, 200, 68);
      }),
      1.02,
      0.59,
    );
    keyboard.rotation.x = -Math.PI / 2;
    keyboard.position.set(0, 0.092, 0.09);
    root.add(keyboard);

    const screenGroup = new THREE.Group();
    screenGroup.position.set(0, 0.09, -0.37);
    screenGroup.rotation.x = -0.2;
    root.add(screenGroup);
    const screenBack = roundedMesh(1.32, 0.82, 0.07, 0.055, cream);
    screenBack.position.y = 0.41;
    screenGroup.add(screenBack);

    const screenPaneMat = new THREE.MeshStandardMaterial({
      map: screenTexture(['$ ssh field@archive', 'AUTH .......... OK', '!PORT 3389 IS OPEN'], '#7cf0a8', 'FIELD TERMINAL'),
      roughness: 0.42,
      metalness: 0.05,
      emissive: accent,
      emissiveIntensity: 0.08,
    });
    const screenPane = new THREE.Mesh(new THREE.PlaneGeometry(1.14, 0.65), screenPaneMat);
    screenPane.position.set(0, 0.41, 0.033);
    screenGroup.add(screenPane);

    const hinge = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.028, 1.14, 10),
      new THREE.MeshStandardMaterial({ color: 0x6b5a40, roughness: 0.35, metalness: 0.65 }),
    );
    hinge.rotation.z = Math.PI / 2;
    hinge.position.set(0, 0.1, -0.38);
    root.add(hinge);

    const alertShape = new THREE.Shape();
    alertShape.moveTo(0, 0.26);
    alertShape.lineTo(0.25, -0.18);
    alertShape.lineTo(-0.25, -0.18);
    alertShape.closePath();
    const alertMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.3,
      roughness: 0.7,
    });
    const alertGroup = new THREE.Group();
    const alert = new THREE.Mesh(extrude(alertShape, 0.035, 0.008), alertMat);
    alertGroup.add(alert);
    const bang = new THREE.Mesh(
      new THREE.BoxGeometry(0.032, 0.16, 0.02),
      new THREE.MeshBasicMaterial({ color: 0xfff3d9 }),
    );
    bang.position.set(0, 0.05, 0.03);
    alertGroup.add(bang);
    alertGroup.position.set(0, 0.72, -0.33);
    alertGroup.scale.setScalar(0.001);
    root.add(alertGroup);

    let active = false;
    function activate(instant = false) {
      active = true;
      if (instant) {
        screenPaneMat.emissiveIntensity = 0.52;
        alertGroup.scale.setScalar(1);
        alertGroup.position.y = 1.22;
        alertGroup.rotation.z = -0.06;
        return;
      }
      gsap.to(screenPaneMat, { emissiveIntensity: 0.55, duration: 0.5 });
      gsap.to(alertGroup.scale, { x: 1, y: 1, z: 1, duration: 0.55, ease: 'back.out(2)' });
      gsap.to(alertGroup.position, { y: 1.24, duration: 0.65, ease: 'power3.out' });
      gsap.fromTo(
        root.rotation,
        { z: -0.012 },
        {
          z: 0.012,
          duration: 0.06,
          yoyo: true,
          repeat: 7,
          onComplete: () => {
            root.rotation.z = 0;
          },
        },
      );
    }
    function update(_dt: number, time: number) {
      if (!active) return;
      screenPaneMat.emissiveIntensity = 0.4 + 0.14 * Math.sin(time * 3.6);
      alertGroup.rotation.z = -0.06 + Math.sin(time * 1.8) * 0.035;
      alertMat.emissiveIntensity = 0.3 + 0.2 * Math.sin(time * 2.4);
    }

    return { group, tagY: 1.5, activate, update };
  }

  /* ------------------------------------------------------------------ */
  /* 02 — Files, lock, ransom note                                       */
  /* ------------------------------------------------------------------ */
  function buildFiles(_def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    const accent = new THREE.Color(spread.scene.accent);
    const group = new THREE.Group();
    const root = new THREE.Group();
    group.add(root);
    const cream = lighten(accent, 0.87).getHex();

    const sheetMats: THREE.MeshStandardMaterial[] = [];
    const sheets: THREE.Mesh[] = [];
    const configs: [number, number, number, number, number][] = [
      [-0.26, 0.03, -0.2, 0.24, 0.96],
      [0.05, 0.07, -0.12, -0.1, 1.0],
      [0.28, 0.02, 0.02, 0.18, 0.94],
      [-0.04, 0.1, 0.1, -0.06, 1.03],
    ];
    configs.forEach(([x, z, tilt, yaw, scale]) => {
      const mat = paperMaterial(cream);
      sheetMats.push(mat);
      const sheet = new THREE.Mesh(extrude(rounded(0.72 * scale, 1.02 * scale, 0.025), 0.018, 0.003), mat);
      sheet.position.set(x, 0.55, z);
      sheet.rotation.y = yaw;
      sheet.rotation.z = tilt * 0.35;
      sheet.castShadow = true;
      sheet.receiveShadow = true;
      addOutline(sheet, 0.65);
      root.add(sheet);
      sheets.push(sheet);
    });

    const docTex = cachedTexture('doc-lines', 360, 500, (ctx, w, h) => {
      ctx.fillStyle = '#f4ead5';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#9f3529';
      ctx.font = '500 11px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('CONFIDENTIAL / FINANCE', 24, 34);
      ctx.strokeStyle = 'rgba(105,78,43,.36)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 17; i++) {
        ctx.beginPath();
        ctx.moveTo(24, 70 + i * 23);
        ctx.lineTo(i % 4 === 3 ? 230 : w - 30, 70 + i * 23);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(159,53,41,.85)';
      ctx.font = '700 23px "IBM Plex Mono", monospace';
      ctx.save();
      ctx.translate(w / 2, h - 74);
      ctx.rotate(-0.08);
      ctx.textAlign = 'center';
      ctx.fillText('AES-256 LOCKED', 0, 0);
      ctx.restore();
    });
    const docMat = new THREE.MeshBasicMaterial({
      map: docTex,
      transparent: true,
      opacity: 1,
      toneMapped: false,
    });
    const doc = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.92), docMat);
    doc.position.set(-0.03, 0.6, 0.12);
    doc.rotation.y = -0.06;
    root.add(doc);

    let active = false;
    function activate(instant = false) {
      active = true;
      sheetMats.forEach((mat, i) => {
        if (instant) {
          mat.color.set(0x8f5d42);
          mat.emissive.set(accent);
          mat.emissiveIntensity = 0.28;
        } else {
          gsap.to(mat.color, {
            r: 0.56,
            g: 0.36,
            b: 0.26,
            duration: 0.6 + i * 0.07,
            ease: 'power2.out',
          });
          gsap.to(mat.emissive, {
            r: accent.r,
            g: accent.g,
            b: accent.b,
            duration: 0.6 + i * 0.07,
            onStart: () => {
              mat.emissiveIntensity = 0.32;
            },
          });
        }
      });
      sheets.forEach((sheet, i) => {
        const targetZ = i % 2 ? -0.1 + i * 0.02 : 0.04 + i * 0.02;
        if (instant) {
          sheet.rotation.z = targetZ;
        } else {
          gsap.to(sheet.rotation, {
            z: targetZ,
            duration: 0.55,
            delay: i * 0.05,
            ease: 'back.out(1.6)',
          });
          gsap.to(sheet.position, {
            y: 0.59,
            duration: 0.4,
            delay: i * 0.05,
            yoyo: true,
            repeat: 1,
            ease: 'power2.out',
          });
        }
      });
      if (!instant) {
        gsap.to(docMat, { opacity: 0.62, duration: 0.7 });
      }
    }
    function update(_dt: number, time: number) {
      if (!active) return;
      sheetMats.forEach((mat, i) => {
        mat.emissiveIntensity = 0.22 + 0.08 * Math.sin(time * 2.2 + i);
      });
    }

    return { group, tagY: 1.42, activate, update };
  }

  function buildLock(_def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    const accent = new THREE.Color(spread.scene.accent);
    const group = new THREE.Group();
    const root = new THREE.Group();
    group.add(root);
    const cream = lighten(accent, 0.8).getHex();
    const metal = new THREE.MeshStandardMaterial({
      color: 0x8b7553,
      roughness: 0.28,
      metalness: 0.78,
    });

    const bodyMat = paperMaterial(cream, { emissive: accent, emissiveIntensity: 0 });
    const body = new THREE.Mesh(extrude(rounded(0.64, 0.58, 0.09), 0.135, 0.01), bodyMat);
    body.position.y = 0.42;
    body.castShadow = true;
    body.receiveShadow = true;
    addOutline(body, 0.85);
    root.add(body);

    const shackleGroup = new THREE.Group();
    shackleGroup.position.y = 0.7;
    root.add(shackleGroup);
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.04, 8, 32, Math.PI), metal);
    arc.castShadow = true;
    shackleGroup.add(arc);
    [-1, 1].forEach((s) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.2, 8), metal);
      leg.position.set(s * 0.235, -0.1, 0);
      leg.castShadow = true;
      shackleGroup.add(leg);
    });

    const keyMat = new THREE.MeshStandardMaterial({
      color: 0x3b2c22,
      emissive: accent,
      emissiveIntensity: 0,
      roughness: 0.75,
    });
    const keyhole = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 6, 24), keyMat);
    keyhole.position.set(0, 0.47, 0.075);
    root.add(keyhole);
    const keyStem = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.11, 0.024), keyMat);
    keyStem.position.set(0, 0.36, 0.075);
    root.add(keyStem);

    const seal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.03, 16),
      new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.2, roughness: 0.6 }),
    );
    seal.rotation.x = Math.PI / 2;
    seal.position.set(0.21, 0.18, 0.078);
    root.add(seal);

    // Cipher encryption meter column
    const cipherBarMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.15,
      roughness: 0.35,
    });
    const cipherBar = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.045, 0.025), cipherBarMat);
    cipherBar.geometry.translate(0.23, 0, 0);
    cipherBar.position.set(-0.23, 0.18, 0.074);
    cipherBar.scale.x = 0.12;
    root.add(cipherBar);

    let active = false;
    function activate(instant = false) {
      active = true;
      if (instant) {
        bodyMat.emissiveIntensity = 0.5;
        keyMat.emissiveIntensity = 0.9;
        cipherBar.scale.x = 1;
        cipherBarMat.emissiveIntensity = 0.95;
        shackleGroup.rotation.z = 0;
        return;
      }
      gsap.to(bodyMat, { emissiveIntensity: 0.58, duration: 0.45 });
      gsap.to(keyMat, { emissiveIntensity: 1.0, duration: 0.4 });
      gsap.to(cipherBar.scale, { x: 1, duration: 0.85, ease: 'power3.out' });
      gsap.to(cipherBarMat, { emissiveIntensity: 1.0, duration: 0.5 });
      gsap.to(shackleGroup.rotation, {
        z: -0.34,
        duration: 0.16,
        ease: 'power2.out',
        onComplete: () => {
          gsap.to(shackleGroup.rotation, { z: 0, duration: 0.42, ease: 'back.out(3)' });
        },
      });
      gsap.fromTo(
        root.rotation,
        { z: -0.035 },
        {
          z: 0.035,
          duration: 0.055,
          yoyo: true,
          repeat: 7,
          onComplete: () => {
            root.rotation.z = 0;
          },
        },
      );
      gsap.fromTo(
        root.position,
        { y: 0 },
        {
          y: 0.06,
          duration: 0.3,
          yoyo: true,
          repeat: 1,
          ease: 'power2.out',
          onComplete: () => {
            root.position.y = 0;
          },
        },
      );
    }
    function update(_dt: number, time: number) {
      if (!active) return;
      bodyMat.emissiveIntensity = 0.42 + 0.14 * Math.sin(time * 3);
      keyMat.emissiveIntensity = 0.72 + 0.24 * Math.sin(time * 3.4);
      cipherBarMat.emissiveIntensity = 0.78 + 0.25 * Math.sin(time * 4);
    }

    return { group, tagY: 1.3, activate, update };
  }

  function buildNote(_def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    const accent = new THREE.Color(spread.scene.accent);
    const group = new THREE.Group();
    const root = new THREE.Group();
    root.rotation.x = -0.08;
    group.add(root);

    const geo = new THREE.PlaneGeometry(0.94, 1.2, 14, 14);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      pos.setZ(i, Math.sin((x / 0.94 + 0.5) * Math.PI) * 0.035 + Math.cos(y * 2.4) * 0.012);
    }
    geo.computeVertexNormals();
    const noteMat = new THREE.MeshStandardMaterial({
      map: noteTexture(),
      transparent: true,
      alphaTest: 0.03,
      roughness: 0.9,
      emissive: accent,
      emissiveIntensity: 0,
      side: THREE.DoubleSide,
    });
    const note = new THREE.Mesh(geo, noteMat);
    note.position.y = 0.66;
    note.castShadow = true;
    root.add(note);

    const sealMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.1,
      roughness: 0.55,
    });
    const seal = new THREE.Mesh(new THREE.CylinderGeometry(0.083, 0.09, 0.035, 18), sealMat);
    seal.rotation.x = Math.PI / 2;
    seal.position.set(0.29, 0.16, 0.07);
    root.add(seal);

    const clip = new THREE.Mesh(
      new THREE.TorusGeometry(0.07, 0.012, 6, 20, Math.PI * 1.5),
      new THREE.MeshStandardMaterial({ color: 0x6b7780, metalness: 0.8, roughness: 0.25 }),
    );
    clip.position.set(-0.34, 1.21, 0.03);
    clip.rotation.z = -0.6;
    root.add(clip);

    let active = false;
    function activate(instant = false) {
      active = true;
      if (instant) {
        noteMat.emissiveIntensity = 0.24;
        sealMat.emissiveIntensity = 0.75;
        root.rotation.x = 0.04;
        return;
      }
      gsap.to(noteMat, { emissiveIntensity: 0.3, duration: 0.5 });
      gsap.to(sealMat, { emissiveIntensity: 0.85, duration: 0.5 });
      gsap.fromTo(root.rotation, { x: -0.08 }, { x: 0.07, duration: 0.75, ease: 'power3.out' });
      gsap.fromTo(note.scale, { x: 1, y: 1, z: 1 }, { x: 1.03, y: 1.03, z: 1.03, duration: 0.3, yoyo: true, repeat: 1 });
      gsap.fromTo(
        seal.scale,
        { x: 1, y: 1, z: 1 },
        { x: 1.2, y: 1.2, z: 1.2, duration: 0.35, yoyo: true, repeat: 1, ease: 'power2.out' },
      );
    }
    function update(_dt: number, time: number) {
      if (!active) return;
      noteMat.emissiveIntensity = 0.2 + 0.08 * Math.sin(time * 2);
      sealMat.emissiveIntensity = 0.6 + 0.2 * Math.sin(time * 3);
      root.rotation.z = Math.sin(time * 0.8) * 0.008;
    }

    return { group, tagY: 1.58, activate, update };
  }

  /* ------------------------------------------------------------------ */
  /* Shared Stepped 3D Paper-Craft Pedestal Base                        */
  /* ------------------------------------------------------------------ */
  function buildPedestal(
    parent: THREE.Group,
    accent: THREE.Color,
    radius = 0.62,
  ): THREE.MeshStandardMaterial {
    const baseRim = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.04, radius * 1.1, 0.042, 16),
      new THREE.MeshStandardMaterial({ color: 0x35291c, roughness: 0.85, metalness: 0.08 }),
    );
    baseRim.position.y = 0.021;
    baseRim.castShadow = true;
    baseRim.receiveShadow = true;
    addOutline(baseRim, 0.9);
    parent.add(baseRim);

    const stageDeck = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.92, radius * 1.01, 0.056, 16),
      paperMaterial(lighten(accent, 0.78).getHex()),
    );
    stageDeck.position.y = 0.048;
    stageDeck.castShadow = true;
    stageDeck.receiveShadow = true;
    addOutline(stageDeck, 0.86);
    parent.add(stageDeck);

    const statusRingMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.28,
      roughness: 0.42,
      metalness: 0.25,
    });
    const statusRing = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 0.95, 0.019, 8, 32),
      statusRingMat,
    );
    statusRing.rotation.x = Math.PI / 2;
    statusRing.position.y = 0.077;
    parent.add(statusRing);

    return statusRingMat;
  }

  /* ------------------------------------------------------------------ */
  /* 03 — Phishing envelope, badge, USB bait (Solid 3D Architecture)    */
  /* ------------------------------------------------------------------ */
  function buildPhish(_def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    const accent = new THREE.Color(spread.scene.accent);
    const group = new THREE.Group();
    const root = new THREE.Group();
    group.add(root);

    const cream = lighten(accent, 0.84).getHex();
    const flapColor = lighten(accent, 0.64).getHex();
    const trimColor = lighten(accent, 0.42).getHex();
    const statusRingMat = buildPedestal(root, accent, 0.64);

    // Solid 3D envelope body with real thickness
    const bodyMat = paperMaterial(cream, { emissive: accent, emissiveIntensity: 0.04 });
    const envelopeBox = new THREE.Mesh(extrude(rounded(1.08, 0.72, 0.035), 0.13, 0.008), bodyMat);
    envelopeBox.position.set(0, 0.44, 0);
    envelopeBox.castShadow = true;
    envelopeBox.receiveShadow = true;
    addOutline(envelopeBox, 0.9);
    root.add(envelopeBox);

    // Stepped 3D side & front pocket folds (real extruded thickness, zero flat planes)
    const leftShape = new THREE.Shape();
    leftShape.moveTo(-0.52, 0.78);
    leftShape.lineTo(-0.52, 0.1);
    leftShape.lineTo(0.02, 0.4);
    leftShape.closePath();
    const leftFlap = new THREE.Mesh(extrude(leftShape, 0.028, 0.004), paperMaterial(flapColor));
    leftFlap.position.z = 0.072;
    leftFlap.castShadow = true;
    addOutline(leftFlap, 0.86);
    root.add(leftFlap);

    const rightShape = new THREE.Shape();
    rightShape.moveTo(0.52, 0.78);
    rightShape.lineTo(0.52, 0.1);
    rightShape.lineTo(-0.02, 0.4);
    rightShape.closePath();
    const rightFlap = new THREE.Mesh(extrude(rightShape, 0.028, 0.004), paperMaterial(flapColor));
    rightFlap.position.z = 0.076;
    rightFlap.castShadow = true;
    addOutline(rightFlap, 0.86);
    root.add(rightFlap);

    const bottomShape = new THREE.Shape();
    bottomShape.moveTo(-0.52, 0.1);
    bottomShape.lineTo(0.52, 0.1);
    bottomShape.lineTo(0, 0.44);
    bottomShape.closePath();
    const bottomFlap = new THREE.Mesh(extrude(bottomShape, 0.032, 0.004), paperMaterial(cream));
    bottomFlap.position.z = 0.088;
    bottomFlap.castShadow = true;
    addOutline(bottomFlap, 0.88);
    root.add(bottomFlap);

    // 3D Crimson Wax Warning Seal on front pocket
    const sealMat = new THREE.MeshStandardMaterial({
      color: 0xb2362a,
      emissive: 0xd84636,
      emissiveIntensity: 0.25,
      roughness: 0.45,
      metalness: 0.15,
    });
    const waxSeal = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.125, 0.042, 18), sealMat);
    waxSeal.rotation.x = Math.PI / 2;
    waxSeal.position.set(0, 0.36, 0.112);
    waxSeal.castShadow = true;
    addOutline(waxSeal, 0.85);
    root.add(waxSeal);

    // Thickened 3D Phishing Letter Card emerging from the envelope
    const letterGroup = new THREE.Group();
    letterGroup.position.set(0, 0.62, 0.028);
    root.add(letterGroup);

    const letterCardMat = paperMaterial(0xfff7e4, { emissive: accent, emissiveIntensity: 0.05 });
    const letterSlab = new THREE.Mesh(extrude(rounded(0.84, 0.58, 0.02), 0.028, 0.004), letterCardMat);
    letterSlab.castShadow = true;
    addOutline(letterSlab, 0.88);
    letterGroup.add(letterSlab);

    const letterFront = textPlane(letterTexture(), 0.8, 0.54, { transparent: false });
    letterFront.position.z = 0.017;
    letterGroup.add(letterFront);

    const letterBack = new THREE.Mesh(
      new THREE.PlaneGeometry(0.76, 0.5),
      new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.78 }),
    );
    letterBack.position.z = -0.017;
    letterBack.rotation.y = Math.PI;
    letterGroup.add(letterBack);

    // Thick 3D Top Triangular Flap
    const topShape = new THREE.Shape();
    topShape.moveTo(-0.52, 0);
    topShape.lineTo(0.52, 0);
    topShape.lineTo(0, -0.54);
    topShape.closePath();
    const topGroup = new THREE.Group();
    topGroup.position.set(0, 0.79, -0.04);
    topGroup.rotation.x = 2.15;
    const topFlap = new THREE.Mesh(extrude(topShape, 0.026, 0.004), paperMaterial(flapColor));
    topFlap.castShadow = true;
    addOutline(topFlap, 0.88);
    topGroup.add(topFlap);
    root.add(topGroup);

    // Raised 3D Stamp Block
    const stamp = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.19, 0.028),
      new THREE.MeshStandardMaterial({ color: accent, roughness: 0.55 }),
    );
    stamp.position.set(-0.36, 0.67, 0.095);
    addOutline(stamp, 0.82);
    root.add(stamp);

    // Heavy 3D Metallic Phishing Hook & Glowing Lure Bobber
    const hookGroup = new THREE.Group();
    hookGroup.position.set(0.22, 1.56, 0.14);
    root.add(hookGroup);

    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.015, 0.015, 0.54, 8),
      new THREE.MeshStandardMaterial({ color: 0x4b3b28, roughness: 0.7 }),
    );
    cord.position.y = 0.27;
    hookGroup.add(cord);

    const lureBobberMat = new THREE.MeshStandardMaterial({
      color: 0xd94836,
      emissive: 0xff5a42,
      emissiveIntensity: 0.35,
      roughness: 0.3,
      metalness: 0.3,
    });
    const lureBobber = new THREE.Mesh(new THREE.SphereGeometry(0.072, 14, 14), lureBobberMat);
    lureBobber.position.y = 0.14;
    lureBobber.castShadow = true;
    addOutline(lureBobber, 0.8);
    hookGroup.add(lureBobber);

    const hookMat = new THREE.MeshStandardMaterial({
      color: 0xc5a86b,
      metalness: 0.78,
      roughness: 0.24,
      emissive: accent,
      emissiveIntensity: 0.2,
    });
    const hookArc = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.036, 10, 32, Math.PI * 1.38), hookMat);
    hookArc.rotation.z = 0.52;
    hookArc.position.y = -0.05;
    hookArc.castShadow = true;
    addOutline(hookArc, 0.82);
    hookGroup.add(hookArc);

    const barb = new THREE.Mesh(new THREE.ConeGeometry(0.068, 0.17, 6), hookMat);
    barb.position.set(-0.17, -0.17, 0);
    barb.rotation.z = -2.45;
    barb.castShadow = true;
    hookGroup.add(barb);

    let active = false;
    function activate(instant = false) {
      active = true;
      if (instant) {
        letterGroup.position.y = 1.15;
        letterGroup.rotation.x = -0.22;
        hookGroup.position.y = 1.42;
        hookMat.emissiveIntensity = 0.9;
        lureBobberMat.emissiveIntensity = 1.0;
        statusRingMat.emissiveIntensity = 1.0;
        sealMat.emissiveIntensity = 0.85;
        topGroup.rotation.x = 1.92;
        return;
      }
      gsap.to(letterGroup.position, { y: 1.15, duration: 0.82, ease: 'power3.out' });
      gsap.to(letterGroup.rotation, { x: -0.22, duration: 0.82, ease: 'power3.out' });
      gsap.to(topGroup.rotation, { x: 1.92, duration: 0.52, ease: 'power2.out' });
      gsap.to(hookGroup.position, { y: 1.42, duration: 0.55, ease: 'back.out(1.7)' });
      gsap.to(hookMat, { emissiveIntensity: 0.95, duration: 0.5 });
      gsap.to(lureBobberMat, { emissiveIntensity: 1.15, duration: 0.45 });
      gsap.to(statusRingMat, { emissiveIntensity: 1.1, duration: 0.5 });
      gsap.to(sealMat, { emissiveIntensity: 0.9, duration: 0.5 });
      gsap.fromTo(
        hookGroup.rotation,
        { z: -0.14 },
        { z: 0.16, duration: 1.0, ease: 'sine.inOut', yoyo: true, repeat: 1 },
      );
      gsap.fromTo(
        root.rotation,
        { z: -0.02 },
        {
          z: 0.02,
          duration: 0.06,
          yoyo: true,
          repeat: 5,
          onComplete: () => {
            root.rotation.z = 0;
          },
        },
      );
    }
    function update(_dt: number, time: number) {
      if (!active) return;
      hookGroup.rotation.z = Math.sin(time * 1.5) * 0.09;
      hookMat.emissiveIntensity = 0.65 + 0.3 * Math.sin(time * 2.4);
      lureBobberMat.emissiveIntensity = 0.8 + 0.35 * Math.sin(time * 3.2);
      statusRingMat.emissiveIntensity = 0.75 + 0.3 * Math.sin(time * 2.5);
      letterGroup.position.y = 1.15 + Math.sin(time * 1.3) * 0.022;
    }

    return { group, tagY: 1.98, activate, update };
  }

  function buildBadge(_def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    const accent = new THREE.Color(spread.scene.accent);
    const group = new THREE.Group();
    const root = new THREE.Group();
    root.rotation.y = -0.1;
    group.add(root);

    const cream = lighten(accent, 0.84).getHex();
    const bezelHex = lighten(accent, 0.52).getHex();
    const statusRingMat = buildPedestal(root, accent, 0.62);

    // Solid 3D Tabletop Kiosk Gantry Pillars + Scanner Cradle Base
    const pillarMat = paperMaterial(bezelHex);
    const leftPost = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.58, 0.12), pillarMat);
    leftPost.position.set(-0.46, 0.82, -0.04);
    leftPost.castShadow = true;
    addOutline(leftPost, 0.88);
    root.add(leftPost);

    const rightPost = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.58, 0.12), pillarMat);
    rightPost.position.set(0.46, 0.82, -0.04);
    rightPost.castShadow = true;
    addOutline(rightPost, 0.88);
    root.add(rightPost);

    const topCrossbar = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.09, 0.14), pillarMat);
    topCrossbar.position.set(0, 1.62, -0.04);
    topCrossbar.castShadow = true;
    addOutline(topCrossbar, 0.9);
    root.add(topCrossbar);

    const cordMat = new THREE.MeshStandardMaterial({ color: 0x3b2f21, roughness: 0.7 });
    root.add(barBetween(new THREE.Vector3(-0.24, 1.6, -0.03), new THREE.Vector3(0, 1.3, -0.01), 0.02, cordMat));
    root.add(barBetween(new THREE.Vector3(0.24, 1.6, -0.03), new THREE.Vector3(0, 1.3, -0.01), 0.02, cordMat));

    const clip = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.11, 0.06),
      new THREE.MeshStandardMaterial({ color: 0xb6a479, metalness: 0.78, roughness: 0.25 }),
    );
    clip.position.set(0, 1.28, 0);
    clip.castShadow = true;
    addOutline(clip, 0.85);
    root.add(clip);

    // Thick Dual-Bevel 3D Identity Badge Housing
    const cardGroup = new THREE.Group();
    cardGroup.position.set(0, 0.74, 0);
    root.add(cardGroup);

    const cardMat = paperMaterial(cream, { emissive: accent, emissiveIntensity: 0.05 });
    const card = new THREE.Mesh(extrude(rounded(0.84, 1.12, 0.05), 0.095, 0.008), cardMat);
    card.castShadow = true;
    card.receiveShadow = true;
    addOutline(card, 0.9);
    cardGroup.add(card);

    const front = textPlane(badgeFrontTexture(), 0.78, 1.04);
    front.position.z = 0.052;
    cardGroup.add(front);

    const back = textPlane(badgeBackTexture(), 0.78, 1.04);
    back.position.z = -0.052;
    back.rotation.y = Math.PI;
    cardGroup.add(back);

    // 3D Crimson SPOOFED Emblem on the Back Face (pops when flipped 180 deg)
    const spoofPrismMat = new THREE.MeshStandardMaterial({
      color: 0xb83529,
      emissive: 0xd94436,
      emissiveIntensity: 0.35,
      roughness: 0.35,
      metalness: 0.2,
    });
    const spoofDiamond = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), spoofPrismMat);
    spoofDiamond.position.set(0, 0.34, -0.085);
    spoofDiamond.castShadow = true;
    addOutline(spoofDiamond, 0.85);
    cardGroup.add(spoofDiamond);

    const hole = new THREE.Mesh(
      new THREE.TorusGeometry(0.036, 0.011, 8, 20),
      new THREE.MeshStandardMaterial({ color: 0x3b2f21, roughness: 0.7 }),
    );
    hole.position.set(0, 0.51, 0.055);
    cardGroup.add(hole);

    let active = false;
    function activate(instant = false) {
      active = true;
      if (instant) {
        cardGroup.rotation.y = Math.PI;
        cardMat.emissiveIntensity = 0.25;
        spoofPrismMat.emissiveIntensity = 1.05;
        statusRingMat.emissiveIntensity = 1.05;
        return;
      }
      gsap.to(cardGroup.rotation, { y: Math.PI, duration: 0.92, ease: 'back.inOut(1.45)' });
      gsap.to(cardMat, { emissiveIntensity: 0.32, duration: 0.6 });
      gsap.to(spoofPrismMat, { emissiveIntensity: 1.15, duration: 0.55 });
      gsap.to(statusRingMat, { emissiveIntensity: 1.1, duration: 0.55 });
      gsap.fromTo(
        cardGroup.position,
        { y: 0.74 },
        { y: 0.84, duration: 0.36, yoyo: true, repeat: 1, ease: 'power2.out' },
      );
    }
    function update(dt: number, time: number) {
      spoofDiamond.rotation.y += dt * 1.4;
      if (!active) return;
      cardMat.emissiveIntensity = 0.22 + 0.09 * Math.sin(time * 2.4);
      spoofPrismMat.emissiveIntensity = 0.85 + 0.35 * Math.sin(time * 3.1);
      statusRingMat.emissiveIntensity = 0.8 + 0.28 * Math.sin(time * 2.5);
      root.rotation.z = Math.sin(time * 0.8) * 0.008;
    }

    return { group, tagY: 1.88, activate, update };
  }

  function buildUsb(_def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    const accent = new THREE.Color(spread.scene.accent);
    const group = new THREE.Group();
    const root = new THREE.Group();
    root.rotation.y = 0.24;
    group.add(root);

    const cream = lighten(accent, 0.76).getHex();
    const darkTrim = 0x3b2f22;
    const statusRingMat = buildPedestal(root, accent, 0.64);

    const metal = new THREE.MeshStandardMaterial({
      color: 0xc5b27f,
      roughness: 0.22,
      metalness: 0.85,
      emissive: accent,
      emissiveIntensity: 0.15,
    });

    // Twin Solid 3D Extruded Cradle Supports holding the USB Drive above the pedestal
    const cradleMat = paperMaterial(lighten(accent, 0.62).getHex());
    [-0.22, 0.22].forEach((x) => {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.34, 0.24), cradleMat);
      pier.position.set(x, 0.22, 0);
      pier.castShadow = true;
      addOutline(pier, 0.88);
      root.add(pier);
    });

    // Chunky 3D Ruggedized USB Body (high volume + thick bezel)
    const bodyMat = paperMaterial(cream, { emissive: accent, emissiveIntensity: 0.08 });
    const body = new THREE.Mesh(extrude(rounded(1.0, 0.34, 0.06), 0.21, 0.012), bodyMat);
    body.position.set(-0.04, 0.44, 0);
    body.castShadow = true;
    body.receiveShadow = true;
    addOutline(body, 0.9);
    root.add(body);

    // Top Glowing Malware Core Strip embedded in the USB spine
    const coreMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.45,
      roughness: 0.3,
    });
    const coreStrip = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.045, 0.12), coreMat);
    coreStrip.position.set(-0.04, 0.62, 0);
    addOutline(coreStrip, 0.82);
    root.add(coreStrip);

    // Heavy Metallic USB-A Connector Plug
    const connector = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.19, 0.125), metal);
    connector.position.set(0.6, 0.44, 0);
    connector.castShadow = true;
    addOutline(connector, 0.86);
    root.add(connector);

    for (let i = 0; i < 4; i++) {
      const contact = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.02, 0.02),
        new THREE.MeshStandardMaterial({ color: 0x5c4724, roughness: 0.35, metalness: 0.72 }),
      );
      contact.position.set(0.62, 0.38 + i * 0.038, 0.066);
      root.add(contact);
    }

    // Detached 3D USB Protective Cap resting on the front of the pedestal
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.14, 0.22),
      new THREE.MeshStandardMaterial({ color: lighten(accent, 0.48).getHex(), roughness: 0.65 }),
    );
    cap.position.set(-0.24, 0.13, 0.26);
    cap.rotation.y = 0.45;
    cap.castShadow = true;
    addOutline(cap, 0.86);
    root.add(cap);

    // Always-Visible 3D AUTORUN Warning Pennant Flag atop the USB Drive
    const flagGroup = new THREE.Group();
    flagGroup.position.set(0.02, 0.6, 0);
    flagGroup.scale.setScalar(0.84);
    root.add(flagGroup);

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.016, 0.02, 0.64, 8),
      new THREE.MeshStandardMaterial({ color: darkTrim, roughness: 0.65 }),
    );
    pole.position.y = 0.32;
    pole.castShadow = true;
    flagGroup.add(pole);

    const flagSlab = new THREE.Mesh(
      extrude(rounded(0.5, 0.28, 0.02), 0.032, 0.004),
      paperMaterial(0xf7ebd2),
    );
    flagSlab.position.set(0.24, 0.48, 0);
    flagSlab.castShadow = true;
    addOutline(flagSlab, 0.9);
    flagGroup.add(flagSlab);

    const flagFront = textPlane(usbFlagTexture(), 0.47, 0.25);
    flagFront.position.set(0.24, 0.48, 0.02);
    flagGroup.add(flagFront);

    const flagBack = textPlane(usbFlagTexture(), 0.47, 0.25);
    flagBack.position.set(0.24, 0.48, -0.02);
    flagBack.rotation.y = Math.PI;
    flagGroup.add(flagBack);

    const glow = glowSprite(accent, 0.95);
    glow.position.set(0.68, 0.44, 0);
    root.add(glow);

    let active = false;
    function activate(instant = false) {
      active = true;
      if (instant) {
        connector.position.x = 0.72;
        metal.emissiveIntensity = 0.95;
        coreMat.emissiveIntensity = 1.25;
        statusRingMat.emissiveIntensity = 1.1;
        flagGroup.scale.setScalar(1.06);
        glow.material.opacity = 0.42;
        bodyMat.emissiveIntensity = 0.28;
        return;
      }
      gsap.to(connector.position, { x: 0.72, duration: 0.45, ease: 'back.out(2)' });
      gsap.to(metal, { emissiveIntensity: 1.0, duration: 0.45 });
      gsap.to(coreMat, { emissiveIntensity: 1.35, duration: 0.45 });
      gsap.to(statusRingMat, { emissiveIntensity: 1.15, duration: 0.45 });
      gsap.to(bodyMat, { emissiveIntensity: 0.32, duration: 0.5 });
      gsap.to(flagGroup.scale, { x: 1.06, y: 1.06, z: 1.06, duration: 0.55, ease: 'back.out(2.1)' });
      gsap.fromTo(glow.material, { opacity: 0.1 }, { opacity: 0.48, duration: 0.45, yoyo: true, repeat: 1 });
    }
    function update(_dt: number, time: number) {
      flagGroup.rotation.y = Math.sin(time * 1.4) * 0.08;
      if (!active) return;
      metal.emissiveIntensity = 0.7 + 0.25 * Math.sin(time * 3);
      coreMat.emissiveIntensity = 0.95 + 0.4 * Math.sin(time * 3.8);
      statusRingMat.emissiveIntensity = 0.8 + 0.3 * Math.sin(time * 2.6);
      glow.material.opacity = 0.24 + 0.14 * Math.sin(time * 2.4);
      bodyMat.emissiveIntensity = 0.22 + 0.09 * Math.sin(time * 2.1);
    }

    return { group, tagY: 1.42, activate, update };
  }

  /* ------------------------------------------------------------------ */
  /* 04 — Botnet, request viaduct bridge, server mainframe (Solid 3D)   */
  /* ------------------------------------------------------------------ */
  function buildBotnet(_def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    const accent = new THREE.Color(spread.scene.accent);
    const group = new THREE.Group();
    const root = new THREE.Group();
    group.add(root);

    const cream = lighten(accent, 0.8).getHex();
    const statusRingMat = buildPedestal(root, accent, 0.72);
    const stemMat = paperMaterial(lighten(accent, 0.58).getHex());
    const ledMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.4,
      roughness: 0.45,
    });
    const screenMaterials: THREE.MeshStandardMaterial[] = [];

    const devices: [number, number, number][] = [
      [-0.64, 0.42, 0.18],
      [-0.34, 0.56, 0.44],
      [0.0, 0.48, 0.3],
      [0.34, 0.58, 0.44],
      [0.64, 0.42, 0.16],
    ];
    const tops: THREE.Vector3[] = [];

    devices.forEach(([x, h, z]) => {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.055, 16), paperMaterial(cream));
      base.position.set(x, 0.08, z);
      base.castShadow = true;
      addOutline(base, 0.85);
      root.add(base);

      const top = new THREE.Vector3(x, h, z);
      root.add(barBetween(new THREE.Vector3(x, 0.1, z), new THREE.Vector3(x, h - 0.1, z), 0.022, stemMat));
      tops.push(top);

      const monitor = new THREE.Group();
      monitor.position.copy(top);
      monitor.rotation.y = -x * 0.45;
      const shellMat = paperMaterial(cream, { emissive: accent, emissiveIntensity: 0.06 });
      const shell = new THREE.Mesh(extrude(rounded(0.38, 0.27, 0.03), 0.08, 0.006), shellMat);
      shell.castShadow = true;
      shell.receiveShadow = true;
      addOutline(shell, 0.88);
      monitor.add(shell);

      const screenMat = new THREE.MeshStandardMaterial({
        color: 0x1e2c24,
        roughness: 0.4,
        emissive: accent,
        emissiveIntensity: 0.28,
      });
      screenMaterials.push(screenMat);
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.31, 0.2), screenMat);
      pane.position.z = 0.044;
      monitor.add(pane);

      const led = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 10), ledMat);
      led.position.set(0.13, -0.09, 0.052);
      monitor.add(led);
      root.add(monitor);
    });

    // Central Fluted Tower & Rotating Gyroscope Botnet Hub
    root.add(barBetween(new THREE.Vector3(0, 0.08, -0.18), new THREE.Vector3(0, 1.08, -0.18), 0.036, stemMat));

    const hubMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.42,
      roughness: 0.35,
      metalness: 0.25,
    });
    const hub = new THREE.Mesh(new THREE.OctahedronGeometry(0.17, 0), hubMat);
    hub.position.set(0, 1.12, -0.18);
    hub.castShadow = true;
    addOutline(hub, 0.88);
    root.add(hub);

    const gyroMat = new THREE.MeshStandardMaterial({
      color: 0xd4b16a,
      emissive: accent,
      emissiveIntensity: 0.2,
      metalness: 0.72,
      roughness: 0.28,
    });
    const gyroRing = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.018, 8, 28), gyroMat);
    gyroRing.position.copy(hub.position);
    gyroRing.rotation.x = 0.45;
    root.add(gyroRing);

    // Always-Visible 3D Data Conduits & Animated Packet Pulses
    const linkMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.32,
      roughness: 0.45,
    });
    const pulses: { mesh: THREE.Mesh; to: THREE.Vector3 }[] = [];
    tops.forEach((top) => {
      root.add(barBetween(top, hub.position, 0.02, linkMat));
      const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.042, 10, 10), ledMat);
      root.add(pulse);
      pulses.push({ mesh: pulse, to: top });
    });

    let active = false;
    function activate(instant = false) {
      active = true;
      if (instant) {
        linkMat.emissiveIntensity = 0.95;
        ledMat.emissiveIntensity = 1.2;
        hubMat.emissiveIntensity = 1.1;
        statusRingMat.emissiveIntensity = 1.1;
        screenMaterials.forEach((m) => {
          m.emissiveIntensity = 0.72;
          m.color.set(0x281611);
        });
        return;
      }
      gsap.to(linkMat, { emissiveIntensity: 1.0, duration: 0.65 });
      gsap.to(ledMat, { emissiveIntensity: 1.25, duration: 0.5 });
      gsap.to(hubMat, { emissiveIntensity: 1.15, duration: 0.5 });
      gsap.to(statusRingMat, { emissiveIntensity: 1.1, duration: 0.5 });
      screenMaterials.forEach((m, i) => {
        gsap.to(m, { emissiveIntensity: 0.75, duration: 0.45, delay: i * 0.08 });
        gsap.to(m.color, { r: 0.16, g: 0.09, b: 0.07, duration: 0.55, delay: i * 0.08 });
      });
      gsap.fromTo(
        hub.scale,
        { x: 1, y: 1, z: 1 },
        { x: 1.38, y: 1.38, z: 1.38, duration: 0.38, yoyo: true, repeat: 1, ease: 'power2.out' },
      );
    }
    function update(dt: number, time: number) {
      const rate = active ? 0.95 : 0.35;
      pulses.forEach(({ mesh, to }, i) => {
        const t = (time * rate + i * 0.21) % 1;
        mesh.position.lerpVectors(hub.position, to, t);
      });
      hub.rotation.y += dt * (active ? 1.1 : 0.45);
      gyroRing.rotation.z += dt * (active ? 0.9 : 0.35);
      if (!active) return;
      ledMat.emissiveIntensity = 0.75 + 0.45 * Math.sin(time * 4.2);
      screenMaterials.forEach((m, i) => {
        m.emissiveIntensity = 0.52 + 0.25 * Math.sin(time * 3.2 + i * 1.7);
      });
      hub.rotation.x = Math.sin(time * 0.9) * 0.18;
      statusRingMat.emissiveIntensity = 0.8 + 0.3 * Math.sin(time * 2.5);
    }

    return { group, tagY: 1.56, activate, update };
  }

  function buildFlow(_def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    const accent = new THREE.Color(spread.scene.accent);
    const group = new THREE.Group();
    const root = new THREE.Group();
    group.add(root);

    const cream = lighten(accent, 0.78).getHex();
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.86, 0.34, 0.16),
      new THREE.Vector3(-0.42, 0.84, 0.1),
      new THREE.Vector3(0.05, 1.12, -0.06),
      new THREE.Vector3(0.52, 0.86, -0.16),
      new THREE.Vector3(0.86, 0.56, -0.02),
    ]);

    // Twin Solid 3D Bridge Piers & Support Pillars anchoring the viaduct to the page
    const pierMat = paperMaterial(cream);
    const archAnchors: [number, number, number][] = [
      [-0.86, 0.34, 0.16],
      [-0.42, 0.84, 0.1],
      [0.05, 1.12, -0.06],
      [0.52, 0.86, -0.16],
      [0.86, 0.56, -0.02],
    ];
    archAnchors.forEach(([x, y, z], idx) => {
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.06, 12), pierMat);
      foot.position.set(x, 0.03, z);
      foot.castShadow = true;
      foot.receiveShadow = true;
      addOutline(foot, 0.86);
      root.add(foot);

      const radius = idx === 0 || idx === archAnchors.length - 1 ? 0.044 : 0.026;
      const column = barBetween(new THREE.Vector3(x, 0.05, z), new THREE.Vector3(x, y, z), radius, pierMat);
      addOutline(column, 0.84);
      root.add(column);
    });

    // Solid 3D Extruded Arch Viaduct Span
    const spanMat = new THREE.MeshStandardMaterial({
      color: lighten(accent, 0.35).getHex(),
      emissive: accent,
      emissiveIntensity: 0.25,
      roughness: 0.55,
      metalness: 0.12,
    });
    const spanTube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.055, 10, false), spanMat);
    spanTube.castShadow = true;
    spanTube.receiveShadow = true;
    addOutline(spanTube, 0.86);
    root.add(spanTube);

    // 11 High-Contrast 3D Volumetric Request Chevrons racing across the bridge
    const chevronMat = new THREE.MeshStandardMaterial({
      color: 0xffd185,
      emissive: accent,
      emissiveIntensity: 0.45,
      roughness: 0.42,
      metalness: 0.18,
    });
    const chevrons: THREE.Mesh[] = [];
    for (let i = 0; i < 11; i++) {
      const chevron = new THREE.Mesh(new THREE.ConeGeometry(0.105, 0.24, 4), chevronMat);
      chevron.castShadow = true;
      addOutline(chevron, 0.85);
      root.add(chevron);
      chevrons.push(chevron);
    }

    let active = false;
    function layout(offset: number, time: number) {
      chevrons.forEach((chevron, i) => {
        const t = (i / chevrons.length + offset) % 1;
        const p = curve.getPoint(t);
        const tangent = curve.getTangent(t).normalize();
        chevron.position.copy(p);
        chevron.position.y += 0.09 + Math.sin(time * 2.4 + i) * 0.015;
        chevron.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
      });
    }
    layout(0, 0);

    function activate(instant = false) {
      active = true;
      chevronMat.emissiveIntensity = 0.95;
      spanMat.emissiveIntensity = 0.55;
      if (!instant) {
        gsap.fromTo(
          chevrons.map((c) => c.scale),
          { x: 0.85, y: 0.85, z: 0.85 },
          { x: 1.15, y: 1.15, z: 1.15, duration: 0.45, stagger: 0.03, ease: 'back.out(1.7)' },
        );
      }
    }
    function update(_dt: number, time: number) {
      const speed = active ? 0.2 : 0.055;
      layout((time * speed) % 1, time);
      if (!active) return;
      chevronMat.emissiveIntensity = 0.72 + 0.35 * Math.sin(time * 4.0);
      spanMat.emissiveIntensity = 0.4 + 0.22 * Math.sin(time * 2.6);
    }

    return { group, tagY: 1.66, activate, update };
  }

  function buildServer(_def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    const accent = new THREE.Color(spread.scene.accent);
    const group = new THREE.Group();
    const root = new THREE.Group();
    group.add(root);

    const cream = lighten(accent, 0.82).getHex();
    const chassisDark = 0x362a1d;
    const statusRingMat = buildPedestal(root, accent, 0.68);
    const rackMats: THREE.MeshStandardMaterial[] = [];
    const leds: THREE.MeshStandardMaterial[] = [];

    // Twin Solid Side Structural Frame Pillars
    const frameMat = new THREE.MeshStandardMaterial({ color: chassisDark, roughness: 0.75 });
    [-0.44, 0.44].forEach((x) => {
      const sideFrame = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.32, 0.54), frameMat);
      sideFrame.position.set(x, 0.72, 0);
      sideFrame.castShadow = true;
      addOutline(sideFrame, 0.9);
      root.add(sideFrame);
    });

    // 4 Thick Extruded 3D Mainframe Server Blades
    for (let i = 0; i < 4; i++) {
      const rackMat = paperMaterial(cream, { emissive: accent, emissiveIntensity: 0.06 });
      rackMats.push(rackMat);
      const rack = new THREE.Mesh(extrude(rounded(0.84, 0.27, 0.025), 0.5, 0.006), rackMat);
      rack.position.set(0, 0.23 + i * 0.31, 0);
      rack.castShadow = true;
      rack.receiveShadow = true;
      addOutline(rack, 0.9);
      root.add(rack);

      const panel = textPlane(serverPanelTexture(i % 3), 0.72, 0.21);
      panel.position.set(0, 0.23 + i * 0.31, 0.256);
      root.add(panel);

      for (let j = 0; j < 2; j++) {
        const ledMat = new THREE.MeshStandardMaterial({
          color: accent,
          emissive: accent,
          emissiveIntensity: 0.35,
          roughness: 0.45,
        });
        const led = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), ledMat);
        led.position.set(0.3, 0.23 + i * 0.31 + j * 0.055, 0.264);
        root.add(led);
        leds.push(ledMat);
      }
    }

    // Solid 3D Semicircular LOAD Meter Housing Crown
    const gaugeGroup = new THREE.Group();
    gaugeGroup.position.set(0, 1.48, 0.22);
    root.add(gaugeGroup);

    const gaugeBacking = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.28, 0.08, 20, 1, false, -Math.PI / 2, Math.PI),
      paperMaterial(cream),
    );
    gaugeBacking.rotation.x = Math.PI / 2;
    gaugeBacking.rotation.z = -Math.PI / 2;
    gaugeBacking.castShadow = true;
    addOutline(gaugeBacking, 0.88);
    gaugeGroup.add(gaugeBacking);

    const gauge = textPlane(gaugeTexture(), 0.54, 0.4);
    gauge.position.z = 0.044;
    gaugeGroup.add(gauge);

    const needleMat = new THREE.MeshStandardMaterial({
      color: 0xa63322,
      emissive: 0xd94632,
      emissiveIntensity: 0.25,
      roughness: 0.45,
    });
    const needlePivot = new THREE.Group();
    needlePivot.position.set(0, -0.02, 0.055);
    gaugeGroup.add(needlePivot);
    const needle = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.18, 0.02), needleMat);
    needle.position.y = 0.075;
    needlePivot.add(needle);
    needlePivot.rotation.z = 0.9;

    // Enlarged 3D Saturation Column with Top/Bottom Caps beside Server Rack
    const tubeGroup = new THREE.Group();
    tubeGroup.position.set(-0.56, 0.08, 0.12);
    root.add(tubeGroup);

    const capMat = new THREE.MeshStandardMaterial({ color: 0xb6a479, metalness: 0.72, roughness: 0.28 });
    [0.03, 1.11].forEach((y) => {
      const endCap = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.06, 16), capMat);
      endCap.position.y = y;
      endCap.castShadow = true;
      addOutline(endCap, 0.85);
      tubeGroup.add(endCap);
    });

    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xf7efe0,
      roughness: 0.22,
      metalness: 0.08,
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
    });
    const glassTube = new THREE.Mesh(new THREE.CylinderGeometry(0.092, 0.092, 1.04, 18), glassMat);
    glassTube.position.y = 0.57;
    glassTube.renderOrder = 4;
    addOutline(glassTube, 0.65);
    tubeGroup.add(glassTube);

    const fluidMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.42,
      roughness: 0.3,
    });
    const fluidCol = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.072, 1.0, 16), fluidMat);
    fluidCol.geometry.translate(0, 0.5, 0);
    fluidCol.position.y = 0.06;
    fluidCol.scale.y = 0.26;
    fluidCol.castShadow = true;
    tubeGroup.add(fluidCol);

    // Top 3D Mast & Overload Warning Beacon
    const antenna = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.022, 0.4, 8),
      new THREE.MeshStandardMaterial({ color: chassisDark, roughness: 0.65 }),
    );
    antenna.position.set(0.32, 1.56, -0.05);
    root.add(antenna);

    const antennaTipMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.45,
      roughness: 0.35,
    });
    const antennaTip = new THREE.Mesh(new THREE.OctahedronGeometry(0.068, 0), antennaTipMat);
    antennaTip.position.set(0.32, 1.78, -0.05);
    addOutline(antennaTip, 0.82);
    root.add(antennaTip);

    let active = false;
    function activate(instant = false) {
      active = true;
      if (instant) {
        rackMats.forEach((m) => {
          m.emissiveIntensity = 0.3;
        });
        leds.forEach((m) => {
          m.emissiveIntensity = 1.15;
          m.color.set(accent);
        });
        needlePivot.rotation.z = -1.15;
        needleMat.emissiveIntensity = 1.0;
        fluidCol.scale.y = 1.0;
        fluidMat.emissiveIntensity = 1.05;
        statusRingMat.emissiveIntensity = 1.1;
        return;
      }
      rackMats.forEach((m, i) => {
        gsap.to(m, { emissiveIntensity: 0.32, duration: 0.5, delay: i * 0.07 });
      });
      leds.forEach((m, i) => {
        gsap.to(m, { emissiveIntensity: 1.25, duration: 0.35, delay: i * 0.05 });
      });
      gsap.to(needlePivot.rotation, { z: -1.15, duration: 1.05, ease: 'power2.inOut' });
      gsap.to(needleMat, { emissiveIntensity: 1.05, duration: 0.6 });
      gsap.to(fluidCol.scale, { y: 1.0, duration: 1.05, ease: 'power2.out' });
      gsap.to(fluidMat, { emissiveIntensity: 1.1, duration: 0.6 });
      gsap.to(statusRingMat, { emissiveIntensity: 1.15, duration: 0.55 });
      gsap.fromTo(
        root.rotation,
        { z: -0.016 },
        {
          z: 0.016,
          duration: 0.07,
          yoyo: true,
          repeat: 6,
          onComplete: () => {
            root.rotation.z = 0;
          },
        },
      );
    }
    function update(dt: number, time: number) {
      antennaTip.rotation.y += dt * (active ? 1.8 : 0.6);
      if (!active) return;
      leds.forEach((m, i) => {
        m.emissiveIntensity = 0.65 + 0.55 * Math.sin(time * 4.4 + i * 0.9);
      });
      rackMats.forEach((m, i) => {
        m.emissiveIntensity = 0.22 + 0.1 * Math.sin(time * 2.6 + i);
      });
      needleMat.emissiveIntensity = 0.75 + 0.3 * Math.sin(time * 2.4);
      fluidMat.emissiveIntensity = 0.85 + 0.28 * Math.sin(time * 3.1);
      antennaTipMat.emissiveIntensity = 0.65 + 0.45 * Math.sin(time * 3.5);
      statusRingMat.emissiveIntensity = 0.8 + 0.3 * Math.sin(time * 2.5);
    }

    return { group, tagY: 1.98, activate, update };
  }

  /* ------------------------------------------------------------------ */
  /* 05 — Review monuments with 3D sculpted crowns & flip monoliths     */
  /* ------------------------------------------------------------------ */
  function buildReview(def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    const accent = new THREE.Color(spread.scene.accent);
    const group = new THREE.Group();
    const root = new THREE.Group();
    root.rotation.y = def.icon === 'hook' ? 0.12 : -0.1;
    group.add(root);

    const cream = lighten(accent, 0.85).getHex();
    const pillarHex = lighten(accent, 0.56).getHex();
    const icon = def.icon ?? 'network';
    const en = icon === 'lock' ? 'ENCRYPT' : icon === 'hook' ? 'DECEIVE' : 'FLOOD';
    const statusRingMat = buildPedestal(root, accent, 0.66);

    // Twin 3D Architectural Bookend Pillars supporting the Monument Card
    const pillarMat = paperMaterial(pillarHex);
    [-0.5, 0.5].forEach((x) => {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.085, 1.32, 0.14), pillarMat);
      col.position.set(x, 0.72, 0);
      col.castShadow = true;
      addOutline(col, 0.88);
      root.add(col);
    });

    // Heavy Beveled 3D Flip Monolith Card
    const cardGroup = new THREE.Group();
    cardGroup.position.y = 0.72;
    cardGroup.rotation.x = -0.025;
    root.add(cardGroup);

    const cardMat = paperMaterial(cream, { emissive: accent, emissiveIntensity: 0.06 });
    const card = new THREE.Mesh(extrude(rounded(0.92, 1.2, 0.05), 0.085, 0.008), cardMat);
    card.castShadow = true;
    card.receiveShadow = true;
    addOutline(card, 0.9);
    cardGroup.add(card);

    const front = textPlane(reviewFrontTexture(icon, def.label, en), 0.86, 1.13);
    front.position.z = 0.048;
    cardGroup.add(front);

    const back = textPlane(reviewBackTexture(icon, en), 0.86, 1.13);
    back.position.z = -0.048;
    back.rotation.y = Math.PI;
    cardGroup.add(back);

    const tab = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.06, 0.11),
      new THREE.MeshStandardMaterial({ color: accent, roughness: 0.55 }),
    );
    tab.position.set(0, 0.62, 0);
    addOutline(tab, 0.85);
    cardGroup.add(tab);

    // 3D Sculpted Miniature Icon Crown Perched Right Atop Each Monument
    const crownGroup = new THREE.Group();
    crownGroup.position.set(0, 1.54, 0);
    root.add(crownGroup);

    const crownMat = new THREE.MeshStandardMaterial({
      color: 0xd9b366,
      emissive: accent,
      emissiveIntensity: 0.25,
      metalness: 0.65,
      roughness: 0.28,
    });

    if (icon === 'lock') {
      const lockBody = new THREE.Mesh(extrude(rounded(0.32, 0.26, 0.04), 0.14, 0.008), crownMat);
      lockBody.castShadow = true;
      addOutline(lockBody, 0.88);
      crownGroup.add(lockBody);

      const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.028, 8, 22, Math.PI), crownMat);
      shackle.position.y = 0.13;
      shackle.castShadow = true;
      addOutline(shackle, 0.85);
      crownGroup.add(shackle);
    } else if (icon === 'hook') {
      const hookArc = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.032, 8, 26, Math.PI * 1.4), crownMat);
      hookArc.rotation.z = 0.55;
      hookArc.castShadow = true;
      addOutline(hookArc, 0.88);
      crownGroup.add(hookArc);

      const hookBarb = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.14, 6), crownMat);
      hookBarb.position.set(-0.14, -0.1, 0);
      hookBarb.rotation.z = -2.4;
      crownGroup.add(hookBarb);
    } else {
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.14, 0), crownMat);
      core.castShadow = true;
      addOutline(core, 0.88);
      crownGroup.add(core);

      const angles = [0, 1.57, 3.14, 4.71];
      angles.forEach((a) => {
        const sat = new THREE.Mesh(new THREE.SphereGeometry(0.048, 10, 10), crownMat);
        sat.position.set(Math.cos(a) * 0.24, Math.sin(a) * 0.06, Math.sin(a) * 0.24);
        crownGroup.add(sat);
        crownGroup.add(barBetween(new THREE.Vector3(0, 0, 0), sat.position, 0.014, crownMat));
      });
    }

    let active = false;
    function activate(instant = false) {
      active = true;
      if (instant) {
        cardGroup.rotation.y = Math.PI;
        cardMat.emissiveIntensity = 0.28;
        crownMat.emissiveIntensity = 0.9;
        statusRingMat.emissiveIntensity = 1.1;
        return;
      }
      gsap.to(cardGroup.rotation, { y: Math.PI, duration: 0.88, ease: 'back.inOut(1.5)' });
      gsap.to(cardMat, { emissiveIntensity: 0.34, duration: 0.55 });
      gsap.to(crownMat, { emissiveIntensity: 0.95, duration: 0.55 });
      gsap.to(statusRingMat, { emissiveIntensity: 1.15, duration: 0.55 });
      gsap.fromTo(
        cardGroup.position,
        { y: 0.72 },
        { y: 0.82, duration: 0.34, yoyo: true, repeat: 1, ease: 'power2.out' },
      );
      gsap.fromTo(
        crownGroup.scale,
        { x: 1, y: 1, z: 1 },
        { x: 1.24, y: 1.24, z: 1.24, duration: 0.4, yoyo: true, repeat: 1, ease: 'back.out(2)' },
      );
    }
    function update(dt: number, time: number) {
      crownGroup.rotation.y += dt * (active ? 1.2 : 0.45);
      crownGroup.position.y = 1.54 + Math.sin(time * 2.1 + spread.n) * 0.025;
      if (!active) return;
      cardMat.emissiveIntensity = 0.22 + 0.09 * Math.sin(time * 2.2);
      crownMat.emissiveIntensity = 0.65 + 0.3 * Math.sin(time * 2.8);
      statusRingMat.emissiveIntensity = 0.8 + 0.3 * Math.sin(time * 2.5);
      root.rotation.z = Math.sin(time * 0.8 + spread.n) * 0.008;
    }

    return { group, tagY: 1.94, activate, update };
  }

  function buildPopup(def: SceneObjectDef, spread: LessonSpread): BuiltPopup {
    switch (def.type) {
      case 'shield':
        return buildShield(def, spread);
      case 'network':
        return buildNetwork(def, spread);
      case 'laptop':
        return buildLaptop(def, spread);
      case 'files':
        return buildFiles(def, spread);
      case 'lock':
        return buildLock(def, spread);
      case 'note':
        return buildNote(def, spread);
      case 'phish':
        return buildPhish(def, spread);
      case 'badge':
        return buildBadge(def, spread);
      case 'usb':
        return buildUsb(def, spread);
      case 'botnet':
        return buildBotnet(def, spread);
      case 'flow':
        return buildFlow(def, spread);
      case 'server':
        return buildServer(def, spread);
      case 'review':
        return buildReview(def, spread);
    }
  }

  return {
    buildPopup,
    makePlateTexture,
    dispose() {
      createdTextures.forEach((tex) => tex.dispose());
      createdTextures.length = 0;
      cache.clear();
    },
  };
}
