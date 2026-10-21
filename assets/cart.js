/* Корзина Fashion Avenue — единый модуль для всех страниц.
   Корзина живёт ТОЛЬКО на клиенте (localStorage), сервер видит заказ один раз — при оформлении
   (POST /api/orders). Подключение: <script src="assets/cart.js"></script> сразу после site.js,
   на каждой странице — тогда бейдж на иконке сумки верен везде.

   Формат хранилища (ключ fa_cart): { v:1, items:[ {cardId, variantId, title, brand, size,
   color, price, photo, qty} ] }. price/photo/title — СНИМОК на момент добавления (для мгновенного
   показа в корзине); при открытии корзины позиции перепроверяются через /api/cards/:id и цена/наличие
   обновляются. Один variantId — одна строка (повторное добавление увеличивает qty). variantId —
   это sizes[].id карточки (Ид SKU 1С), его же корзина шлёт в заказ. */
(function () {
  var KEY = 'fa_cart';
  var MAX_QTY = 10;     // лимит количества в строке (контракт: maxQuantity)
  var MAX_ITEMS = 30;   // лимит числа позиций (контракт: maxItems)

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return { v: 1, items: [] };
      var d = JSON.parse(raw);
      if (!d || !Array.isArray(d.items)) return { v: 1, items: [] };
      // отсеиваем битые строки (на случай ручной порчи хранилища)
      d.items = d.items.filter(function (i) {
        return i && typeof i.cardId === 'number' && typeof i.variantId === 'string' && i.variantId;
      });
      return { v: 1, items: d.items };
    } catch (e) {
      return { v: 1, items: [] };
    }
  }

  function write(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ v: 1, items: state.items }));
    } catch (e) {}
  }

  function clampQty(n) {
    n = Math.round(Number(n) || 1);
    if (n < 1) n = 1;
    if (n > MAX_QTY) n = MAX_QTY;
    return n;
  }

  function count() {
    return read().items.reduce(function (s, i) { return s + clampQty(i.qty); }, 0);
  }

  function lines() { return read().items.length; }

  // Обновить бейдж на иконке сумки (#cnt) на текущей странице.
  function paintBadge() {
    var el = document.getElementById('cnt');
    if (!el) return;
    var n = count();
    el.textContent = n > 99 ? '99+' : String(n);
    el.style.display = n > 0 ? 'grid' : 'none';
  }

  // Добавить товар. line = {cardId, variantId, title, brand, size, color, price, photo}.
  // qty по умолчанию 1. Возвращает {ok:true} либо {ok:false, reason:'full'|'invalid'}.
  function add(line, qty) {
    if (!line || typeof line.cardId !== 'number' || typeof line.variantId !== 'string' || !line.variantId) {
      return { ok: false, reason: 'invalid' };
    }
    qty = clampQty(qty == null ? 1 : qty);
    var state = read();
    var found = null;
    for (var k = 0; k < state.items.length; k++) {
      if (state.items[k].cardId === line.cardId && state.items[k].variantId === line.variantId) {
        found = state.items[k]; break;
      }
    }
    if (found) {
      found.qty = clampQty(found.qty + qty);
      // освежаем снимок полей — вдруг цена/фото успели поменяться к этому заходу
      found.title = line.title; found.brand = line.brand; found.size = line.size;
      found.color = line.color; found.price = line.price; found.photo = line.photo;
    } else {
      if (state.items.length >= MAX_ITEMS) return { ok: false, reason: 'full' };
      state.items.push({
        cardId: line.cardId, variantId: line.variantId,
        title: line.title || '', brand: line.brand || null,
        size: line.size || '', color: line.color || null,
        price: line.price == null ? null : line.price,
        photo: line.photo || null, qty: qty
      });
    }
    write(state);
    paintBadge();
    // правка корзины делает старый idempotency-ключ оформления недействительным
    try { sessionStorage.removeItem('fa_idem'); } catch (e) {}
    return { ok: true };
  }

  // Обновить снимок полей существующей строки (цена/фото/название), НЕ меняя количество.
  // Нужно корзине, когда перепроверка нашла новую цену: заказ уходит с тем, что видит покупатель.
  function refresh(cardId, variantId, fields) {
    var state = read();
    for (var k = 0; k < state.items.length; k++) {
      if (state.items[k].cardId === cardId && state.items[k].variantId === variantId) {
        if ('price' in fields) state.items[k].price = fields.price == null ? null : fields.price;
        if ('photo' in fields) state.items[k].photo = fields.photo || null;
        if ('title' in fields) state.items[k].title = fields.title || '';
        write(state);
        break;
      }
    }
    // снимок освежён под текущие данные магазина — ключ оформления остаётся прежним:
    // покупатель подтверждает новый итог, но это та же сессия оформления (идемпотентность сохраняется
    // до фактической правки состава/формы покупателем)
  }

  function setQty(cardId, variantId, qty) {
    var state = read();
    for (var k = 0; k < state.items.length; k++) {
      if (state.items[k].cardId === cardId && state.items[k].variantId === variantId) {
        state.items[k].qty = clampQty(qty);
        break;
      }
    }
    write(state); paintBadge();
    try { sessionStorage.removeItem('fa_idem'); } catch (e) {}
  }

  function remove(cardId, variantId) {
    var state = read();
    state.items = state.items.filter(function (i) {
      return !(i.cardId === cardId && i.variantId === variantId);
    });
    write(state); paintBadge();
    try { sessionStorage.removeItem('fa_idem'); } catch (e) {}
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) {}
    paintBadge();
    try { sessionStorage.removeItem('fa_idem'); } catch (e) {}
  }

  // Идемпотентный ключ оформления: один на «сессию оформления», живёт в sessionStorage.
  // Генерируется при открытии чекаута; сбрасывается при любой правке корзины/формы и после успеха.
  function idemKey(regenerate) {
    try {
      if (regenerate) sessionStorage.removeItem('fa_idem');
      var k = sessionStorage.getItem('fa_idem');
      if (!k) {
        k = (crypto && crypto.randomUUID) ? crypto.randomUUID()
          : 'fa-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
        sessionStorage.setItem('fa_idem', k);
      }
      return k;
    } catch (e) {
      // sessionStorage недоступен — отдаём разовый ключ (ретрай тогда не идемпотентен, но заказ пройдёт)
      return (crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'fa-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    }
  }
  function dropIdemKey() { try { sessionStorage.removeItem('fa_idem'); } catch (e) {} }

  // Тело items[] для POST /api/orders: только cardId, variantId, quantity, price.
  function orderItems() {
    return read().items.map(function (i) {
      return { cardId: i.cardId, variantId: i.variantId, quantity: clampQty(i.qty),
        price: i.price == null ? null : i.price };
    });
  }

  window.FACart = {
    read: read,
    items: function () { return read().items; },
    count: count,
    lines: lines,
    add: add,
    refresh: refresh,
    setQty: setQty,
    remove: remove,
    clear: clear,
    paintBadge: paintBadge,
    idemKey: idemKey,
    dropIdemKey: dropIdemKey,
    orderItems: orderItems,
    MAX_QTY: MAX_QTY,
    MAX_ITEMS: MAX_ITEMS
  };

  // бейдж рисуем, как только появится шапка (site.js вставляет её синхронно выше по DOM)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintBadge);
  else paintBadge();
})();
