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
      <button class="ic" onclick="toast('Корзина')" aria-label="Корзина"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 7h12l-1 13H7L6 7z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg><span class="n" id="cnt" style="display:none">0</span></button>
    </div>
  </div>
  <div class="gender">
    <button onclick="sw(this)">Мужское</button>
    <button class="on" onclick="sw(this)">Женское</button>
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
      <a class="mlink" href="#" onclick="closeMenu();return false">Новинки</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Осень — зима 2026<sup>новое</sup></a>
      <a class="mlink red" href="#" onclick="closeMenu();return false">Распродажа</a>
    </div>
    <div class="mgrp">
      <a class="mcap" href="brands.html" style="display:block">Бренды</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Miss Sixty</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Diesel</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Annette Görtz</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Marina Rinaldi</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Karl Lagerfeld</a>
      <a class="mlink" href="brands.html">Все бренды</a>
    </div>
    <div class="mgrp">
      <div class="mcap">Каталог</div>
      <a class="mlink" href="#" onclick="closeMenu();return false">Верхняя одежда</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Трикотаж</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Платья</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Рубашки | блузы</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Джинсы | брюки</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Юбки</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Футболки | лонгсливы</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Обувь</a>
      <a class="mlink" href="#" onclick="closeMenu();return false">Сумки | аксессуары</a>
    </div>
    <div class="mgrp">
      <div class="mcap">Галерея</div>
      <a class="mlink" href="#" onclick="toast('Персональный шопинг');return false">Персональный шопинг<sup>новое</sup></a>
      <a class="mlink" href="#" onclick="toast('Клуб FA LOVERS');return false">Клуб FA LOVERS</a>
      <a class="mlink" href="#" onclick="toast('Доставка и оплата');return false">Доставка и оплата</a>
      <a class="mlink" href="#" onclick="toast('Обмен и возврат');return false">Обмен и возврат</a>
      <a class="mlink" href="#" onclick="toast('Раздел «О нас»');return false">О нас</a>
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
    <div><b>Каталог</b><a href="#">Одежда</a><a href="#">Обувь</a><a href="#">Парфюмерия</a><a href="#">Аксессуары</a><a href="brands.html">Бренды</a><a href="#" style="color:var(--red)">Распродажа</a></div>
    <div><b>Покупателям</b><a href="#">Доставка</a><a href="#">Оплата</a><a href="#">Обмен и возврат</a><a href="#">Клуб FA LOVERS</a></div>
    <div><b>Галерея</b><a href="#">О нас</a><a href="brands.html">Бренды</a><a href="#">Контакты</a><a href="#">Telegram</a></div>
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
  // по умолчанию переключатели только подсвечивают выбор; страницы, где они что-то меняют, переопределяют
  window.sw = function(b){
    [].forEach.call(b.parentNode.children, function(x){ x.classList.toggle('on', x === b); });
    window.toast(b.textContent.trim() + ' — раздел переключён');
  };
  window.mtab = function(b){
    [].forEach.call(b.parentNode.children, function(x){ x.classList.toggle('on', x === b); });
    window.toast(b.textContent.trim() + ' — раздел переключён');
  };

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
