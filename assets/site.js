/* Общий каркас сайта Fashion Avenue: вставляет шапку, меню, подвал, cookie и уведомления.
   Подключение: <script src="assets/site.js"></script> сразу после <body> (шапка и меню появляются
   без мигания), а на месте подвала — <div data-site-footer></div>.
   Страница может переопределить sw(кнопка) — переключатель «Мужское/Женское» и mtab(кнопка) — вкладки меню. */
(function(){
  var HEADER = `<header>
  <div class="bar">
    <button class="ic" onclick="openMenu()" aria-label="Меню"><span class="burger"><i></i></span></button>
    <a class="logo" href="index.html">FASHION AVENUE<small>ГАЛЕРЕЯ МОДЫ · ОМСК</small></a>
    <div class="right">
      <button class="ic" onclick="toast('Поиск по каталогу')" aria-label="Поиск"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg></button>
      <a class="ic" href="cart.html" aria-label="Корзина"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4.5" y="8" width="15" height="12.5" rx="1.2"/><path d="M8.5 8V7a3.5 3.5 0 0 1 7 0v1"/></svg><span class="n" id="cnt" style="display:none">0</span></a>
    </div>
  </div>
  <div class="gender">
    <button class="on" onclick="sw(this)">Женское</button>
    <button onclick="sw(this)">Мужское</button>
  </div>
</header>

<!-- МЕНЮ -->
<div class="menu-overlay" id="menuOverlay" onclick="closeMenu()"></div>
<div class="menu" id="menu">
  <div class="mtop"><button onclick="closeMenu()" aria-label="Закрыть">‹</button></div>
  <div class="mtabs">
    <button class="on" onclick="mtab(this)">Женщины</button>
    <button onclick="mtab(this)">Мужчины</button>
    <button onclick="mtab(this)">Парфюмерия</button>
  </div>
  <div class="mscroll">
    <div class="mgrp">
      <a class="mlink" href="catalog.html">Осень Зима 2026/27<sup>новое</sup></a>
      <a class="mlink red" href="catalog.html?sale=1">Распродажа</a>
    </div>
    <div class="mgrp">
      <div class="macc" id="mbAcc"><button class="mlink" onclick="faAcc(this)" aria-expanded="false">Бренды<i></i></button>
        <div class="msub mb" id="mbList"></div></div>
      <div class="macc"><button class="mlink" onclick="faAcc(this)" aria-expanded="false">Одежда<i></i></button>
        <div class="msub" data-cat="Одежда"><a href="catalog.html?category=Одежда">Вся одежда</a></div></div>
      <div class="macc"><button class="mlink" onclick="faAcc(this)" aria-expanded="false">Обувь<i></i></button>
        <div class="msub" data-cat="Обувь"><a href="catalog.html?category=Обувь">Вся обувь</a></div></div>
      <a class="mlink" href="catalog.html?category=Сумки">Сумки</a>
      <a class="mlink" href="catalog.html?category=Аксессуары">Аксессуары</a>
    </div>
    <div class="mgrp">
      <div class="mcap">Галерея</div>
      <a class="mlink" href="shopping.html">Персональный шопинг<sup>новое</sup></a>
      <a class="mlink" href="club.html">Бонусная система</a>
      <a class="mlink" href="delivery.html">Доставка и оплата</a>
      <a class="mlink" href="returns.html">Обмен и возврат</a>
      <a class="mlink" href="about.html">О нас</a>
    </div>
  </div>
  <div class="mfoot">
    <span class="l"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>Профиль</span>
    <span class="r" onclick="toast('Чат с менеджером')">Чат</span>
  </div>
</div>`;
  var FOOTER = `<footer><div class="wrap">
  <div class="fg">
    <div><b>Fashion Avenue</b>
      <p>Галерея моды в центре Омска. Избранные бренды Италии, Германии и Франции.</p>
      <p>Омск, ул. Маршала Жукова, 65<br>+7 (3812) 390-007</p></div>
    <div><b>Каталог</b><a href="catalog.html?category=Одежда">Одежда</a><a href="catalog.html?category=Обувь">Обувь</a><a href="catalog.html?category=Сумки">Сумки</a><a href="catalog.html?category=Парфюмерия">Парфюмерия</a><a href="catalog.html?category=Аксессуары">Аксессуары</a><a href="brands.html">Бренды</a><a href="catalog.html?sale=1" style="color:var(--red)">Распродажа</a></div>
    <div><b>Покупателям</b><a href="delivery.html#delivery">Доставка</a><a href="delivery.html#payment">Оплата</a><a href="returns.html">Обмен и возврат</a><a href="club.html">Бонусная система</a></div>
    <div><b>Галерея</b><a href="about.html">О нас</a><a href="brands.html">Бренды</a><a href="about.html#contacts">Контакты</a><a href="#">Telegram</a></div>
  </div>
  <div class="legal">© 2026 Fashion Avenue · Политика конфиденциальности · Согласие на обработку персональных данных · Публичная оферта<br>Персональные данные обрабатываются на серверах в России в соответствии с 152-ФЗ</div>
</div></footer>

<!-- COOKIE -->
<div class="cdim" id="cdim"></div>
<div class="cookie" id="cookie">
  <p>Мы используем собственные и сторонние файлы cookie, чтобы понимать, как используется наш магазин, улучшать его работу и подбирать для вас содержимое. Вы можете принять их все, отклонить необязательные или настроить по своему усмотрению. Подробнее — <a href="#" onclick="toast('Политика использования cookie');return false">Политика cookie</a></p>
  <div class="btns">
    <button class="b" onclick="ck('Все файлы cookie приняты')">Принять все cookie</button>
    <button class="b" onclick="ck('Необязательные cookie отклонены')">Отклонить необязательные</button>
    <button class="b line" onclick="toast('Настройки cookie по категориям')">Настройки cookie</button>
  </div>
</div>

<div class="toast" id="toast"></div>`;

  // Ответ на cookie-баннер помним до закрытия вкладки. Чтобы помнить дольше, замените sessionStorage на localStorage.
  var STORE = 'fa_cookie_answer';
  function cookieAnswered(){ try { return !!sessionStorage.getItem(STORE); } catch (e) { return false; } }
  function rememberCookieAnswer(m){ try { sessionStorage.setItem(STORE, m); } catch (e) {} }

  var me = document.currentScript;
  me.insertAdjacentHTML('beforebegin', HEADER);

  // Бегущую строку (если страница её содержит — сейчас только главная) переносим
  // первым элементом внутрь шапки. Иначе фиксированная шапка (top:0) ложится
  // поверх строки и полностью её скрывает. Внутри шапки строка видна над баром
  // и скрывается/появляется вместе с шапкой при скролле.
  var tick = document.querySelector('.tick');
  var hdr = document.querySelector('header');
  if (tick && hdr) {
    hdr.insertBefore(tick, hdr.firstChild);
    hdr.classList.add('has-tick');
  }

  function mountFooter(){
    var slot = document.querySelector('[data-site-footer]');
    if (slot) slot.outerHTML = FOOTER;
    else document.body.insertAdjacentHTML('beforeend', FOOTER);
    // cookie-баннер: показываем после загрузки, если выбор ещё не сделан в этой сессии
    if (cookieAnswered()) return;
    setTimeout(function(){
      var c = document.getElementById('cookie'), d = document.getElementById('cdim');
      if (c) c.classList.add('on');
      if (d) d.classList.add('on');
    }, 700);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountFooter);
  else mountFooter();

  window.openMenu = function(){
    document.getElementById('menu').classList.add('on');
    document.getElementById('menuOverlay').classList.add('on');
    document.body.style.overflow = 'hidden';
  };
  window.closeMenu = function(){
    document.getElementById('menu').classList.remove('on');
    document.getElementById('menuOverlay').classList.remove('on');
    document.body.style.overflow = '';
  };
  window.ck = function(m){
    rememberCookieAnswer(m);
    document.getElementById('cookie').classList.remove('on');
    document.getElementById('cdim').classList.remove('on');
    window.toast(m);
  };
  var tt;
  window.toast = function(m){
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = m; t.classList.add('on');
    clearTimeout(tt); tt = setTimeout(function(){ t.classList.remove('on'); }, 2200);
  };
  // ── Пол витрины (Мужское/Женское): один на все страницы сессии; шапка и меню меняются синхронно ──
  var API_BASE = 'https://1c-dev.avenuefashion.online';
  var topBrands = { women: null, men: null };
  var perfume = false;
  function storedGender(){ try { return sessionStorage.getItem('fa_gender') === 'men' ? 'men' : 'women'; } catch (e) { return 'women'; } }
  var gender = storedGender();
  function esc(t){ return String(t == null ? '' : t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function renderMenuBrands(){
    var box = document.getElementById('mbList');
    if (!box) return;
    var list = perfume ? [] : (topBrands[gender] || []);
    var acc = document.getElementById('mbAcc');
    if (acc) acc.style.display = list.length ? '' : 'none';
    box.innerHTML = list.map(function(b){
      return '<a href="brand.html?slug=' + encodeURIComponent(b.slug) + '">' + esc(b.name) + '</a>';
    }).join('');
  }
  function paintSwitchers(){
    var hb = document.querySelectorAll('.gender button');
    if (hb.length > 1){ hb[0].classList.toggle('on', gender === 'women'); hb[1].classList.toggle('on', gender === 'men'); }
    var mb = document.querySelectorAll('.mtabs button');
    if (mb.length > 2){
      mb[0].classList.toggle('on', !perfume && gender === 'women');
      mb[1].classList.toggle('on', !perfume && gender === 'men');
      mb[2].classList.toggle('on', perfume);
    }
  }
  function loadTopBrands(g){
    fetch(API_BASE + '/api/brands?gender=' + g).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
      if (!d) return;
      // топ задаётся в админке; если его ещё не заполнили — первые бренды общего списка
      topBrands[g] = (d.top && d.top.length ? d.top : (d.all || []).slice(0, 8));
      if (g === gender) renderMenuBrands();
    }).catch(function(){});
  }
  // ── Название типа изделия во множественном числе для фильтров: «Платье» → «Платья».
  // В 1С тип — первое слово названия в единственном числе; в фильтре показываем только подпись, значение остаётся прежним.
  var KIND_EXC = { 'пальто':'Пальто','полупальто':'Полупальто','боди':'Боди','худи':'Худи','поло':'Поло','кимоно':'Кимоно',
    'сабо':'Сабо','бикини':'Бикини','ремень':'Ремни','платок':'Платки','кошелёк':'Кошельки','кошелек':'Кошельки',
    'галстук':'Галстуки','пиджак':'Пиджаки','пуховик':'Пуховики','мюли':'Мюли','топ':'Топы','кеды':'Кеды',
    'туфли':'Туфли','очки':'Очки','часы':'Часы' };
  window.faKind = function(name){
    var w = String(name || '').trim(), l = w.toLowerCase();
    if (!w) return w;
    if (KIND_EXC[l]) return KIND_EXC[l];
    var last = l.slice(-1), pre = l.slice(-2, -1), r;
    if (/[ыи]$/.test(l)) return w;                       // уже во множественном: Брюки, Шорты, Джинсы
    if (/[ое]$/.test(l)) {
      if (/(ье|ие)$/.test(l)) r = w.slice(0, -1) + 'я'; // Платье → Платья
      else return w;                                    // несклоняемые: Пальто, Бикини
    }
    else if (last === 'а') r = w.slice(0, -1) + (/[гкхжшщч]/.test(pre) ? 'и' : 'ы'); // Куртка → Куртки, Блуза → Блузы
    else if (last === 'я') r = w.slice(0, -1) + 'и';
    else if (last === 'ь') r = w.slice(0, -1) + 'и';
    else if (last === 'й') r = w.slice(0, -1) + 'и';
    else r = w + (/[гкхжшщч]$/.test(l) ? 'и' : 'ы');    // Джемпер → Джемперы, Жилет → Жилеты
    return r;
  };
  // Подкатегории меню («Одежда», «Обувь») — реальные типы товаров из витрины; раскрываются по клику
  window.faAcc = function(b){
    var open = b.parentNode.classList.toggle('open');
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  function loadMenuKinds(){
    [].forEach.call(document.querySelectorAll('.msub[data-cat]'), function(box){
      var cat = box.getAttribute('data-cat');
      fetch(API_BASE + '/api/cards?limit=1&category=' + encodeURIComponent(cat)).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
        if (!d || !d.facets.kinds.length) return;
        box.innerHTML += d.facets.kinds.map(function(k){
          return '<a href="catalog.html?category=' + encodeURIComponent(cat) + '&kind=' + encodeURIComponent(k.name) + '">' + esc(window.faKind(k.name)) + '</a>';
        }).join('');
      }).catch(function(){});
    });
  }
  window.faGender = function(){ return gender; };
  window.faSetGender = function(g, quiet){
    gender = g === 'men' ? 'men' : 'women';
    perfume = false;
    try { sessionStorage.setItem('fa_gender', gender); } catch (e) {}
    paintSwitchers(); renderMenuBrands();
    try { document.dispatchEvent(new CustomEvent('fa:gender', { detail: gender })); } catch (e) {}
    if (!quiet) window.toast((gender === 'men' ? 'Мужское' : 'Женское') + ' — раздел переключён');
  };
  // шапка: Мужское/Женское; страницы, которым нужно больше (список брендов на «Брендах»), вызывают faSetGender сами
  window.sw = function(b){ window.faSetGender(b.textContent.trim() === 'Мужское' ? 'men' : 'women'); };
  window.mtab = function(b){
    var t = b.textContent.trim();
    if (t === 'Мужчины') return window.sw({ textContent: 'Мужское' });
    if (t === 'Женщины') return window.sw({ textContent: 'Женское' });
    location.href = 'catalog.html?category=' + encodeURIComponent('Парфюмерия');
  };
  window.faMtab = window.mtab;   // страницы, переопределяющие mtab, могут вызвать общую версию
  paintSwitchers();
  loadTopBrands('women'); loadTopBrands('men'); loadMenuKinds();

  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') window.closeMenu(); });

  // шапка прячется при скролле вниз и возвращается при скролле вверх
  var header = document.querySelector('header'), lastY = 0;
  addEventListener('scroll', function(){
    var y = scrollY;
    if (y > lastY && y > 80) header.classList.add('hidden');
    else if (y < lastY) header.classList.remove('hidden');
    if (y <= 0) header.classList.remove('hidden');
    lastY = y;
  }, {passive:true});
})();
