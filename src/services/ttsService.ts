export interface TtsSnapshot {
  enabled: boolean;
  loading: boolean;
  playing: boolean;
  activeElementId: string | null;
  selectedText: string;
  selectedLang: 'ar' | 'en' | 'auto';
  errorMessage: string | null;
}

type Listener = (snapshot: TtsSnapshot) => void;

function normalizeForSpeech(rawText: string, langHint?: 'ar' | 'en' | 'auto'): {
  spoken: string;
  isArabic: boolean;
} {
  const compact = rawText.replace(/\s+/g, ' ').trim();
  const arabicMatches = compact.match(/[\u0600-\u06FF]/g);
  const latinMatches = compact.match(/[A-Za-z]/g);
  const arabicCount = arabicMatches ? arabicMatches.length : 0;
  const latinCount = latinMatches ? latinMatches.length : 0;
  const isArabic =
    langHint === 'ar' || (langHint !== 'en' && arabicCount > 0 && arabicCount >= latinCount * 0.45);

  if (isArabic) {
    return {
      isArabic: true,
      spoken: compact
        .replace(/←|→/g, '، ثم ')
        .replace(/×/g, ' مع ')
        .replace(/\|/g, '، ')
        .replace(/\s*·\s*/g, '، ')
        .replace(/\s*—\s*/g, '، ')
        .replace(/«([^»]+)»/g, '$1')
        .replace(/\(✗\)/g, 'خطأ')
        .replace(/\(✓\)/g, 'صواب'),
    };
  }

  return {
    isArabic: false,
    spoken: compact
      .replace(/^↳\s*/g, '')
      .replace(/←|→/g, ', leads to ')
      .replace(/×/g, ' times ')
      .replace(/\|/g, ', ')
      .replace(/\s*·\s*/g, ', ')
      .replace(/\s*—\s*/g, ', ')
      .replace(/\(\)/g, ''),
  };
}

