import { open } from 'node:fs/promises';
import iconv from 'iconv-lite';

/**
 * Кодировку выгрузки 1С определяем по заголовку XML, а не по догадке:
 * «Розница» штатно отдаёт windows-1251, но настройка узла обмена это меняет.
 */
const ALIASES: Record<string, string> = {
  'windows-1251': 'win1251',
  windows1251: 'win1251',
  'win-1251': 'win1251',
  win1251: 'win1251',
  cp1251: 'win1251',
  'windows-1252': 'win1252',
  'utf-8': 'utf8',
  utf8: 'utf8',
  'koi8-r': 'koi8-r',
  ibm866: 'cp866',
  cp866: 'cp866',
  'utf-16': 'utf16',
  'utf-16le': 'utf16-le',
  'utf-16be': 'utf16-be',
};

// BOM отрабатывает раньше по байтам, здесь остаётся только текст объявления.
const DECL_RE = /^\s*<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/i;

/** Сколько байт достаточно, чтобы увидеть объявление XML. */
export const ENCODING_SNIFF_BYTES = 512;

/**
 * Имя кодировки для iconv-lite по первым байтам файла.
 * Приоритет: BOM → объявление XML → utf8 (по спецификации XML).
 */
export function detectXmlEncoding(head: Buffer): string {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf8';
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf16-le';
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf16-be';

  const declared = DECL_RE.exec(head.toString('latin1'))?.[1]?.trim().toLowerCase();
  if (!declared) return 'utf8';
  const mapped = ALIASES[declared];
  if (mapped) return mapped;
  return iconv.encodingExists(declared) ? declared : 'utf8';
}

/** Читает первые байты файла и возвращает имя кодировки для iconv-lite. */
export async function detectFileEncoding(filePath: string): Promise<string> {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(ENCODING_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, ENCODING_SNIFF_BYTES, 0);
    return detectXmlEncoding(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}
