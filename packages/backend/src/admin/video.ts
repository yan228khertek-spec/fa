import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sniffVideo } from './media.js';
import { AdminError } from './types.js';

/** Сколько принимаем на вход (до сжатия); Caddy пропускает до 100 МБ. */
export const MAX_VIDEO_UPLOAD_BYTES = 80 * 1024 * 1024;
/** Итоговый вес ролика на сайте: больше главная на телефоне грузится слишком долго. */
export const MAX_VIDEO_BYTES = 8 * 1024 * 1024;
/** Ролик длиннее обрезаем: баннер — зацикленная заставка, а не фильм. */
export const MAX_VIDEO_SECONDS = 30;
/** Запрос админки живёт за прокси ≤120 с, укладываемся с запасом. */
const BUDGET_MS = 100_000;

export interface CompressOptions {
  /** Ширина кадра не больше: 1920 для компьютера, 960 для телефона. */
  maxWidth: number;
  maxBytes: number;
}
/**
 * Сжимает видео в лёгкий MP4 (H.264, без звука, faststart).
 * null — сжатие недоступно (на сервере нет ffmpeg).
 */
export type VideoCompressor = (input: Buffer, opts: CompressOptions) => Promise<Buffer | null>;

/** Ступени: сначала мягко, потом сильнее и в меньшем разрешении, пока не влезет в лимит. */
const LADDER = [
  { crf: 27, scale: 1 },
  { crf: 31, scale: 0.8 },
  { crf: 35, scale: 0.6 },
];

function run(bin: string, args: string[], timeoutMs: number): Promise<'ok' | 'missing'> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-600);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') resolve('missing');
      else reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve('ok');
      else if (signal) reject(new AdminError('Сжатие видео заняло слишком много времени', 422));
      else
        reject(new AdminError(`Не удалось обработать видео: ${err.trim().split('\n').pop()}`, 422));
    });
  });
}

/** ffmpeg по одному: сжатие грузит процессор, параллельные загрузки только мешают друг другу. */
let queue: Promise<unknown> = Promise.resolve();

export function ffmpegCompressor(bin = process.env.FFMPEG_PATH || 'ffmpeg'): VideoCompressor {
  return (input, { maxWidth, maxBytes }) => {
    const job = queue.then(async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'fa-video-'));
      try {
        const src = path.join(dir, 'in');
        await writeFile(src, input);
        const started = Date.now();
        for (const step of LADDER) {
          const left = BUDGET_MS - (Date.now() - started);
          if (left < 5_000) break;
          const out = path.join(dir, `out-${step.crf}.mp4`);
          const w = Math.round((maxWidth * step.scale) / 2) * 2;
          const res = await run(
            bin,
            [
              '-nostdin',
              '-y',
              '-loglevel',
              'error',
              '-i',
              src,
              '-t',
              String(MAX_VIDEO_SECONDS),
              '-an',
              '-vf',
              `scale=min(${w}\\,iw):-2`,
              '-c:v',
              'libx264',
              '-profile:v',
              'high',
              '-pix_fmt',
              'yuv420p',
              '-preset',
              'veryfast',
              '-crf',
              String(step.crf),
              '-movflags',
              '+faststart',
              out,
            ],
            left,
          );
          if (res === 'missing') return null;
          if ((await stat(out)).size <= maxBytes) return await readFile(out);
        }
        throw new AdminError(
          `Не удалось сжать видео до ${Math.round(maxBytes / 1048576)} МБ — сделайте ролик короче или проще`,
          422,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    queue = job.catch(() => undefined);
    return job;
  };
}

export interface PosterOptions {
  /** Секунда ролика, с которой берём кадр. */
  at: number;
  /** Ширина кадра не больше: 1920 для компьютера, 960 для телефона. */
  maxWidth: number;
}
/** Достаёт кадр из видео в JPEG. null — ffmpeg на сервере нет. */
export type PosterMaker = (video: Buffer, opts: PosterOptions) => Promise<Buffer | null>;

export function ffmpegPoster(bin = process.env.FFMPEG_PATH || 'ffmpeg'): PosterMaker {
  return async (video, { at, maxWidth }) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fa-poster-'));
    try {
      const src = path.join(dir, 'in.mp4');
      const out = path.join(dir, 'out.jpg');
      await writeFile(src, video);
      const res = await run(
        bin,
        [
          '-nostdin',
          '-y',
          '-loglevel',
          'error',
          '-ss',
          String(Math.max(0, at)),
          '-i',
          src,
          '-frames:v',
          '1',
          '-vf',
          `scale=min(${maxWidth}\\,iw):-2`,
          '-q:v',
          '3',
          out,
        ],
        20_000,
      );
      if (res === 'missing') return null;
      // кадр за пределами ролика — ffmpeg не падает, а просто ничего не пишет
      const jpg = await readFile(out).catch(() => null);
      if (!jpg || jpg.length === 0) throw new AdminError('В этом месте ролика нет кадра', 422);
      return jpg;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export interface SavedVideo {
  file: string;
  before: number;
  after: number;
}

/**
 * Принимает ролик: проверяет сигнатуру, сжимает и пишет как MP4 под случайным именем.
 * Без ffmpeg принимаем только готовый MP4 не тяжелее лимита.
 */
export async function saveVideo(
  uploadsDir: string,
  body: unknown,
  kind: 'desktop' | 'mobile',
  compress: VideoCompressor,
): Promise<SavedVideo> {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new AdminError('Файл не передан');
  const ext = sniffVideo(body);
  if (!ext) throw new AdminError('Нужно видео MP4 или WebM');
  let data = await compress(body, {
    maxWidth: kind === 'mobile' ? 960 : 1920,
    maxBytes: MAX_VIDEO_BYTES,
  });
  if (!data) {
    if (ext !== 'mp4' || body.length > MAX_VIDEO_BYTES) {
      throw new AdminError(
        `На сервере нет ffmpeg для сжатия: загрузите MP4 не тяжелее ${MAX_VIDEO_BYTES / 1048576} МБ`,
        422,
      );
    }
    data = body;
  }
  const file = `${randomBytes(8).toString('hex')}.mp4`;
  await writeFile(path.join(uploadsDir, file), data, { flag: 'wx' });
  return { file, before: body.length, after: data.length };
}
