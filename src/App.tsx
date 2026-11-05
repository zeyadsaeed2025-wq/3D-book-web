import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LESSON_SCHEMA } from './data/lessonSchema';
import { BookStage, type DemoState } from './three/BookStage';
import { ttsService, type TtsSnapshot } from './services/ttsService';
import { BookPageContent, type TtsSpeakPayload } from './components/BookPageContent';

const pad2 = (n: number) => String(n).padStart(2, '0');

export default function App() {
  const spreads = LESSON_SCHEMA.spreads;
  const totalSpreads = spreads.length;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stageElRef = useRef<HTMLDivElement | null>(null);
  const dom3dRef = useRef<HTMLDivElement | null>(null);
  const dom2dRef = useRef<HTMLDivElement | null>(null);
  const bookStageRef = useRef<BookStage | null>(null);
  const captionTimerRef = useRef<number | null>(null);

  const [cssMountEl, setCssMountEl] = useState<HTMLDivElement | null>(null);
  const [spreadIdx, setSpreadIdx] = useState<number>(0);
  const [seenCounts, setSeenCounts] = useState<number[]>(() => spreads.map(() => 0));
  const [selectedBySpread, setSelectedBySpread] = useState<(number | null)[]>(() =>
    spreads.map(() => null),
  );
  const [flapOpenBySpread, setFlapOpenBySpread] = useState<boolean[]>(() =>
    spreads.map(() => false),
  );
  const [selfAssessment, setSelfAssessment] = useState<string | null>(null);

  const [demoState, setDemoState] = useState<DemoState>('idle');
  const [flipping, setFlipping] = useState<boolean>(false);
  const [tocOpen, setTocOpen] = useState<boolean>(false);
  const [readerOpen, setReaderOpen] = useState<boolean>(false);
  const [hudCollapsed, setHudCollapsed] = useState<boolean>(false);
  const [sound, setSound] = useState<boolean>(true);
  const [highContrast, setHighContrast] = useState<boolean>(false);
  const [reducedMotion, setReducedMotion] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  const [splashDone, setSplashDone] = useState<boolean>(false);
  const [caption, setCaption] = useState<{
    visible: boolean;
    kicker: string;
    text: string;
  }>({ visible: false, kicker: '', text: '' });
  const [announcement, setAnnouncement] = useState<string>('');
  const [ttsSnapshot, setTtsSnapshot] = useState<TtsSnapshot>(() => ttsService.getSnapshot());

  const showCaption = useCallback(
    (kicker: string, text: string, duration = 4500, sticky = false) => {
      if (captionTimerRef.current !== null) {
        window.clearTimeout(captionTimerRef.current);
        captionTimerRef.current = null;
      }
      setCaption({ visible: true, kicker, text });
      if (!sticky) {
        captionTimerRef.current = window.setTimeout(() => {
          setCaption((prev) => ({ ...prev, visible: false }));
          captionTimerRef.current = null;
        }, duration);
      }
    },
    [],
  );

  const hideCaption = useCallback(() => {
    if (captionTimerRef.current !== null) {
      window.clearTimeout(captionTimerRef.current);
      captionTimerRef.current = null;
    }
    setCaption((prev) => ({ ...prev, visible: false }));
  }, []);

  const handleSpeakText = useCallback(
    ({ elementId, text, lang }: TtsSpeakPayload) => {
      void ttsService.speak(text, { elementId, lang, autoEnable: true });
    },
    [],
  );

  useEffect(() => {
    const unsubscribe = ttsService.subscribe(setTtsSnapshot);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (ttsSnapshot.errorMessage) {
      showCaption('AI VOICE', ttsSnapshot.errorMessage, 4200);
    }
  }, [ttsSnapshot.errorMessage, showCaption]);

  useEffect(() => {
    const spread = spreads[spreadIdx];
    if (!spread) return;
    ttsService.setDefaultSelection(`${spread.title}. ${spread.summary}`, `${spread.id}__title`, 'ar');
  }, [spreads, spreadIdx]);

  useEffect(() => {
    document.body.classList.toggle('hc', highContrast);
  }, [highContrast]);

  useEffect(() => {
    document.body.classList.toggle('reduced', reducedMotion);
    bookStageRef.current?.setReduced(reducedMotion);
  }, [reducedMotion]);

  useEffect(() => {
    const viewportEl = viewportRef.current;
    const stageEl = stageElRef.current;
    const dom3dEl = dom3dRef.current;
    const dom2dEl = dom2dRef.current;
    if (!viewportEl || !stageEl || !dom3dEl || !dom2dEl) return;

    const initialReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stage = new BookStage({
      schema: LESSON_SCHEMA,
      viewportEl,
      stageEl,
      dom3dEl,
      dom2dEl,
      initialReduced,
      callbacks: {
        onSpreadChange: (index) => {
          setSpreadIdx(index);
          const snap = ttsService.getSnapshot();
          if (snap.playing || snap.loading) {
            ttsService.stop();
          }
        },
        onFlippingChange: setFlipping,
        onDemoStateChange: setDemoState,
        onFocusPageChange: () => {},
        onCaption: showCaption,
        onHideCaption: hideCaption,
        onAnnounce: setAnnouncement,
        onObjectActivated: (si, _objectId, seenSet) => {
          setSeenCounts((prev) => {
            if (prev[si] === seenSet.size) return prev;
            const next = [...prev];
            next[si] = seenSet.size;
            return next;
          });
        },
        onReadableTextClick: ({ elementId, text, lang }) => {
          handleSpeakText({ elementId, text, lang });
        },
      },
    });

    bookStageRef.current = stage;
    setCssMountEl(stage.getCssPageMount());

    const splashTimer = window.setTimeout(
      () => {
        setSplashDone(true);
      },
      initialReduced ? 80 : 2600,
    );

    return () => {
      window.clearTimeout(splashTimer);
      if (captionTimerRef.current !== null) {
        window.clearTimeout(captionTimerRef.current);
      }
      stage.destroy();
      bookStageRef.current = null;
      setCssMountEl(null);
    };
  }, [handleSpeakText, hideCaption, showCaption]);

  const navigateToSpread = useCallback(
    (targetIdx: number, immediateFlip = false) => {
      ttsService.unlockAudio();
      setTocOpen(false);
      void bookStageRef.current?.goToSpread(targetIdx, { immediateFlip });
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tagName = (event.target as HTMLElement | null)?.tagName;
      if (tagName === 'INPUT' || tagName === 'TEXTAREA') return;

      if (event.key === 'Escape') {
        if (readerOpen) {
          setReaderOpen(false);
          return;
        }
        if (tocOpen) {
          setTocOpen(false);
          return;
        }
        if (demoState !== 'idle') {
          bookStageRef.current?.stopDemo();
        }
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigateToSpread(spreadIdx + 1, readerOpen);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigateToSpread(spreadIdx - 1, readerOpen);
      } else if (event.key === 'Home') {
        event.preventDefault();
        navigateToSpread(0, readerOpen);
      } else if (event.key === 'End') {
        event.preventDefault();
        navigateToSpread(totalSpreads - 1, readerOpen);
      } else if (event.key === ' ' && !tocOpen && !readerOpen) {
        event.preventDefault();
        bookStageRef.current?.toggleDemo();
      } else if (event.key.toLowerCase() === 'h' && !readerOpen) {
        setHudCollapsed((prev) => !prev);
      } else if (/^[1-5]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        if (index >= 0 && index < totalSpreads) {
          navigateToSpread(index, readerOpen);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [demoState, navigateToSpread, readerOpen, spreadIdx, tocOpen, totalSpreads]);

  const currentSpread = spreads[spreadIdx] ?? spreads[0];
  const completedSpreadsCount = useMemo(
    () =>
      spreads.filter((sp, i) => (seenCounts[i] ?? 0) >= (sp.scene.objects.length || 3)).length,
    [spreads, seenCounts],
  );

  const handleSelectOption = useCallback(
    (optionIndex: number) => {
      setSelectedBySpread((prev) => {
        const next = [...prev];
        next[spreadIdx] = optionIndex;
        return next;
      });
      bookStageRef.current?.playUiSound('select');
    },
    [spreadIdx],
  );

  const handleToggleFlap = useCallback(
    (open: boolean) => {
      if (selectedBySpread[spreadIdx] === null) return;
      setFlapOpenBySpread((prev) => {
        const next = [...prev];
        next[spreadIdx] = open;
        return next;
      });
      bookStageRef.current?.playUiSound('reveal');
    },
    [selectedBySpread, spreadIdx],
  );

  const handleToggleVoice = useCallback(() => {
    const nextEnabled = ttsService.toggleEnabled();
    bookStageRef.current?.playUiSound('click');
    showCaption(
      'AI VOICE',
      nextEnabled
        ? 'تم تفعيل القارئ الصوتي — اضغط على أي نص في الصفحة للاستماع بالذكاء الاصطناعي.'
        : 'تم إيقاف القارئ الصوتي.',
      3000,
    );
  }, [showCaption]);

  const handleStopVoice = useCallback(() => {
    ttsService.stop();
    bookStageRef.current?.playUiSound('click');
  }, []);

  const handleReplayVoice = useCallback(() => {
    const snap = ttsService.getSnapshot();
    if (!snap.enabled) {
      ttsService.setEnabled(true);
    }
    bookStageRef.current?.playUiSound('click');
    void ttsService.replay();
  }, []);

  const handleToggleSound = useCallback(() => {
    setSound((prev) => {
      const next = !prev;
      bookStageRef.current?.setSound(next);
      return next;
    });
  }, []);

  const pageElement = (surface: 'page' | 'reader') => (
    <BookPageContent
      spread={currentSpread}
      spreadIndex={spreadIdx}
      totalSpreads={totalSpreads}
      seenCount={seenCounts[spreadIdx] ?? 0}
      selectedOption={selectedBySpread[spreadIdx] ?? null}
      flapOpen={flapOpenBySpread[spreadIdx] ?? false}
      selfAssessment={selfAssessment}
      surface={surface}
      ttsSnapshot={ttsSnapshot}
      onSelectOption={handleSelectOption}
      onToggleFlap={handleToggleFlap}
      onSelectSelfAssessment={setSelfAssessment}
      onSpeakText={handleSpeakText}
    />
  );

  const isTtsBusy = ttsSnapshot.playing || ttsSnapshot.loading;

  return (
    <>
      <div className="sr-only" aria-live="polite" role="status">
        {announcement}
      </div>

      {/* 3D WebGL + CSS3D + CSS2D Stage */}
      <div id="viewport" ref={viewportRef}>
        <div id="stage" ref={stageElRef} />
        <div id="dom3d" ref={dom3dRef} />
        <div id="dom2d" ref={dom2dRef} />
        {cssMountEl && createPortal(pageElement('page'), cssMountEl)}
      </div>

      <div id="vignette" aria-hidden="true" />
      <div id="grain" aria-hidden="true" />

      {/* Top Editorial Chrome */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            II
          </div>
          <div
            className="brand-copy"
            title="اضغط للاستماع إلى عنوان الدرس واسم المعد"
            onClick={() => {
              void ttsService.speak(
                `${LESSON_SCHEMA.meta.title} — إعداد وتصميم المهندس زياد سعيد إبراهيم`,
                { elementId: 'brand-title', lang: 'ar', autoEnable: true },
              );
            }}
          >
            <span className="brand-eyebrow">ENGINEER ZIAD SAEED IBRAHIM · UNIT 02 · DIGITAL CULTURE</span>
            <span className="brand-ar">{LESSON_SCHEMA.meta.title}</span>
          </div>
        </div>

        <div className="top-actions">
          <button
            type="button"
            className="ghost-btn read-btn mobile-only"
            aria-pressed={readerOpen}
            aria-label="فتح وضع القراءة المكبّر"
            onClick={() => {
              setReaderOpen((prev) => !prev);
              bookStageRef.current?.playUiSound('click');
            }}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2.5 3.5c2-.5 3.8 0 5.5 1.2 1.7-1.2 3.5-1.7 5.5-1.2v9c-2-.5-3.8 0-5.5 1.2-1.7-1.2-3.5-1.7-5.5-1.2v-9Z"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinejoin="round"
              />
              <path d="M8 4.7v9" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            <span className="read-label">قراءة</span>
          </button>

          <button
            type="button"
            className="ghost-btn"
            aria-label="إعادة المنظور الافتراضي للكاميرا"
            onClick={() => bookStageRef.current?.resetView()}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3.2 6.5A5.2 5.2 0 1 1 4 11.2M3.2 3.2v3.3h3.3"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="long">إعادة المنظور</span>
          </button>
        </div>
      </header>

      {/* Guided Demo / Discovery Caption */}
      <div
        className={`caption${caption.visible ? ' is-visible' : ''}`}
        aria-live="polite"
        title="اضغط لقراءة الشرح بالصوت"
        onClick={() => {
          if (!caption.text) return;
          void ttsService.speak(caption.text, {
            elementId: 'floating-caption',
            lang: 'auto',
            autoEnable: true,
          });
        }}
      >
        <span className="cap-kicker">{caption.kicker}</span>
        <span className="cap-text">{caption.text}</span>
      </div>

      {/* Collapsible Floating Bottom HUD */}
      <div className={`hud-wrap${hudCollapsed ? ' is-collapsed' : ''}`}>
        <button
          type="button"
          className="hud-collapse-btn"
          aria-expanded={!hudCollapsed}
          aria-controls="main-hud"
          title={hudCollapsed ? 'إظهار شريط التحكم (H)' : 'طيّ شريط التحكم (H)'}
          onClick={() => setHudCollapsed((prev) => !prev)}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 6l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>{hudCollapsed ? 'HUD' : 'HIDE'}</span>
        </button>

        <nav id="main-hud" className="hud" aria-label="التحكم في الكتاب والأدوات">
          {/* Table of Contents */}
          <button
            type="button"
            aria-label="فهرس الدروس"
            title="فهرس الدروس"
            aria-expanded={tocOpen}
            aria-controls="toc-drawer"
            onClick={() => {
              setTocOpen((prev) => !prev);
              bookStageRef.current?.playUiSound('click');
            }}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3 4.5h10M3 8h10M3 11.5h7"
                stroke="currentColor"
                strokeWidth="1.45"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {/* Previous Spread */}
          <button
            type="button"
            aria-label="الصفحة السابقة"
            title="الصفحة السابقة"
            disabled={flipping || spreadIdx === 0}
            onClick={() => navigateToSpread(spreadIdx - 1)}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M10 3.5 5.5 8 10 12.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* Play / Pause Watch Demo */}
          <button
            type="button"
            className={`hud-play${demoState === 'playing' ? ' is-playing' : ''}`}
            aria-label={demoState === 'playing' ? 'إيقاف العرض التوضيحي مؤقتًا' : 'تشغيل العرض التوضيحي الموجّه'}
            title={demoState === 'playing' ? 'إيقاف مؤقت' : 'شاهد العرض التوضيحي'}
            disabled={flipping}
            onClick={() => bookStageRef.current?.toggleDemo()}
          >
            <svg className="icon-play" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M5.2 3.4 12.8 8l-7.6 4.6V3.4Z" />
            </svg>
            <svg className="icon-pause" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <rect x="4.5" y="3.5" width="2.5" height="9" rx="0.6" />
              <rect x="9.2" y="3.5" width="2.5" height="9" rx="0.6" />
            </svg>
          </button>

          {/* Next Spread */}
          <button
            type="button"
            aria-label="الصفحة التالية"
            title="الصفحة التالية"
            disabled={flipping || spreadIdx === totalSpreads - 1}
            onClick={() => navigateToSpread(spreadIdx + 1)}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M6 3.5 10.5 8 6 12.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <span className="hud-rule" aria-hidden="true" />

          {/* Current Spread Title & Indicator */}
          <div
            className="hud-lesson"
            title="اضغط للاستماع إلى عنوان الصفحة"
            onClick={() => {
              void ttsService.speak(`${currentSpread.title} — ${currentSpread.kicker}`, {
                elementId: `${currentSpread.id}__hud-title`,
                lang: 'ar',
                autoEnable: true,
              });
            }}
          >
            <span className="hud-index">
              SPREAD {pad2(spreadIdx + 1)} / {pad2(totalSpreads)} · ص {currentSpread.page}
            </span>
            <span className="hud-title">{currentSpread.title}</span>
          </div>

          <span className="hud-rule" aria-hidden="true" />

          {/* AI Text-to-Speech: Enable / Disable */}
          <button
            type="button"
            className={`hud-voice-btn${isTtsBusy ? ' is-speaking' : ''}`}
            aria-pressed={ttsSnapshot.enabled}
            aria-label={
              ttsSnapshot.enabled
                ? 'تعطيل القراءة الصوتية بالذكاء الاصطناعي'
                : 'تفعيل القراءة الصوتية بالذكاء الاصطناعي'
            }
            title={ttsSnapshot.enabled ? 'تعطيل صوت الذكاء الاصطناعي' : 'تفعيل صوت الذكاء الاصطناعي'}
            onClick={handleToggleVoice}
          >
            <svg className="icon-on" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3 6.2h2.6L9 3.4v9.2L5.6 9.8H3V6.2Z"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinejoin="round"
              />
              <path
                d="M11.2 5.6a3.5 3.5 0 0 1 0 4.8M12.9 4a5.8 5.8 0 0 1 0 8"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
            <svg className="icon-off" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3 6.2h2.6L9 3.4v9.2L5.6 9.8H3V6.2Z"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinejoin="round"
              />
              <path
                d="m11 6 3.2 4M14.2 6 11 10"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {/* AI Text-to-Speech: Replay Selected Text */}
          <button
            type="button"
            aria-label="إعادة قراءة النص المحدد"
            title="إعادة قراءة النص المحدد"
            disabled={!ttsSnapshot.selectedText}
            onClick={handleReplayVoice}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3.5 6.8A4.8 4.8 0 1 1 4.6 11M3.5 3.6v3.2h3.2"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* AI Text-to-Speech: Stop Playback */}
          <button
            type="button"
            aria-label="إيقاف القراءة الصوتية"
            title="إيقاف القراءة الصوتية"
            disabled={!isTtsBusy}
            onClick={handleStopVoice}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
            </svg>
          </button>

          <span className="hud-rule" aria-hidden="true" />

          {/* Paper / Tactile SFX Toggle */}
          <button
            type="button"
            aria-pressed={sound}
            aria-label={sound ? 'كتم مؤثرات الصفحات' : 'تفعيل مؤثرات الصفحات'}
            title={sound ? 'كتم مؤثرات الصفحات' : 'مؤثرات الصفحات'}
            onClick={handleToggleSound}
          >
            <svg className="icon-off" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8.5 3.2 5.4 5.8H3v4.4h2.4l3.1 2.6V3.2Z"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinejoin="round"
              />
              <path
                d="m11 6 2.8 4M13.8 6 11 10"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
              />
            </svg>
            <svg className="icon-on" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8.5 3.2 5.4 5.8H3v4.4h2.4l3.1 2.6V3.2Z"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinejoin="round"
              />
              <path
                d="M11 6a2.8 2.8 0 0 1 0 4M12.6 4.5a5 5 0 0 1 0 7"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {/* High Contrast Toggle */}
          <button
            type="button"
            aria-pressed={highContrast}
            aria-label="تبديل التباين العالي"
            title="وضع التباين العالي"
            onClick={() => {
              setHighContrast((prev) => !prev);
              bookStageRef.current?.playUiSound('click');
            }}
          >
            <svg className="icon-on" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="5.3" stroke="currentColor" strokeWidth="1.35" />
              <path d="M8 2.7a5.3 5.3 0 0 1 0 10.6V2.7Z" fill="currentColor" />
            </svg>
            <svg className="icon-off" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="5.3" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="8" cy="8" r="2.6" fill="currentColor" />
            </svg>
          </button>

          {/* Reduced Motion Toggle */}
          <button
            type="button"
            aria-pressed={reducedMotion}
            aria-label="تبديل تقليل الحركة"
            title="تقليل الحركة"
            onClick={() => {
              setReducedMotion((prev) => !prev);
              bookStageRef.current?.playUiSound('click');
            }}
          >
            <svg className="icon-on" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth="1.35" />
              <circle cx="8" cy="8" r="1.6" fill="currentColor" />
            </svg>
            <svg className="icon-off" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="2" stroke="currentColor" strokeWidth="1.4" />
              <rect x="6.2" y="6.2" width="3.6" height="3.6" fill="currentColor" />
            </svg>
          </button>
        </nav>
      </div>

      {/* Table of Contents Drawer */}
      <aside
        id="toc-drawer"
        className={`toc${tocOpen ? ' is-open' : ''}`}
        aria-label="فهرس الدروس"
        aria-hidden={!tocOpen}
      >
        <div className="toc-head">
          <div className="toc-head-copy">
            <span className="toc-eyebrow">INDEX · {totalSpreads} SPREADS</span>
            <span className="toc-title">محتويات الدرس الثاني</span>
          </div>
          <button
            type="button"
            className="toc-close"
            aria-label="إغلاق الفهرس"
            onClick={() => setTocOpen(false)}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
              <path
                d="m4 4 8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="toc-list">
          {spreads.map((sp, i) => {
            const totalObj = sp.scene.objects.length || 3;
            const isDone = (seenCounts[i] ?? 0) >= totalObj;
            return (
              <button
                key={sp.id}
                type="button"
                className={`toc-item${i === spreadIdx ? ' is-current' : ''}${isDone ? ' is-done' : ''}`}
                onClick={() => navigateToSpread(i, readerOpen)}
              >
                <span className="toc-num">{pad2(i + 1)}</span>
                <span className="toc-copy">
                  <span className="toc-item-title">{sp.title}</span>
                  <span className="toc-item-en">{sp.eyebrow}</span>
                </span>
                <span className="toc-page">ص {sp.page}</span>
                <span className="toc-check" aria-hidden="true">
                  ✓
                </span>
              </button>
            );
          })}
        </div>

        <div className="toc-foot">
          <div className="toc-progress" aria-hidden="true">
            <i
              style={{
                width: `${Math.round((completedSpreadsCount / Math.max(1, totalSpreads)) * 100)}%`,
              }}
            />
          </div>
          <span className="toc-progress-label">
            {pad2(completedSpreadsCount)} / {pad2(totalSpreads)} COMPLETED
          </span>
        </div>
      </aside>

      {/* Responsive Mobile Reading Mode Overlay */}
      <div
        className={`reader${readerOpen ? ' is-open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="وضع القراءة المكبّر"
        aria-hidden={!readerOpen}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setReaderOpen(false);
          }
        }}
      >
        <div className="reader-sheet">
          <div className="reader-top">
            <div className="reader-heading">
              <span className="reader-kicker">READING MODE · {currentSpread.eyebrow}</span>
              <span className="reader-index">
                {pad2(spreadIdx + 1)} / {pad2(totalSpreads)}
              </span>
            </div>

            <button
              type="button"
              className="reader-close"
              onClick={() => setReaderOpen(false)}
            >
              <span>عرض الكتاب ثلاثي الأبعاد</span>
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="m4 4 8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <div className="reader-tts-bar" role="region" aria-label="أدوات القراءة الصوتية">
            <span className="reader-tts-status">
              {ttsSnapshot.loading
                ? 'جاري تجهيز الصوت...'
                : ttsSnapshot.playing
                  ? 'جاري القراءة بالذكاء الاصطناعي...'
                  : ttsSnapshot.enabled
                    ? 'اضغط على أي نص للقراءة بالذكاء الاصطناعي'
                    : 'القارئ الصوتي متوقف'}
            </span>
            <div className="reader-tts-actions">
              <button
                type="button"
                className="reader-tts-btn"
                aria-pressed={ttsSnapshot.enabled}
                onClick={handleToggleVoice}
              >
                {ttsSnapshot.enabled ? 'الصوت: مفعّل' : 'الصوت: متوقف'}
              </button>
              <button
                type="button"
                className="reader-tts-btn"
                disabled={!ttsSnapshot.selectedText}
                onClick={handleReplayVoice}
              >
                إعادة
              </button>
              <button
                type="button"
                className="reader-tts-btn"
                disabled={!isTtsBusy}
                onClick={handleStopVoice}
              >
                إيقاف
              </button>
            </div>
          </div>

          <div className="reader-scroll">{pageElement('reader')}</div>

          <div className="reader-foot">
            <button
              type="button"
              className="reader-nav"
              disabled={flipping || spreadIdx === 0}
              onClick={() => navigateToSpread(spreadIdx - 1, true)}
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M6 3.5 10.5 8 6 12.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>الصفحة السابقة</span>
            </button>

            <span className="reader-progress">
              SPREAD {pad2(spreadIdx + 1)} / {pad2(totalSpreads)} · PAGE {currentSpread.page}
            </span>

            <button
              type="button"
              className="reader-nav"
              disabled={flipping || spreadIdx === totalSpreads - 1}
              onClick={() => navigateToSpread(spreadIdx + 1, true)}
            >
              <span>الصفحة التالية</span>
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M10 3.5 5.5 8 10 12.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Tactile Editorial Splash */}
      <div
        id="splash"
        className={splashDone ? 'is-done' : ''}
        aria-hidden={splashDone}
        onClick={() => {
          ttsService.unlockAudio();
          setSplashDone(true);
        }}
      >
        <div className="splash-inner" onClick={(e) => e.stopPropagation()}>
          <div className="splash-mark" aria-hidden="true">
            <svg viewBox="0 0 72 72" fill="none">
              <path
                d="M11 16c8-2 16 0 25 4 9-4 17-6 25-4v38c-8-2-16 0-25 4-9-4-17-6-25-4V16Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <path d="M36 20v38" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="51" cy="34" r="7" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.5 2" />
            </svg>
          </div>
          <span className="splash-eyebrow">INTERACTIVE 3D POP-UP FIELD BOOK · UNIT 02</span>
          <h2 className="splash-title">{LESSON_SCHEMA.meta.title}</h2>
          <p className="splash-sub">الدرس الثاني · الثقافة الرقمية</p>
          <div className="splash-author">
            <span className="splash-author-role">PREPARED &amp; ENGINEERED BY</span>
            <span className="splash-author-name">Engineer Ziad Saeed Ibrahim</span>
          </div>
          <button
            type="button"
            className="splash-enter-btn"
            onClick={() => {
              ttsService.unlockAudio();
              setSplashDone(true);
              bookStageRef.current?.playUiSound('click');
            }}
          >
            افتح الكتاب التفاعلي
          </button>
          <div className="splash-bar" aria-hidden="true">
            <i />
          </div>
        </div>
      </div>
    </>
  );
}
