import iconv from 'iconv-lite';
import type { FastifyReply } from 'fastify';

/**
 * Ответы протокола «Обмен с сайтом»: plain text, windows-1251,
 * строки разделены \n, БЕЗ завершающего перевода строки и BOM —
 * 1С чувствительна к лишним байтам.
 */
export function sendPlain(reply: FastifyReply, lines: string[], statusCode = 200): FastifyReply {
  const body = iconv.encode(lines.join('\n'), 'win1251');
  return reply
    .code(statusCode)
    .header('content-type', 'text/plain; charset=windows-1251')
    .send(body);
}

export function sendSuccess(reply: FastifyReply, extra: string[] = []): FastifyReply {
  return sendPlain(reply, ['success', ...extra]);
}

export function sendFailure(reply: FastifyReply, reason: string): FastifyReply {
  return sendPlain(reply, ['failure', reason]);
}

/** XML-ответ (выгрузка заказов в 1С), windows-1251. */
export function sendXml(reply: FastifyReply, xml: string): FastifyReply {
  return reply
    .code(200)
    .header('content-type', 'text/xml; charset=windows-1251')
    .send(iconv.encode(xml, 'win1251'));
}

export function emptyCommerceInfoXml(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19);
  return `<?xml version="1.0" encoding="windows-1251"?>\n<КоммерческаяИнформация ВерсияСхемы="2.05" ДатаФормирования="${stamp}"></КоммерческаяИнформация>`;
}