function base64ToBlobUrl(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

// 1-sample silent WAV data URL used to unlock HTMLAudioElement inside user gestures
const SILENT_WAV_DATA_URL =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

class AiTtsService {
  private enabled = true;
  private loading = false;
  private playing = false;
  private activeElementId: string | null = null;
  private selectedText = '';
  private selectedLang: 'ar' | 'en' | 'auto' = 'auto';
  private errorMessage: string | null = null;

  private sharedAudio: HTMLAudioElement | null = null;
  private audioUnlocked = false;
  private currentBlobUrl: string | null = null;
  private abortController: AbortController | null = null;
  private activeUtterance: SpeechSynthesisUtterance | null = null;
  private speechKeepAliveTimer: number | null = null;
  private speechFallbackEndTimer: number | null = null;
  private readonly cache = new Map<string, string>();
  private readonly listeners = new Set<Listener>();
  private requestSeq = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      if ('speechSynthesis' in window) {
        try {
          window.speechSynthesis.getVoices();
          window.speechSynthesis.addEventListener?.('voiceschanged', () => {
            window.speechSynthesis.getVoices();
          });
        } catch {
          // ignore voice pre-warm errors
        }
      }
    }
  }

  /**
   * Must be called synchronously inside a user click/pointerdown/keydown handler
   * so browsers keep the shared HTMLAudioElement unlocked after async /api/tts fetch.
   */
  unlockAudio() {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') return;
    if (!this.sharedAudio) {
      this.sharedAudio = new Audio();
      this.sharedAudio.preload = 'auto';
      this.sharedAudio.setAttribute('playsinline', 'true');
    }
    if (this.audioUnlocked) return;
    try {
      this.sharedAudio.src = SILENT_WAV_DATA_URL;
      this.sharedAudio.volume = 0.01;
      const p = this.sharedAudio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          if (this.sharedAudio && this.sharedAudio.src === SILENT_WAV_DATA_URL) {
            this.sharedAudio.pause();
            this.sharedAudio.currentTime = 0;
          }
          this.audioUnlocked = true;
        }).catch(() => {
          // Will retry on next user gesture
        });
      }
    } catch {
      // ignore unlock error
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): TtsSnapshot {
    return {
      enabled: this.enabled,
      loading: this.loading,
      playing: this.playing,
      activeElementId: this.activeElementId,
      selectedText: this.selectedText,
      selectedLang: this.selectedLang,
      errorMessage: this.errorMessage,
    };
  }

  private emit() {
    const snap = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snap));
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.errorMessage = null;
    if (!enabled) {
      this.stop();
    } else {
      this.unlockAudio();
      this.emit();
    }
  }

  toggleEnabled(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  setDefaultSelection(
    text: string,
    elementId: string | null = null,
    lang: 'ar' | 'en' | 'auto' = 'ar',
  ) {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (!this.playing && !this.loading) {
      this.selectedText = clean;
      this.activeElementId = elementId;
      this.selectedLang = lang;
      this.emit();
    }
  }

  private clearSpeechTimers() {
    if (this.speechKeepAliveTimer !== null) {
      window.clearInterval(this.speechKeepAliveTimer);
      this.speechKeepAliveTimer = null;
    }
    if (this.speechFallbackEndTimer !== null) {
      window.clearTimeout(this.speechFallbackEndTimer);
      this.speechFallbackEndTimer = null;
    }
  }

  stop() {
    this.requestSeq++;
    this.clearSpeechTimers();

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.sharedAudio) {
      this.sharedAudio.onended = null;
      this.sharedAudio.onerror = null;
      try {
        this.sharedAudio.pause();
        this.sharedAudio.currentTime = 0;
      } catch {
        // ignore audio reset error
      }
    }

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        if (this.activeUtterance) {
          this.activeUtterance.onend = null;
          this.activeUtterance.onerror = null;
          this.activeUtterance = null;
        }
        window.speechSynthesis.cancel();
      } catch {
        // ignore speechSynthesis cancel errors
      }
    }

    this.loading = false;
    this.playing = false;
    this.emit();
  }

  private lastSpeakSignature = '';
  private lastSpeakTime = 0;

  async replay(): Promise<void> {
    if (!this.selectedText) return;
    this.unlockAudio();
    this.enabled = true;
    await this.speakInternal(this.selectedText, this.activeElementId, this.selectedLang);
  }

  async speak(
    text: string,
    options: { elementId?: string | null; lang?: 'ar' | 'en' | 'auto'; autoEnable?: boolean } = {},
  ): Promise<void> {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;

    this.unlockAudio();

    const sig = `${options.elementId ?? ''}:${clean}`;
    const now = performance.now();
    if (sig === this.lastSpeakSignature && now - this.lastSpeakTime < 150) {
      return;
    }
    this.lastSpeakSignature = sig;
    this.lastSpeakTime = now;

    // Clicking any line in the book automatically enables & plays the voice
    if (options.autoEnable !== false) {
      this.enabled = true;
    }

    this.selectedText = clean;
    this.activeElementId = options.elementId ?? null;
    this.selectedLang = options.lang ?? 'auto';
    this.errorMessage = null;

    if (!this.enabled) {
      this.emit();
      return;
    }

    await this.speakInternal(clean, this.activeElementId, this.selectedLang);
  }

  private async speakInternal(
    cleanText: string,
    elementId: string | null,
    lang: 'ar' | 'en' | 'auto',
  ): Promise<void> {
    this.stop();
    const seq = ++this.requestSeq;
    this.selectedText = cleanText;
    this.activeElementId = elementId;
    this.selectedLang = lang;
    this.errorMessage = null;

    const cacheKey = `${lang}:${cleanText}`;
    const cachedUrl = this.cache.get(cacheKey);
    if (cachedUrl) {
      this.playAudioUrl(cachedUrl, cleanText, elementId, lang, seq);
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), 9500);
    this.loading = true;
    this.emit();

    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanText, lang }),
        signal: controller.signal,
      });
      window.clearTimeout(timeoutId);

      if (seq !== this.requestSeq) return;

      const payload = (await response.json().catch(() => ({}))) as {
        audioBase64?: string;
        mimeType?: string;
        code?: string;
        error?: string;
      };

      if (seq !== this.requestSeq) return;

      if (!response.ok || !payload.audioBase64) {
        this.speakWithWebSpeech(cleanText, elementId, lang, seq);
        return;
      }

      const mimeType = payload.mimeType || 'audio/mpeg';
      const blobUrl = base64ToBlobUrl(payload.audioBase64, mimeType);
      if (this.cache.size >= 64) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) {
          const oldUrl = this.cache.get(oldestKey);
          if (oldUrl && oldUrl !== this.currentBlobUrl && oldUrl.startsWith('blob:')) {
            URL.revokeObjectURL(oldUrl);
          }
          this.cache.delete(oldestKey);
        }
      }
      this.cache.set(cacheKey, blobUrl);
      this.playAudioUrl(blobUrl, cleanText, elementId, lang, seq);
    } catch {
      window.clearTimeout(timeoutId);
      if (seq !== this.requestSeq) return;
      this.speakWithWebSpeech(cleanText, elementId, lang, seq);
    }
  }

  private playAudioUrl(
    audioUrl: string,
    cleanText: string,
    elementId: string | null,
    lang: 'ar' | 'en' | 'auto',
    seq: number,
  ) {
    if (seq !== this.requestSeq) return;
    if (!this.sharedAudio) {
      this.sharedAudio = new Audio();
      this.sharedAudio.preload = 'auto';
      this.sharedAudio.setAttribute('playsinline', 'true');
    }

    const audio = this.sharedAudio;
    this.currentBlobUrl = audioUrl;
    audio.onended = null;
    audio.onerror = null;
    audio.src = audioUrl;
    audio.volume = 1;
    this.loading = false;
    this.playing = true;
    this.emit();

    const finalize = () => {
      if (seq !== this.requestSeq) return;
      this.loading = false;
      this.playing = false;
      this.emit();
    };

    audio.onended = finalize;
    audio.onerror = () => {
      if (seq !== this.requestSeq) return;
      this.speakWithWebSpeech(cleanText, elementId, lang, seq);
    };

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        if (seq !== this.requestSeq) return;
        this.speakWithWebSpeech(cleanText, elementId, lang, seq);
      });
    }
  }

  private pickVoice(isArabic: boolean): SpeechSynthesisVoice | null {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;

    if (isArabic) {
      const exactArabic = voices.find((v) => /^ar-(EG|SA|AE|JO|KW|MA|001)$/i.test(v.lang));
      if (exactArabic) return exactArabic;
      const anyArabic = voices.find((v) => v.lang.toLowerCase().startsWith('ar'));
      if (anyArabic) return anyArabic;
    } else {
      const exactEnglish = voices.find((v) => /^en-(US|GB)$/i.test(v.lang));
      if (exactEnglish) return exactEnglish;
      const anyEnglish = voices.find((v) => v.lang.toLowerCase().startsWith('en'));
      if (anyEnglish) return anyEnglish;
    }
    return voices[0] ?? null;
  }

  private speakWithWebSpeech(
    cleanText: string,
    elementId: string | null,
    lang: 'ar' | 'en' | 'auto',
    seq: number,
  ) {
    if (seq !== this.requestSeq) return;

    const { spoken, isArabic } = normalizeForSpeech(cleanText, lang);
    this.loading = false;
    this.playing = true;
    this.errorMessage = null;
    this.emit();

    const finish = () => {
      if (seq !== this.requestSeq) return;
      this.clearSpeechTimers();
      this.activeUtterance = null;
      this.loading = false;
      this.playing = false;
      this.emit();
    };

    if (
      typeof window === 'undefined' ||
      !('speechSynthesis' in window) ||
      typeof SpeechSynthesisUtterance === 'undefined'
    ) {
      this.speechFallbackEndTimer = window.setTimeout(
        finish,
        Math.min(5200, Math.max(1500, spoken.length * 55)),
      );
      return;
    }

    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(spoken);
      const voice = this.pickVoice(isArabic);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = isArabic ? 'ar-EG' : 'en-US';
      }
      utterance.rate = 0.96;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      this.activeUtterance = utterance;
      utterance.onend = finish;
      utterance.onerror = () => {
        if (seq !== this.requestSeq) return;
        finish();
      };

      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
      window.speechSynthesis.speak(utterance);

      this.speechKeepAliveTimer = window.setInterval(() => {
        if (seq !== this.requestSeq) return;
        if (window.speechSynthesis.speaking && window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      }, 3500);

      // Safety fallback in case browser speech engine is silent or headless
      const estimatedMs = Math.max(3000, Math.min(18000, spoken.length * 95 + 1800));
      this.speechFallbackEndTimer = window.setTimeout(() => {
        if (seq !== this.requestSeq) return;
        if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
          finish();
        }
      }, estimatedMs);
    } catch {
      this.speechFallbackEndTimer = window.setTimeout(finish, 1800);
    }
  }
}

export const ttsService = new AiTtsService();
