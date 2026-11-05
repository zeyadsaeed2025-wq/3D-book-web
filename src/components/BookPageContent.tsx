import type React from 'react';
import type { LessonSpread } from '../data/lessonSchema';
import type { TtsSnapshot } from '../services/ttsService';

export interface TtsSpeakPayload {
  elementId: string;
  text: string;
  lang: 'ar' | 'en' | 'auto';
}

export interface BookPageContentProps {
  spread: LessonSpread;
  spreadIndex: number;
  totalSpreads: number;
  seenCount: number;
  selectedOption: number | null;
  flapOpen: boolean;
  selfAssessment: string | null;
  surface: 'page' | 'reader';
  ttsSnapshot: TtsSnapshot;
  onSelectOption: (optionIndex: number) => void;
  onToggleFlap: (open: boolean) => void;
  onSelectSelfAssessment: (value: string) => void;
  onSpeakText: (payload: TtsSpeakPayload) => void;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function getTitleSize(title: string): 'lg' | 'md' | 'sm' | 'xs' {
  const len = title.length;
  if (len <= 16) return 'lg';
  if (len <= 24) return 'md';
  if (len <= 30) return 'sm';
  return 'xs';
}

const SELF_ASSESSMENT_LEVELS = ['جيد', 'جيد جداً', 'بحاجة إلى مجهود أكبر'] as const;

export const BookPageContent: React.FC<BookPageContentProps> = ({
  spread,
  spreadIndex,
  totalSpreads,
  seenCount,
  selectedOption,
  flapOpen,
  selfAssessment,
  surface,
  ttsSnapshot,
  onSelectOption,
  onToggleFlap,
  onSelectSelfAssessment,
  onSpeakText,
}) => {
  const totalObjects = spread.scene.objects.length || 3;
  const isStamped = seenCount >= totalObjects;
  const isAnswered = selectedOption !== null;
  const accentSoft = `${spread.scene.accent}1e`;
  const summaryLines = spread.summary
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const makeReadable = (
    suffix: string,
    text: string,
    lang: 'ar' | 'en' | 'auto' = 'ar',
    baseClass = '',
  ) => {
    const elementId = `${spread.id}__${suffix}`;
    const isSpeaking =
      ttsSnapshot.activeElementId === elementId &&
      (ttsSnapshot.playing || ttsSnapshot.loading);

    return {
      'data-tts-id': elementId,
      'data-tts-text': text,
      'data-tts-lang': lang,
      title: 'اضغط على هذا السطر لتفعيل وتشغيل الصوت',
      onClick: (e: React.MouseEvent<HTMLElement>) => {
        e.stopPropagation();
        onSpeakText({ elementId, text, lang });
      },
      className: [baseClass, 'tts-readable', isSpeaking ? 'is-speaking' : '']
        .filter(Boolean)
        .join(' '),
    };
  };

  const isReviewSpread = spread.id === 'review';
  const sec2Title = isReviewSpread ? 'ثانياً: ضع علامة (✓) أو (✗)' : 'مصطلحات وأساليب الدرس';
  const sec2Spoken = isReviewSpread ? 'ثانياً: ضع علامة صواب أو خطأ' : 'مصطلحات وأساليب الدرس';
  const stampSpoken = isStamped
    ? `مكتمل: تم استكشاف جميع العناصر الثلاثة في ${spread.title}`
    : `تم استكشاف ${seenCount} من أصل ${totalObjects} عناصر في ${spread.title}`;

  return (
    <article
      className={`paper-page${flapOpen ? ' is-flap-open' : ''}`}
      style={
        {
          '--accent': spread.scene.accent,
          '--accent-soft': accentSoft,
        } as React.CSSProperties
      }
      aria-label={spread.title}
    >
      <div className="page-gutter" aria-hidden="true" />

      <div className="page-content">
        <header className="lesson-head">
          <div
            {...makeReadable('kicker', `${spread.kicker}. ${spread.eyebrow}`, 'auto', 'kicker')}
          >
            <span className="kicker-ar">{spread.kicker}</span>
            <span className="kicker-line" aria-hidden="true" />
            <span className="kicker-en">{spread.eyebrow}</span>
          </div>

          <h1
            data-size={getTitleSize(spread.title)}
            {...makeReadable('title', spread.title, 'ar', 'page-title')}
          >
            {spread.title}
          </h1>

          <div className="title-underline" aria-hidden="true">
            <svg viewBox="0 0 120 8" fill="none">
              <path
                d="M119 4 Q86 1.2 52 4 T2 3.8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </div>

          <div className="page-summary">
            {summaryLines.map((line, idx) => (
              <span
                key={`${spread.id}-sum-${idx}`}
                {...makeReadable(`summary-${idx}`, line, 'auto', 'summary-line')}
              >
                {line}
              </span>
            ))}
          </div>
        </header>

        <section className="lesson-block" aria-label={spread.principle.caption}>
          <div
            {...makeReadable('sec1-head', spread.principle.caption, 'ar', 'block-head')}
          >
            <span className="sec-num" aria-hidden="true">
              01
            </span>
            <h2 className="sec-ar">{spread.principle.caption}</h2>
            <span className="sec-en" aria-hidden="true">
              {isReviewSpread ? 'COMPLETE BLANKS' : 'KEY PRINCIPLE'}
            </span>
          </div>

          <div className="principle-box">
            <div
              {...makeReadable('principle-rule', spread.principle.rule, 'auto', 'principle-rule')}
            >
              {spread.principle.rule}
            </div>
            <div
              {...makeReadable(
                'principle-code',
                `${spread.principle.code} — ${spread.principle.rule}`,
                'auto',
                'principle-code',
              )}
            >
              {spread.principle.code}
            </div>
          </div>
        </section>

        <section className="lesson-block" aria-label={sec2Title}>
          <div {...makeReadable('sec2-head', sec2Spoken, 'ar', 'block-head')}>
            <span className="sec-num" aria-hidden="true">
              02
            </span>
            <h2 className="sec-ar">{sec2Title}</h2>
            <span className="sec-en" aria-hidden="true">
              {isReviewSpread ? 'TRUE OR FALSE' : 'KEY CONCEPTS'}
            </span>
          </div>

          <div className="terms-grid">
            {spread.vocab.map((item, i) => {
              const vocabText = `${item.term} — ${item.def}`;
              return (
                <div
                  key={`${spread.id}-term-${i}`}
                  {...makeReadable(`term-${i}`, vocabText, 'auto', 'term')}
                >
                  <div className="term-name">
                    <span className="term-i" aria-hidden="true">
                      {pad2(i + 1)}
                    </span>
                    <span>{item.term}</span>
                  </div>
                  <div className="term-def">{item.def}</div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="lesson-block" aria-label="أولاً: اختر الإجابة الصحيحة">
          <div
            {...makeReadable('sec3-head', 'أولاً: اختر الإجابة الصحيحة', 'ar', 'block-head')}
          >
            <span className="sec-num" aria-hidden="true">
              03
            </span>
            <h2 className="sec-ar">أولاً: اختر الإجابة الصحيحة</h2>
            <span className="sec-en" aria-hidden="true">
              PREDICT &amp; CHECK
            </span>
          </div>

          <fieldset className={`quiz${flapOpen ? ' show-answer' : ''}`}>
            <legend
              {...makeReadable('quiz-q', spread.predict.question, 'auto', 'quiz-q')}
            >
              {spread.predict.question}
            </legend>

            {spread.predict.options.map((opt, i) => {
              const isSelected = selectedOption === i;
              const isCorrect = i === spread.predict.correct;
              const optElementId = `${spread.id}__opt-${i}`;
              const isOptSpeaking =
                ttsSnapshot.activeElementId === optElementId &&
                (ttsSnapshot.playing || ttsSnapshot.loading);

              return (
                <label
                  key={optElementId}
                  data-tts-id={optElementId}
                  className={[
                    'opt',
                    isSelected ? 'is-selected' : '',
                    isCorrect ? 'is-correct' : '',
                    isOptSpeaking ? 'is-speaking' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if ((e.target as HTMLElement).tagName === 'INPUT') return;
                    onSpeakText({ elementId: optElementId, text: opt, lang: 'auto' });
                  }}
                >
                  <input
                    type="radio"
                    name={`q-${surface}-${spreadIndex}`}
                    value={i}
                    checked={isSelected}
                    onChange={() => onSelectOption(i)}
                  />
                  <span className="radio" aria-hidden="true" />
                  <span className="opt-text">{opt}</span>
                  <span className="answer-mark" aria-hidden="true">
                    ✓
                  </span>
                </label>
              );
            })}
          </fieldset>

          <div className={`flap-card${flapOpen ? ' is-open' : ''}`}>
            <button
              className={`flap-cover${!isAnswered ? ' is-locked' : ''}`}
              type="button"
              aria-disabled={!isAnswered}
              aria-expanded={flapOpen}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (!isAnswered) {
                  onSpeakText({
                    elementId: `${spread.id}__flap-locked`,
                    text: `${spread.flap.locked} لتفتح التفسير`,
                    lang: 'ar',
                  });
                  return;
                }
                const nextOpen = !flapOpen;
                onToggleFlap(nextOpen);
                if (nextOpen) {
                  onSpeakText({
                    elementId: `${spread.id}__why`,
                    text: spread.predict.why,
                    lang: 'auto',
                  });
                }
              }}
            >
              <span className="flap-face">
                <span className="flap-lock" aria-hidden="true">
                  {isAnswered ? (
                    <svg viewBox="0 0 16 16" fill="none">
                      <rect
                        x="3"
                        y="7.5"
                        width="10"
                        height="6.5"
                        rx="1.5"
                        stroke="currentColor"
                        strokeWidth="1.4"
                      />
                      <path
                        d="M5.5 7.5V5a2.5 2.5 0 0 1 4.7-1.2"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" fill="none">
                      <rect
                        x="3"
                        y="7.5"
                        width="10"
                        height="6.5"
                        rx="1.5"
                        stroke="currentColor"
                        strokeWidth="1.4"
                      />
                      <path
                        d="M5.5 7.5V5.2a2.5 2.5 0 0 1 5 0v2.3"
                        stroke="currentColor"
                        strokeWidth="1.4"
                      />
                    </svg>
                  )}
                </span>
                <span className="flap-main">
                  {isAnswered ? spread.flap.reveal : spread.flap.locked}
                </span>
                <span className="flap-hint">
                  {isAnswered ? 'اضغط للفتح' : 'أجب أعلاه'}
                </span>
              </span>
              <span className="flap-back" aria-hidden="true">
                ؟
              </span>
            </button>

            <div className="flap-answer" aria-hidden={!flapOpen}>
              <div
                {...makeReadable('why-label', 'التفسير من الكتاب', 'ar', 'why-label')}
              >
                WHY · التفسير من الكتاب
              </div>
              <p {...makeReadable('why', spread.predict.why, 'auto', 'why-text')}>
                {spread.predict.why}
              </p>
              <div
                {...makeReadable(
                  'answer-note',
                  spread.scene.hint,
                  'auto',
                  'answer-note',
                )}
              >
                {spread.scene.hint}
              </div>

              {isReviewSpread && (
                <div
                  className="self-assess-strip"
                  onPointerDown={(e) => e.stopPropagation()}
                  role="group"
                  aria-label="التقييم الذاتي: يمكنني أن"
                >
                  <span
                    {...makeReadable(
                      'assess-heading',
                      'تقييم ذاتي: يمكنني أن أقيّم فهمي للدرس',
                      'ar',
                      'self-assess-label',
                    )}
                  >
                    تقييم ذاتي (يمكنني أن...):
                  </span>
                  {SELF_ASSESSMENT_LEVELS.map((level) => {
                    const active = selfAssessment === level;
                    return (
                      <button
                        key={level}
                        type="button"
                        className={`self-assess-btn${active ? ' is-chosen' : ''}`}
                        aria-pressed={active}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectSelfAssessment(level);
                          onSpeakText({
                            elementId: `${spread.id}__assess-${level}`,
                            text: `التقييم الذاتي المختار: ${level}`,
                            lang: 'ar',
                          });
                        }}
                      >
                        {level}
                      </button>
                    );
                  })}
                </div>
              )}

              <button
                className="flap-close"
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFlap(false);
                }}
              >
                {spread.flap.close} ▴
              </button>
            </div>
          </div>
        </section>

