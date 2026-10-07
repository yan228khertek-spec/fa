export interface ImportJob {
  status: 'running' | 'done' | 'failed';
  /** Подробности для журнала обмена: счётчики либо текст ошибки. */
  detail: string | null;
  /** Исходная ошибка — по ней вызывающий решает, что сказать 1С. */
  error: unknown;
  startedAt: number;
  promise: Promise<void>;
}

/**
 * Реестр запущенных загрузок каталога, по одной на имя файла.
 *
 * Протокол «Обмена с сайтом» разрешает отвечать на mode=import `progress` —
 * тогда 1С повторит запрос через паузу. Полная выгрузка «Concept» (10–15 тыс.
 * SKU) в один HTTP-запрос не укладывается: прокси и 1С рвут соединение по
 * таймауту. Поэтому короткие файлы отдают `success` сразу (см. settleWithin),
 * а длинные продолжают грузиться в фоне и отвечают `progress` до готовности.
 */
export class ImportJobRegistry {
  private jobs = new Map<string, ImportJob>();
  /** Задания, снятые с реестра, но ещё работающие: их тоже ждёт drain(). */
  private retired: ImportJob[] = [];

  get(key: string): ImportJob | undefined {
    return this.jobs.get(key);
  }

  /**
   * Заводит задание под ключом, если его там ещё нет, и возвращает актуальное.
   * Проверка и запись идут без await между ними, поэтому два одновременных
   * mode=import (ретрай 1С или прокси) получают ОДНО задание, а не два
   * параллельных разбора одного файла (ревью этапа 2, находка 3).
   * task возвращает текст для журнала/второй строки ответа.
   */
  start(key: string, task: () => Promise<string | null>): ImportJob {
    const running = this.jobs.get(key);
    if (running) return running;
    const job: ImportJob = {
      status: 'running',
      detail: null,
      error: null,
      startedAt: Date.now(),
      promise: Promise.resolve(),
    };
    job.promise = task().then(
      (detail) => {
        job.status = 'done';
        job.detail = detail;
      },
      (err: unknown) => {
        job.status = 'failed';
        job.error = err;
        job.detail = err instanceof Error ? err.message : String(err);
      },
    );
    this.jobs.set(key, job);
    return job;
  }

  delete(key: string): void {
    this.jobs.delete(key);
  }

  /**
   * Сброс перед новой сессией обмена (mode=init). Незавершённые задания
   * не бросаем: читают они уже открытый файловый дескриптор, поэтому
   * очистка spool им не мешает, а дописаться до закрытия пула они обязаны.
   */
  clear(): void {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') this.retired.push(job);
    }
    this.jobs.clear();
  }

  /** Дождаться всех фоновых загрузок (закрытие приложения, тесты). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.jobs.values(), ...this.retired].map((job) => job.promise));
    this.retired = [];
  }
}

/** Ждёт завершения задания не дольше timeoutMs; true — успело. */
export async function settleWithin(job: ImportJob, timeoutMs: number): Promise<boolean> {
  if (job.status !== 'running') return true;
  if (timeoutMs <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([job.promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return job.status !== 'running';
}
