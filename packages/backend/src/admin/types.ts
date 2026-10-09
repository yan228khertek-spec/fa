/** Доменные типы витринного слоя брендов (админка). */

export type Gender = 'men' | 'women';
export const GENDERS: readonly Gender[] = ['men', 'women'];
export type ImageKind = 'photo' | 'logo';

export interface Placement {
  /** Бренд показывается в списке «Все бренды» раздела. */
  in: boolean;
  /** Бренд входит в плитки «Топ бренды» раздела. */
  top: boolean;
  /** Порядок среди топ-брендов (меньше — левее). */
  sort: number;
}

export type Placements = Record<Gender, Placement>;

/** Бренд витрины. photo/logo — имена файлов в каталоге uploads. */
export interface SiteBrand {
  id: number;
  slug: string;
  name: string;
  /** Нормализованные написания в названиях товаров (см. normalizeText). */
  aliases: string[];
  photo: string | null;
  logo: string | null;
  placements: Placements;
}

export interface NewBrand {
  name: string;
  slug: string;
  aliases: string[];
  placements: Placements;
}

/** Всё необязательное; placements — итоговые значения (слияние делает сервис). */
export interface BrandPatch {
  name?: string;
  slug?: string;
  aliases?: string[];
  placements?: Placements;
}

/** Модель каталога: «Ид товара до #». Название — из products либо из названий SKU. */
export interface CatalogModel {
  id: string;
  name: string;
  /** Артикул товара или (если товара нет) первого SKU. */
  article: string | null;
  skus: number;
  /** Путь первой картинки как в выгрузке 1С (import_files/…); null — фото нет. */
  photo: string | null;
}

export type AssignOrigin = 'auto' | 'manual';

export interface Assignment {
  modelId: string;
  brandId: number;
  origin: AssignOrigin;
}

/** Ошибка предметной области: сообщение безопасно показать оператору. */
export class AdminError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

/** Хранилище витринных данных (миграция 004). */
export interface SiteBrandRepository {
  ready(): Promise<void>;
  listBrands(): Promise<SiteBrand[]>;
  createBrand(input: NewBrand): Promise<SiteBrand>;
  updateBrand(id: number, patch: BrandPatch): Promise<SiteBrand>;
  /** Удаляет бренд (вместе с алиасами, размещениями и привязками моделей). */
  deleteBrand(id: number): Promise<void>;
  /** Пишет имя файла (null — убрать) и возвращает прежнее, чтобы удалить файл с диска. */
  setImage(id: number, kind: ImageKind, filename: string | null): Promise<string | null>;
  /** Полный новый список топ-брендов раздела; порядок массива = порядок плиток. */
  setTop(gender: Gender, brandIds: number[]): Promise<void>;
  listAssignments(): Promise<Assignment[]>;
  /** Заменяет все auto-привязки переданным набором; manual не трогает. */
  replaceAuto(items: { modelId: string; brandId: number }[]): Promise<void>;
  /** brandId = null — снять ручную привязку. */
  setManual(modelId: string, brandId: number | null): Promise<void>;
  close(): Promise<void>;
}

export interface ExchangeStatus {
  log: {
    at: string;
    type: string;
    mode: string;
    filename: string | null;
    bodyBytes: number;
    result: string;
    detail: string | null;
  }[];
  catalogRuns: Record<string, unknown>[];
  offersRuns: Record<string, unknown>[];
}

/** Чтение staging-каталога (только чтение: писать в него может один обмен). */
export interface CatalogReader {
  listModels(): Promise<CatalogModel[]>;
  /** Размеры, остатки и цены моделей — только то, что есть в staging. */
  liveData(): Promise<Map<string, LiveModel>>;
  exchangeStatus(): Promise<ExchangeStatus>;
  close(): Promise<void>;
}

// ---------- карточки товаров ----------

export type CardStatus = 'draft' | 'published';

export interface CardCharacteristic {
  name: string;
  value: string;
}

export interface CardPhoto {
  id: number;
  /** Имя файла в каталоге uploads; главное фото — с наименьшим sort. */
  file: string;
  sort: number;
}

/** Редакционная часть карточки (то, что хранится в site_cards). */
export interface SiteCard {
  id: number;
  modelId: string;
  title: string | null;
  description: string;
  characteristics: CardCharacteristic[];
  status: CardStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  photos: CardPhoto[];
}

export interface NewCard {
  modelId: string;
  title: string | null;
  description: string;
  characteristics: CardCharacteristic[];
}

export interface CardPatch {
  title?: string | null;
  description?: string;
  characteristics?: CardCharacteristic[];
  status?: CardStatus;
}

export interface CardRepository {
  ready(): Promise<void>;
  listCards(): Promise<SiteCard[]>;
  getCard(id: number): Promise<SiteCard | null>;
  createCard(input: NewCard): Promise<SiteCard>;
  updateCard(id: number, patch: CardPatch): Promise<SiteCard>;
  /** Удаляет карточку и возвращает имена её фото, чтобы убрать файлы с диска. */
  deleteCard(id: number): Promise<string[]>;
  addPhoto(cardId: number, file: string): Promise<CardPhoto>;
  /** Удаляет фото и возвращает имя файла (null — фото не было). */
  removePhoto(cardId: number, photoId: number): Promise<string | null>;
  /** Новый порядок: ids — ровно все фото карточки; первое становится главным. */
  reorderPhotos(cardId: number, ids: number[]): Promise<void>;
  close(): Promise<void>;
}

/** Размер/цвет из staging и остаток из offers (null — предложений по SKU нет). */
export interface LiveVariant {
  id: string;
  size: string | null;
  color: string | null;
  quantity: number | null;
}

/** Живые данные модели из staging: размеры, остатки, цена. Карточка их не хранит. */
export interface LiveModel {
  variants: LiveVariant[];
  /** Наименьшая цена по предложениям модели; null — цен нет (offers.xml ещё не приходил). */
  price: number | null;
  /** Сумма остатков; null — данных об остатках нет вовсе. */
  stock: number | null;
}