        <aside className="margin-note" aria-label="نشاط وملاحظة الكتاب">
          <div className="note-rule" aria-hidden="true">
            <span />
            <i />
            <span />
          </div>
          <div
            {...makeReadable('note-head', spread.scene.title, 'ar', 'note-head')}
          >
            <span className="note-kicker">
              {spread.scene.figure} · TEXTBOOK ACTIVITY
            </span>
            <span className="note-legend">{spread.scene.title}</span>
          </div>
          <p {...makeReadable('field-note', spread.scene.note, 'auto', 'margin-note-text')}>
            {spread.scene.note}
          </p>
        </aside>
      </div>

      <footer className="page-foot">
        <div
          aria-live="polite"
          {...makeReadable('stamp', stampSpoken, 'ar', `stamp${isStamped ? ' is-stamped' : ''}`)}
        >
          <svg className="stamp-ring" viewBox="0 0 80 80" aria-hidden="true">
            <circle cx="40" cy="40" r="35" />
          </svg>
          <div className="stamp-inner">
            <span className="stamp-en">
              {isStamped ? 'VERIFIED' : 'FIELD LOG'}
            </span>
            <span className="stamp-ar">
              {isStamped ? 'أُنجزت' : 'قيد الاستكشاف'}
            </span>
            <span className="stamp-count">
              {seenCount} / {totalObjects}
            </span>
          </div>
        </div>

        <div
          {...makeReadable(
            'folio',
            `الصفحة ${spread.page} — اللوحة ${spreadIndex + 1} من ${totalSpreads}`,
            'ar',
            'folio-wrap',
          )}
        >
          <span className="folio-kicker">
            SPREAD {pad2(spreadIndex + 1)} / {pad2(totalSpreads)}
          </span>
          <span className="folio">{spread.page}</span>
        </div>
      </footer>
    </article>
  );
};
