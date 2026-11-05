import * as THREE from 'three';

export interface ProceduralTextures {
  desk: THREE.CanvasTexture;
  cloth: THREE.CanvasTexture;
  paper: THREE.CanvasTexture;
  hatch: THREE.CanvasTexture;
  shadow: THREE.CanvasTexture;
  dot: THREE.CanvasTexture;
  fieldCard: THREE.CanvasTexture;
  dispose: () => void;
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function createProceduralTextures(maxAnisotropy: number): ProceduralTextures {
  const aniso = Math.min(8, Math.max(1, maxAnisotropy));

  function makeDeskTexture(): THREE.CanvasTexture {
    const size = 1024;
    const canvas = makeCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    const rnd = seededRandom(2174);

    ctx.fillStyle = '#4b3d31';
    ctx.fillRect(0, 0, size, size);

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
    texture.anisotropy = aniso;
    return texture;
  }

  function makeClothTexture(): THREE.CanvasTexture {
    const size = 512;
    const canvas = makeCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
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
    texture.anisotropy = aniso;
    return texture;
  }

  function makePaperTexture(): THREE.CanvasTexture {
    const size = 512;
    const canvas = makeCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    const rnd = seededRandom(4331);
    ctx.fillStyle = '#f4ebd8';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 9000; i++) {
      const v = rnd();
      ctx.fillStyle =
        v > 0.54
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
    texture.anisotropy = aniso;
    return texture;
  }

  function makeHatchTexture(): THREE.CanvasTexture {
    const size = 128;
    const canvas = makeCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
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
    texture.anisotropy = aniso;
    return texture;
  }

  function makeRadialTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = makeCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0.72)');
    grad.addColorStop(0.52, 'rgba(0,0,0,0.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function makeDotTexture(): THREE.CanvasTexture {
    const size = 64;
    const canvas = makeCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,246,222,1)');
    grad.addColorStop(0.35, 'rgba(255,239,198,0.9)');
    grad.addColorStop(1, 'rgba(255,228,170,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function makeFieldCardTexture(): THREE.CanvasTexture {
    const w = 512;
    const h = 660;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
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
    texture.anisotropy = aniso;
    return texture;
  }

  const desk = makeDeskTexture();
  const cloth = makeClothTexture();
  const paper = makePaperTexture();
  const hatch = makeHatchTexture();
  const shadow = makeRadialTexture();
  const dot = makeDotTexture();
  const fieldCard = makeFieldCardTexture();

  return {
    desk,
    cloth,
    paper,
    hatch,
    shadow,
    dot,
    fieldCard,
    dispose() {
      desk.dispose();
      cloth.dispose();
      paper.dispose();
      hatch.dispose();
      shadow.dispose();
      dot.dispose();
      fieldCard.dispose();
    },
  };
}
