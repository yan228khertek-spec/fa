# Общий каркас сайта

`site.css` и `site.js` — шапка, боковое меню, подвал, cookie-баннер и уведомления для **всех** страниц.
Правка в этих двух файлах меняет весь сайт сразу.

## Как сделать новую страницу

```html
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Страница — FASHION AVENUE, Омск</title>
<link href="https://fonts.googleapis.com/css2?family=Onest:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/site.css">
<style>/* только стили этой страницы */</style>
</head>
<body>
<script src="assets/site.js"></script>   <!-- шапка и меню появляются здесь -->

<main>…содержимое страницы…</main>

<div data-site-footer></div>             <!-- подвал, cookie, уведомления -->
<script>/* код этой страницы */</script>
</body>
</html>
```

Для содержимого под фиксированной шапкой нужен верхний отступ (на странице бренда — `calc(106px + 20px)`).

## Что даёт site.js

- `openMenu()`, `closeMenu()`, `toast(текст)`, `ck(текст)` — для обработчиков на странице.
- `sw(кнопка)` — переключатель «Мужское/Женское» в шапке, `mtab(кнопка)` — вкладки меню. По умолчанию только
  подсвечивают выбор; странице, где они что-то меняют (как `brands.html`), достаточно объявить свои `sw` и `mtab`.
- Шапка прячется при прокрутке вниз, `Esc` закрывает меню.

## Где что менять

| Что                              | Где                                      |
| -------------------------------- | ---------------------------------------- |
| Пункты меню, подвал, шапка       | `HEADER` и `FOOTER` в начале `site.js`   |
| Внешний вид шапки, меню, подвала | `site.css`                               |
| Адрес бэкенда для витринного API | `API_BASE` на странице, где он нужен     |

`header.html` и `footer.html` в корне — старые заготовки, на страницах не используются.
