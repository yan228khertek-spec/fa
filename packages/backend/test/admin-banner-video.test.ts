import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { sniffVideo } from '../src/admin/media.js';
import { ffmpegCompressor, type VideoCompressor } from '../src/admin/video.js';

const auth = { authorization: `Basic ${Buffer.from('boss:secret').toString('base64')}` };
const write = { ...auth, 'x-fa-admin': '1' };
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
/** Минимальная «видео»-голова: ftyp + brand isom. */
const fakeMp4 = (n: number) =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(40, n)]);

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('sniffVideo', () => {
  it('узнаёт MP4 и WebM, отсекает AVIF и мусор', () => {
    expect(sniffVideo(fakeMp4(1))).toBe('mp4');
    expect(sniffVideo(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBe('webm');
    expect(
      sniffVideo(
        Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.alloc(8)]),
      ),
    ).toBeNull();
    expect(sniffVideo(png)).toBeNull();
    expect(sniffVideo(Buffer.from('hi'))).toBeNull();
  });
});

describe('видео баннера (HTTP)', () => {
  let app: FastifyInstance;
  let dir: string;
  const calls: { maxWidth: number; size: number }[] = [];

  async function make(compress: VideoCompressor) {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-bvideo-'));
    const config: AppConfig = {
      port: 0,
      host: '127.0.0.1',
      exchangeLogin: 'x',
      exchangePassword: 'y',
      fileLimit: 1024,
      spoolDir: path.join(dir, 'spool'),
      importWaitMs: 100,
      unpackLimit: 1024,
      databaseUrl: undefined,
      quiet: true,
      admin: {
        login: 'boss',
        password: 'secret',
        uploadsDir: path.join(dir, 'uploads'),
        publicBaseUrl: 'https://api.example.test',
        imagesBaseUrl: '',
      },
    };
    app = await buildApp({ config, videoCompressor: compress });
  }
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    calls.length = 0;
  });

  const post = (url: string, payload?: unknown) =>
    app.inject({ method: 'POST', url, headers: write, payload: payload as never });
  const video = (id: number, kind: string, body: Buffer, type = 'video/mp4') =>
    app.inject({
      method: 'POST',
      url: `/admin/api/banners/${id}/video/${kind}`,
      headers: { ...write, 'content-type': type },
      payload: body,
    });
  const files = () => readdir(path.join(dir, 'uploads'));

  describe('с подменённым сжатием', () => {
    beforeEach(async () => {
      await make(async (input, o) => {
        calls.push({ maxWidth: o.maxWidth, size: input.length });
        return fakeMp4(7); // «сжатый» результат
      });
    });

    it('загрузка: сжимает, хранит как .mp4, отдаёт в админку и в публичное API', async () => {
      const b = (await post('/admin/api/banners', { title: 'Видео' })).json();
      await app.inject({
        method: 'POST',
        url: `/admin/api/banners/${b.id}/image/desktop`,
        headers: { ...write, 'content-type': 'image/png' },
        payload: png,
      });
      const input = Buffer.concat([fakeMp4(1), Buffer.alloc(5000)]);
      const r = await video(b.id, 'desktop', input);
      expect(r.statusCode).toBe(200);
      const j = r.json();
      expect(j.video).toMatch(/^https:\/\/api\.example\.test\/uploads\/[0-9a-f]{16}\.mp4$/);
      expect(j.videoBytes).toBe(fakeMp4(7).length);
      expect(j.compression).toEqual({ before: input.length, after: fakeMp4(7).length });
      expect(calls).toEqual([{ maxWidth: 1920, size: input.length }]);

      await video(b.id, 'mobile', input, 'video/webm'.replace('webm', 'mp4'));
      expect(calls[1]!.maxWidth).toBe(960);

      const pub = (await app.inject({ method: 'GET', url: '/api/banners' })).json().items[0];
      expect(pub.video).toMatch(/\.mp4$/);
      expect(pub.videoMobile).toMatch(/\.mp4$/);

      const list = (
        await app.inject({ method: 'GET', url: '/admin/api/banners', headers: auth })
      ).json();
      expect(list[0].videoBytes).toBe(fakeMp4(7).length);
    });

    it('замена и удаление чистят файлы, удаление баннера — тоже', async () => {
      const b = (await post('/admin/api/banners', {})).json();
      await video(b.id, 'desktop', fakeMp4(1));
      expect(await files()).toHaveLength(1);
      await video(b.id, 'desktop', fakeMp4(2));
      expect(await files()).toHaveLength(1);
      const del = await app.inject({
        method: 'DELETE',
        url: `/admin/api/banners/${b.id}/video/desktop`,
        headers: write,
      });
      expect(del.json().video).toBeNull();
      expect(await files()).toHaveLength(0);
      await video(b.id, 'mobile', fakeMp4(3));
      await app.inject({ method: 'DELETE', url: `/admin/api/banners/${b.id}`, headers: write });
      expect(await files()).toHaveLength(0);
    });

    it('отклоняет не-видео, пустое тело, чужой kind и несуществующий баннер', async () => {
      const b = (await post('/admin/api/banners', {})).json();
      expect((await video(b.id, 'desktop', png, 'video/mp4')).statusCode).toBe(400);
      expect((await video(b.id, 'tablet', fakeMp4(1))).statusCode).toBe(400);
      expect((await video(999, 'desktop', fakeMp4(1))).statusCode).toBe(404);
      expect(await files()).toHaveLength(0);
    });

    it('принимает ролики больше 8 МБ (лимит картинок на видео не действует)', async () => {
      const b = (await post('/admin/api/banners', {})).json();
      const big = Buffer.concat([fakeMp4(1), Buffer.alloc(20 * 1024 * 1024)]);
      expect((await video(b.id, 'desktop', big)).statusCode).toBe(200);
    });

    it('отдаёт mp4 с Range: 206, 416 и полный ответ', async () => {
      const b = (await post('/admin/api/banners', {})).json();
      const j = (await video(b.id, 'desktop', fakeMp4(1))).json();
      const url = new URL(j.video).pathname;
      const full = await app.inject({ method: 'GET', url });
      expect(full.headers['content-type']).toBe('video/mp4');
      expect(full.headers['accept-ranges']).toBe('bytes');
      const total = fakeMp4(7).length;
      expect(full.rawPayload.length).toBe(total);
      const part = await app.inject({ method: 'GET', url, headers: { range: 'bytes=4-11' } });
      expect(part.statusCode).toBe(206);
      expect(part.headers['content-range']).toBe(`bytes 4-11/${total}`);
      expect(part.rawPayload.toString('latin1')).toBe('ftypisom');
      const tail = await app.inject({ method: 'GET', url, headers: { range: 'bytes=-8' } });
      expect(tail.headers['content-range']).toBe(`bytes ${total - 8}-${total - 1}/${total}`);
      const bad = await app.inject({
        method: 'GET',
        url,
        headers: { range: `bytes=${total + 5}-` },
      });
      expect(bad.statusCode).toBe(416);
    });
  });

  it('без ffmpeg принимает только готовый лёгкий MP4', async () => {
    await make(async () => null);
    const b = (await post('/admin/api/banners', {})).json();
    expect((await video(b.id, 'desktop', fakeMp4(1))).statusCode).toBe(200);
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100)]);
    const r = await video(b.id, 'desktop', webm, 'video/webm');
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain('ffmpeg');
    const heavy = Buffer.concat([fakeMp4(1), Buffer.alloc(9 * 1024 * 1024)]);
    expect((await video(b.id, 'desktop', heavy)).statusCode).toBe(422);
  });

  describe.skipIf(!hasFfmpeg)('настоящий ffmpeg', () => {
    let src: string;
    let work: string;
    beforeAll(async () => {
      work = await mkdtemp(path.join(tmpdir(), 'fa-ffsrc-'));
      src = path.join(work, 'src.mp4');
      // 1280×720, 3 с, почти без сжатия — заведомо тяжёлый исходник
      execFileSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=duration=3:size=1280x720:rate=25',
        '-c:v',
        'libx264',
        '-crf',
        '8',
        '-pix_fmt',
        'yuv420p',
        src,
      ]);
    });
    afterAll(async () => rm(work, { recursive: true, force: true }));

    const probe = (file: string) =>
      JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]).toString(),
      ).streams as { codec_type: string; codec_name: string; width?: number }[];

    it('сжимает: меньше по весу, H.264 без звука, мобильный не шире 960', async () => {
      await make(ffmpegCompressor());
      const b = (await post('/admin/api/banners', {})).json();
      const input = await readFile(src);
      const d = (await video(b.id, 'desktop', input)).json();
      expect(d.compression.after).toBeLessThan(d.compression.before);
      expect(d.compression.after).toBeLessThanOrEqual(8 * 1024 * 1024);
      const m = (await video(b.id, 'mobile', input)).json();
      const out = path.join(dir, 'uploads', path.basename(new URL(m.videoMobile).pathname));
      const streams = probe(out);
      expect(streams.map((s) => s.codec_type)).toEqual(['video']);
      expect(streams[0]).toMatchObject({ codec_name: 'h264' });
      expect(streams[0]!.width).toBeLessThanOrEqual(960);
    }, 60_000);

    it('мусор под видом видео не проходит', async () => {
      await make(ffmpegCompressor());
      const b = (await post('/admin/api/banners', {})).json();
      const fake = Buffer.concat([fakeMp4(1), Buffer.alloc(200, 9)]);
      const r = await video(b.id, 'desktop', fake);
      expect(r.statusCode).toBe(422);
      expect(await files()).toHaveLength(0);
    }, 60_000);
  });
});
