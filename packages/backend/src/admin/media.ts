export type ImageExt = 'jpg' | 'png' | 'webp' | 'avif';

/**
 * Тип картинки по сигнатуре, а не по заявленному Content-Type.
 * SVG не принимаем: это исполняемый контент.
 */
export function sniffImage(buf: Buffer): ImageExt | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  if (buf.length >= 12 && buf.toString('latin1', 4, 12) === 'ftypavif') return 'avif';
  return null;
}
