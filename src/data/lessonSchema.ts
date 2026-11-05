import schemaJson from '../../public/lesson-schema.json';

export type PopupObjectType =
  | 'shield'
  | 'network'
  | 'laptop'
  | 'files'
  | 'lock'
  | 'note'
  | 'phish'
  | 'badge'
  | 'usb'
  | 'botnet'
  | 'flow'
  | 'server'
  | 'review';

export interface VocabItem {
  term: string;
  def: string;
}

export interface SceneObjectDef {
  id: string;
  type: PopupObjectType;
  icon?: 'lock' | 'hook' | 'network';
  label: string;
  caption: string;
  pos: [number, number, number];
  hit: [number, number, number];
}

export interface SceneLinkDef {
  from: string;
  to: string;
  label: string;
}

export interface LessonSpread {
  id: string;
  n: number;
  page: string;
  kicker: string;
  eyebrow: string;
  title: string;
  summary: string;
  principle: {
    rule: string;
    code: string;
    caption: string;
  };
  vocab: VocabItem[];
  predict: {
    question: string;
    options: string[];
    correct: number;
    why: string;
  };
  flap: {
    locked: string;
    reveal: string;
    close: string;
  };
  scene: {
    title: string;
    figure: string;
    hint: string;
    note: string;
    accent: string;
    objects: SceneObjectDef[];
    links: SceneLinkDef[];
    legend: string;
  };
}

export interface LessonSchema {
  schemaVersion: string;
  meta: {
    title: string;
    subtitle: string;
    source: string;
    language: string;
    direction: 'rtl' | 'ltr';
    spreadCount: number;
    unit: string;
    pageRange: string;
    designLanguage: string;
  };
  spreads: LessonSpread[];
}

export const LESSON_SCHEMA: LessonSchema = schemaJson as LessonSchema;
