import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

let cachedClient: GoogleGenAI | null = null;
let cachedApiKey: string | undefined;

function getGenAIClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedApiKey = apiKey;
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

function normalizeSpokenText(
  rawText: string,
  langHint?: string,
): { text: string; style: string; voiceName: string; isArabic: boolean } {
  const compact = rawText.replace(/\s+/g, ' ').trim();
  const arabicMatches = compact.match(/[\u0600-\u06FF]/g);
  const latinMatches = compact.match(/[A-Za-z]/g);
  const arabicCount = arabicMatches ? arabicMatches.length : 0;
  const latinCount = latinMatches ? latinMatches.length : 0;
  const isArabic =
    langHint === 'ar' || (langHint !== 'en' && arabicCount > 0 && arabicCount >= latinCount * 0.4);

  let spoken = compact;
  if (isArabic) {
    spoken = spoken
      .replace(/←|→/g, '، ثم ')
      .replace(/×/g, ' مع ')
      .replace(/\|/g, '، ')
      .replace(/\s*·\s*/g, '، ')
      .replace(/\s*—\s*/g, '، ')
      .replace(/«([^»]+)»/g, '$1')
      .replace(/\(✗\)/g, 'خطأ')
      .replace(/\(✓\)/g, 'صواب');
  } else {
    spoken = spoken
      .replace(/^↳\s*/g, '')
      .replace(/←|→/g, ', leads to ')
      .replace(/×/g, ' times ')
      .replace(/\|/g, ', ')
      .replace(/\s*·\s*/g, ', ')
      .replace(/\s*—\s*/g, ', ')
      .replace(/\(\)/g, '');
  }

  let style: string;
  if (arabicCount > 0 && latinCount > 4) {
    style =
      'Clear, warm bilingual Modern Standard Arabic and English textbook narrator; pronounce English cybersecurity terms crisply inside Arabic sentences';
  } else if (arabicCount > 0) {
    style = 'Clear, natural, calm Modern Standard Arabic textbook narrator with warm studio clarity';
  } else {
    style = 'Clear, articulate English science and technology textbook narrator';
  }

  return {
    text: spoken,
    style,
    voiceName: 'Kore',
    isArabic,
  };
}

function splitSpeechChunks(text: string, maxLen = 170): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  const chunks: string[] = [];
  let remaining = clean;

  while (remaining.length > 0 && chunks.length < 15) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    const slice = remaining.slice(0, maxLen);
    let breakIdx = -1;

    // Prefer splitting at natural Arabic/English punctuation marks
    for (let i = slice.length - 1; i >= Math.floor(maxLen * 0.45); i--) {
      const ch = slice[i];
      if (ch === '.' || ch === '!' || ch === '؟' || ch === '?' || ch === '،' || ch === ',' || ch === '؛' || ch === ';' || ch === ':') {
        breakIdx = i + 1;
        break;
      }
    }

    // Fallback to word boundary
    if (breakIdx === -1) {
      const lastSpace = slice.lastIndexOf(' ');
      breakIdx = lastSpace > Math.floor(maxLen * 0.35) ? lastSpace : maxLen;
    }

    const piece = remaining.slice(0, breakIdx).trim();
    if (piece) {
      chunks.push(piece);
    }
    remaining = remaining.slice(breakIdx).trim();
  }

  return chunks;
}

async function synthesizeFallbackMp3(
  text: string,
  isArabic: boolean,
): Promise<{ audioBase64: string; mimeType: string }> {
  const chunks = splitSpeechChunks(text, 170);
  if (chunks.length === 0) {
    throw new Error('No speakable text provided.');
  }
  const tl = isArabic ? 'ar' : 'en';
  const buffers: Buffer[] = [];

  for (const chunk of chunks) {
    const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=gtx&tl=${tl}&q=${encodeURIComponent(chunk)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
        },
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`Fallback speech upstream HTTP ${resp.status}`);
      }
      const arr = await resp.arrayBuffer();
      if (arr.byteLength < 64) {
        throw new Error('Fallback speech returned empty audio buffer.');
      }
      buffers.push(Buffer.from(arr));
    } finally {
      clearTimeout(timer);
    }
  }

  const combined = Buffer.concat(buffers);
  return {
    audioBase64: combined.toString('base64'),
    mimeType: 'audio/mpeg',
  };
}

function ensureWavBase64(base64Audio: string, rawMimeType?: string): { audioBase64: string; mimeType: string } {
  const buf = Buffer.from(base64Audio, 'base64');
  // Check for RIFF header (already a complete WAV file)
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF') {
    return { audioBase64: base64Audio, mimeType: 'audio/wav' };
  }
  // Otherwise wrap raw 24kHz 16-bit mono PCM into a standard 44-byte RIFF/WAV container
  const sampleRateMatch = rawMimeType?.match(/rate=(\d+)/i);
  const sampleRate = sampleRateMatch ? Number(sampleRateMatch[1]) : 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = buf.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 4, 'ascii');
  header.write('fmt ', 12, 4, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 4, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  const wav = Buffer.concat([header, buf]);
  return {
    audioBase64: wav.toString('base64'),
    mimeType: 'audio/wav',
  };
}

const TTS_MODELS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'] as const;
let geminiBackoffUntil = 0;

async function generateGeminiSpeech(
  ai: GoogleGenAI,
  spokenText: string,
  style: string,
  voiceName: string,
) {
  let lastError: unknown;
  for (const model of TTS_MODELS) {
    try {
      const response = await Promise.race([
        ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: spokenText,
                  speechMetadata: {
                    style,
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Gemini TTS timeout')), 3200),
        ),
      ]);
      return response;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : '';
      if (/429|503|RESOURCE_EXHAUSTED|UNAVAILABLE|quota/i.test(msg)) {
        geminiBackoffUntil = Date.now() + 90_000;
        break;
      }
    }
  }
  throw lastError;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      ttsConfigured: true,
    });
  });

  app.post('/api/tts', async (req: Request, res: Response) => {
    const rawText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const langHint = typeof req.body?.lang === 'string' ? req.body.lang : undefined;

    if (!rawText) {
      res.status(400).json({ error: 'Text is required for speech synthesis.', code: 'INVALID_TEXT' });
      return;
    }

    if (rawText.length > 2500) {
      res
        .status(400)
        .json({ error: 'Text exceeds maximum length (2500 characters).', code: 'TEXT_TOO_LONG' });
      return;
    }

    const { text, style, voiceName, isArabic } = normalizeSpokenText(rawText, langHint);
    const ai = Date.now() >= geminiBackoffUntil ? getGenAIClient() : null;

    if (ai) {
      try {
        const response = await generateGeminiSpeech(ai, text, style, voiceName);
        const parts = response.candidates?.[0]?.content?.parts ?? [];
        const audioPart = parts.find((part) => Boolean(part.inlineData?.data));
        const base64Audio = audioPart?.inlineData?.data;
        const rawMimeType = audioPart?.inlineData?.mimeType;

        if (base64Audio) {
          const normalized = ensureWavBase64(base64Audio, rawMimeType);
          res.json(normalized);
          return;
        }
      } catch {
        // Automatically continue to server-side MP3 speech synthesis fallback
      }
    }

    try {
      const fallbackAudio = await synthesizeFallbackMp3(text, isArabic);
      res.json(fallbackAudio);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to generate speech audio.';
      res.status(502).json({ error: message, code: 'TTS_ERROR' });
    }
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
