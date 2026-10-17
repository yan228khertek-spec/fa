import { AdminError } from './types.js';

export interface TickerItem {
  text: string;
  /** Адрес страницы сайта или http(s); пусто — просто текст. */
  link: string;
}

export interface TickerStyle {
  items: TickerItem[];
  /** Цвета в виде #rrggbb. */
  bgColor: string;
  textColor: string;
}

export interface TickerSchedule extends TickerStyle {
  id: number;
  title: string;
  /** Календарные дни магазина YYYY-MM-DD, конец включительно. */
  startsOn: string;
  endsOn: string;
  active: boolean;
}

export type NewSchedule = Omit<TickerSchedule, 'id'>;

export interface TickerRepository {
  ready(): Promise<void>;
  /** null — стандартная строка ещё не редактировалась (действует встроенная). */
  getDefault(): Promise<TickerStyle | null>;
  setDefault(style: TickerStyle): Promise<void>;
  resetDefault(): Promise<void>;
  listSchedules(): Promise<TickerSchedule[]>;
  createSchedule(input: NewSchedule): Promise<TickerSchedule>;
  updateSchedule(id: number, input: NewSchedule): Promise<TickerSchedule>;
  deleteSchedule(id: number): Promise<void>;
  close(): Promise<void>;
}

/** Строка, которая показывалась на сайте до появления редактора. */
export const DEFAULT_TICKER: TickerStyle = {
  items: [
    { text: 'Бесплатная доставка по России от 20 000 ₽', link: '' },
    { text: 'Примерка при курьере по Омску', link: '' },
    { text: 'Скидки до −50% в разделе «Распродажа»', link: 'catalog.html?sale=1' },
    { text: 'Бонусная система: до 20% бонусами', link: 'club.html' },
  ],
  bgColor: '#2c2b27',
  textColor: '#ffffff',
};

/** Часовой пояс магазина: «сегодня» для графика считается по Омску, а не по серверу. */
export const SHOP_TIME_ZONE = 'Asia/Omsk';
export const MAX_ITEMS = 10;
export const MAX_SCHEDULES = 100;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function shopToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function day(v: unknown, field: string): string {
  if (typeof v !== 'string' || !DAY_RE.test(v)) throw new AdminError(`${field}: дата ГГГГ-ММ-ДД`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new AdminError(`${field}: такой даты нет`);
  }
  return v;
}

function color(v: unknown, field: string): string {
  if (typeof v !== 'string' || !COLOR_RE.test(v)) throw new AdminError(`${field}: цвет #RRGGBB`);
  return v.toLowerCase();
}

/** Ссылка: страница сайта или http(s); javascript: и прочее не принимаем. */
function link(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new AdminError('link: ожидается строка');
  const s = v.trim();
  if (s.length > 300) throw new AdminError('link: не длиннее 300 символов');
  if (s && !/^(https?:\/\/|\/|[\w.-]+\.html\b|#)/i.test(s)) {
    throw new AdminError('link: адрес страницы сайта или http(s)-ссылка');
  }
  return s;
}

export function parseItems(v: unknown): TickerItem[] {
  if (!Array.isArray(v) || v.length === 0) throw new AdminError('items: нужна хотя бы одна фраза');
  if (v.length > MAX_ITEMS) throw new AdminError(`items: не больше ${MAX_ITEMS} фраз`);
  return v.map((x, i) => {
    const raw = (x ?? {}) as { text?: unknown; link?: unknown };
    if (typeof raw.text !== 'string' || !raw.text.trim()) {
      throw new AdminError(`items[${i}]: пустая фраза`);
    }
    const text = raw.text.trim();
    if (text.length > 120) throw new AdminError(`items[${i}]: фраза не длиннее 120 символов`);
    return { text, link: link(raw.link) };
  });
}

export function parseStyle(body: Record<string, unknown>): TickerStyle {
  return {
    items: parseItems(body.items),
    bgColor: color(body.bgColor, 'bgColor'),
    textColor: color(body.textColor, 'textColor'),
  };
}

export function parseSchedule(body: Record<string, unknown>): NewSchedule {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length > 120) throw new AdminError('title: не длиннее 120 символов');
  const startsOn = day(body.startsOn, 'startsOn');
  const endsOn = day(body.endsOn, 'endsOn');
  if (endsOn < startsOn) throw new AdminError('Конец периода раньше начала');
  return { ...parseStyle(body), title, startsOn, endsOn, active: body.active !== false };
}

export type TickerSource = 'default' | 'schedule';

export interface CurrentTicker extends TickerStyle {
  source: TickerSource;
  /** Акция, по которой сейчас показывается строка. */
  scheduleId: number | null;
  title: string;
  /** Последний день акции (включительно); null для стандартной строки. */
  until: string | null;
}

export class TickerService {
  constructor(
    readonly repo: TickerRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Сегодняшний календарный день магазина (Омск). */
  today = (): string => shopToday(this.now());

  async getDefault(): Promise<TickerStyle & { isBuiltin: boolean }> {
    const saved = await this.repo.getDefault();
    return saved ? { ...saved, isBuiltin: false } : { ...DEFAULT_TICKER, isBuiltin: true };
  }

  listSchedules = () => this.repo.listSchedules();

  async setDefault(body: Record<string, unknown>): Promise<void> {
    await this.repo.setDefault(parseStyle(body));
  }

  async createSchedule(body: Record<string, unknown>): Promise<TickerSchedule> {
    if ((await this.repo.listSchedules()).length >= MAX_SCHEDULES) {
      throw new AdminError(`Не больше ${MAX_SCHEDULES} периодов`, 409);
    }
    return this.repo.createSchedule(parseSchedule(body));
  }

  updateSchedule(id: number, body: Record<string, unknown>): Promise<TickerSchedule> {
    return this.repo.updateSchedule(id, parseSchedule(body));
  }

  /**
   * Что показывать в день `today` (по умолчанию — сегодня по Омску): включённая акция, чей период
   * покрывает день; если таких несколько — та, что началась позже (вложенная акция перекрывает
   * общую), при равенстве — созданная позже. Иначе — стандартная строка.
   */
  async current(today = this.today()): Promise<CurrentTicker> {
    const all = await this.repo.listSchedules();
    const hit = all
      .filter((s) => s.active && s.startsOn <= today && today <= s.endsOn)
      .sort((a, b) => b.startsOn.localeCompare(a.startsOn) || b.id - a.id)[0];
    if (hit) {
      return {
        items: hit.items,
        bgColor: hit.bgColor,
        textColor: hit.textColor,
        source: 'schedule',
        scheduleId: hit.id,
        title: hit.title,
        until: hit.endsOn,
      };
    }
    const d = await this.getDefault();
    return {
      items: d.items,
      bgColor: d.bgColor,
      textColor: d.textColor,
      source: 'default',
      scheduleId: null,
      title: '',
      until: null,
    };
  }
}
