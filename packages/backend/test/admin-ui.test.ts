import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Статические проверки админ-UI: файл отдаётся браузеру как есть, поэтому
 * сторожим то, что ломается молча — CSP (внешних скриптов быть не должно)
 * и разметку перетаскиваемого окна.
 */
const UI = path.join(fileURLToPath(new URL('../public/admin/index.html', import.meta.url)));

describe('админ-UI (public/admin/index.html)', () => {
  it('не тянет внешних скриптов и стилей — CSP admin разрешает только self', async () => {
    const html = await readFile(UI, 'utf8');
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
  });

  it('у окна есть ручка перетаскивания на pointer events', async () => {
    const html = await readFile(UI, 'utf8');
    expect(html).toContain('id="dlgGrip"');
    expect(html).toContain('class="dlg-grip"');
    // sticky — чтобы тянуть можно было и при прокрученном содержимом
    expect(html).toMatch(/\.dlg-grip\s*\{[^}]*position:\s*sticky/);
    for (const api of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      expect(html).toContain(`'${api}'`);
    }
    expect(html).toContain('setPointerCapture');
    // во время перетаскивания текст не выделяется
    expect(html).toMatch(/dialog\.dragging\s*\{[^}]*user-select:\s*none/);
  });

  it('открытие окна не изменилось: showModal на месте, тело перерисовывается', async () => {
    const html = await readFile(UI, 'utf8');
    expect(html.match(/dlg\.showModal\(\)/g)).toHaveLength(2); // карточка и бренд
    expect(html).toContain('id="dlgBody"');
  });
});
