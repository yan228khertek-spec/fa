/* Фильтр и сортировка списка товаров (каталог и страница бренда) — как у Peak:
   в строке над товарами слева «Фильтр +», справа «Сначала новинки ⌄»; фильтр открывается панелью
   с раскрывающимися секциями и кнопкой «Применить».
   Подключение: <script src="assets/listing.js"></script>, на странице <div id="tb"></div> над товарами.
   Состояние живёт в объекте страницы S (S.sort, S.brands, S.sizes, S.colors, S.pmin, S.pmax);
   страница зовёт FAList.qs(S) при запросе, FAList.read/write при чтении и записи адреса,
   FAList.render(S, opts) после ответа сервера и FAList.init(S, {onChange, showBrands}) один раз. */
(function(){
  var SORTS=[['new','Сначала новинки'],['priceDesc','Сначала дороже'],['priceAsc','Сначала дешевле']];
  var css='\
#tb{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 0 18px;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);position:relative}\
#tb[hidden]{display:none}\
#tb button{font-size:12.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;display:flex;align-items:center;gap:8px;color:var(--graphite);padding:4px 0}\
#tb .tb-f b{font-weight:400;font-size:18px;line-height:1}\
#tb .tb-n{background:var(--graphite);color:#fff;border-radius:9px;min-width:18px;height:18px;padding:0 5px;font-size:11px;display:inline-flex;align-items:center;justify-content:center;letter-spacing:0}\
#tb .tb-s i{width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);margin-top:-3px;transition:transform .2s}\
#tb .tb-s.open i{transform:rotate(-135deg);margin-top:3px}\
.tb-menu{position:absolute;right:0;top:100%;background:#fff;border:1px solid var(--line2);z-index:30;min-width:210px;display:none;box-shadow:0 8px 24px rgba(0,0,0,.08)}\
.tb-menu.open{display:block}\
#tb .tb-menu button{display:block;width:100%;text-align:left;padding:13px 16px;font-weight:500;color:var(--muted);text-transform:none;letter-spacing:.02em;font-size:14px}\
#tb .tb-menu button.on{color:var(--graphite);font-weight:700}\
.fl-ov{position:fixed;inset:0;background:rgba(0,0,0,.4);opacity:0;pointer-events:none;transition:opacity .25s;z-index:103}\
.fl-ov.on{opacity:1;pointer-events:auto}\
.fl{position:fixed;top:0;right:0;bottom:0;width:100%;max-width:440px;background:#fff;z-index:104;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .28s}\
.fl.on{transform:none}\
.fl-h{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--line)}\
.fl-h b{font-size:16px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}\
.fl-h span{display:flex;gap:18px;align-items:center}\
.fl-h button{font-size:13px;color:var(--muted)}\
.fl-h .fl-x{font-size:26px;line-height:1;color:var(--graphite)}\
.fl-b{flex:1;overflow-y:auto;padding:0 20px}\
.fl-s{border-bottom:1px solid var(--line)}\
.fl-st{width:100%;display:flex;justify-content:space-between;align-items:center;padding:20px 0;font-size:15px;text-align:left}\
.fl-st small{color:var(--muted);font-size:12px;margin-left:8px}\
.fl-st i{display:block;flex:none;width:8px;height:8px;border-right:1.5px solid var(--graphite);border-bottom:1.5px solid var(--graphite);transform:rotate(45deg);margin:-3px 4px 0 0;transition:transform .2s}\
.fl-s.open .fl-st i{transform:rotate(-135deg);margin-top:3px}\
.fl-sb{display:none;padding:0 0 18px}\
.fl-s.open .fl-sb{display:block}\
.fl-o{display:flex;align-items:center;gap:12px;padding:9px 0;font-size:14px;cursor:pointer}\
.fl-o input{width:17px;height:17px;accent-color:var(--graphite);flex:none}\
.fl-o i{font-style:normal;color:var(--muted);font-size:12px;margin-left:auto}\
.fl-sz{display:flex;flex-wrap:wrap;gap:8px}\
.fl-sz label{min-width:50px;text-align:center;border:1px solid var(--line2);padding:10px 12px;font-size:13px;cursor:pointer}\
.fl-sz input{position:absolute;opacity:0;pointer-events:none}\
.fl-sz label:has(input:checked){background:var(--graphite);color:#fff;border-color:var(--graphite)}\
.fl-pr{display:flex;gap:12px;align-items:center}\
.fl-pr input{width:100%;border:1px solid var(--line2);padding:12px;font-size:14px;font-family:inherit;border-radius:0;-moz-appearance:textfield}\
.fl-pr input::-webkit-outer-spin-button,.fl-pr input::-webkit-inner-spin-button{-webkit-appearance:none}\
.fl-f{padding:14px 20px calc(14px + env(safe-area-inset-bottom));border-top:1px solid var(--line)}\
.fl-f button{width:100%;background:var(--graphite);color:#fff;padding:16px;font-size:12.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase}';
  var st=document.createElement('style');st.textContent=css;document.head.appendChild(st);

  var esc=function(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};
  var csv=function(v){return v?String(v).split(',').filter(Boolean):[]};
  var cfg={showBrands:false,onChange:function(){}},facets=null,box=null,pend=null,S=null,openSec={};

  var FAList=window.FAList={
    /* читаем фильтры из адреса страницы */
    read:function(q,s){
      s.sort=q.get('sort')==='priceAsc'||q.get('sort')==='priceDesc'?q.get('sort'):'';
      s.brands=csv(q.get('brand'));s.sizes=csv(q.get('size'));s.colors=csv(q.get('color'));
      s.pmin=q.get('pmin')||'';s.pmax=q.get('pmax')||'';
    },
    /* пишем в адрес только то, что выбрано */
    write:function(p,s){
      if(s.sort)p.set('sort',s.sort);
      if(s.brands.length)p.set('brand',s.brands.join(','));
      if(s.sizes.length)p.set('size',s.sizes.join(','));
      if(s.colors.length)p.set('color',s.colors.join(','));
      if(s.pmin!=='')p.set('pmin',s.pmin);
      if(s.pmax!=='')p.set('pmax',s.pmax);
    },
    /* хвост запроса к API: &sort=…&size=… */
    qs:function(s){
      var p=new URLSearchParams();FAList.write(p,s);
      var t=p.toString();return t?'&'+t:'';
    },
    count:function(s){return s.brands.length+s.sizes.length+s.colors.length+(s.pmin!==''||s.pmax!==''?1:0)},
    init:function(s,o){S=s;cfg=Object.assign(cfg,o||{});box=document.getElementById('tb');
      var ov=document.createElement('div');ov.className='fl-ov';ov.id='flOv';
      var pn=document.createElement('aside');pn.className='fl';pn.id='fl';pn.setAttribute('role','dialog');pn.setAttribute('aria-label','Фильтр');
      document.body.appendChild(ov);document.body.appendChild(pn);
      ov.addEventListener('click',close);
      document.addEventListener('keydown',function(e){if(e.key==='Escape'){close();menu(false)}});
      document.addEventListener('click',function(e){if(!e.target.closest('#tb'))menu(false)});
      box.addEventListener('click',function(e){
        var f=e.target.closest('.tb-f'),s2=e.target.closest('.tb-s'),m=e.target.closest('.tb-menu button');
        if(f){open();return}
        if(s2){menu(!document.querySelector('.tb-menu').classList.contains('open'));return}
        if(m){S.sort=m.dataset.s==='new'?'':m.dataset.s;menu(false);cfg.onChange()}
      });
      pn.addEventListener('click',function(e){
        var t=e.target.closest('.fl-st');
        if(t){var sec=t.parentNode;sec.classList.toggle('open');openSec[sec.dataset.k]=sec.classList.contains('open');return}
        if(e.target.closest('.fl-x')){close();return}
        if(e.target.closest('.fl-clear')){pend={brands:[],sizes:[],colors:[],pmin:'',pmax:''};panel();return}
        if(e.target.closest('.fl-apply')){
          S.brands=pend.brands;S.sizes=pend.sizes;S.colors=pend.colors;S.pmin=pend.pmin;S.pmax=pend.pmax;close();cfg.onChange()
        }
      });
      pn.addEventListener('change',function(e){
        var i=e.target;if(!i.dataset.f)return;
        if(i.dataset.f==='pmin'||i.dataset.f==='pmax'){pend[i.dataset.f]=i.value.replace(/\D/g,'');return}
        var a=pend[i.dataset.f],v=i.value,k=a.indexOf(v);
        if(i.checked&&k<0)a.push(v);if(!i.checked&&k>=0)a.splice(k,1);
        counters();
      });
    },
    /* перерисовать строку «Фильтр / сортировка» по свежему ответу сервера */
    render:function(s,f){
      S=s;facets=f;
      // старый сервер без фильтров не присылает price — тогда строку не показываем совсем
      var ok=!!(facets&&facets.price!==undefined);
      box.hidden=!ok;if(!ok)return;
      var n=FAList.count(S),cur=SORTS.filter(function(x){return x[0]===(S.sort||'new')})[0];
      box.innerHTML='<button class="tb-f" type="button">Фильтр'+(n?' <span class="tb-n">'+n+'</span>':'')+' <b>+</b></button>'
        +'<button class="tb-s" type="button">'+cur[1]+'<i></i></button>'
        +'<div class="tb-menu">'+SORTS.map(function(x){return '<button type="button" data-s="'+x[0]+'" class="'+(x[0]===cur[0]?'on':'')+'">'+x[1]+'</button>'}).join('')+'</div>';
    }
  };
  function menu(on){var m=document.querySelector('.tb-menu'),b=document.querySelector('.tb-s');if(!m)return;m.classList.toggle('open',on);b.classList.toggle('open',on)}
  function open(){
    pend={brands:S.brands.slice(),sizes:S.sizes.slice(),colors:S.colors.slice(),pmin:S.pmin,pmax:S.pmax};
    panel();document.getElementById('flOv').classList.add('on');document.getElementById('fl').classList.add('on');document.body.style.overflow='hidden';
  }
  function close(){
    var o=document.getElementById('flOv'),p=document.getElementById('fl');
    if(o)o.classList.remove('on');if(p)p.classList.remove('on');document.body.style.overflow='';
  }
  function sec(k,title,body,n){
    return '<div class="fl-s'+(openSec[k]?' open':'')+'" data-k="'+k+'"><button class="fl-st" type="button"><span>'+title+'<small data-n="'+k+'">'+(n?'выбрано '+n:'')+'</small></span><i></i></button><div class="fl-sb">'+body+'</div></div>';
  }
  function list(f,key,items,val,label){
    return items.map(function(it){
      return '<label class="fl-o"><input type="checkbox" data-f="'+f+'" value="'+esc(val(it))+'"'+(pend[f].indexOf(val(it))>=0?' checked':'')+'>'+esc(label(it))+'<i>'+it.count+'</i></label>';
    }).join('');
  }
  function panel(){
    var f=facets||{},h='';
    if(cfg.showBrands&&f.brands&&f.brands.length>1)
      h+=sec('brands','Бренд',list('brands','brands',f.brands,function(b){return b.slug},function(b){return b.name}),pend.brands.length);
    if(f.sizes&&f.sizes.length){
      /* парфюмерия: вместо размера — объём флакона («50» → «50 мл»); в смешанной выдаче — «Размер / объём» */
      var cats=(f.categories||[]).map(function(c){return c.name}),
          perf=S.category==='Парфюмерия'||(cats.length===1&&cats[0]==='Парфюмерия'),
          mixed=!perf&&!S.category&&cats.indexOf('Парфюмерия')>=0&&cats.length>1,
          vol=function(n){return perf&&/^\d+(?:[.,]\d+)?$/.test(n)?n+' мл':n};
      h+=sec('sizes',perf?'Объём':mixed?'Размер / объём':'Размер','<div class="fl-sz">'+f.sizes.map(function(z){
        return '<label><input type="checkbox" data-f="sizes" value="'+esc(z.name)+'"'+(pend.sizes.indexOf(z.name)>=0?' checked':'')+'>'+esc(vol(z.name))+'</label>'}).join('')+'</div>',pend.sizes.length);
    }
    if(f.colors&&f.colors.length)
      h+=sec('colors','Цвет',list('colors','colors',f.colors,function(c){return c.name},function(c){return c.name}),pend.colors.length);
    if(f.price)
      h+=sec('price','Цена','<div class="fl-pr"><input type="text" inputmode="numeric" data-f="pmin" placeholder="от '+f.price.min+'" value="'+esc(pend.pmin)+'"><input type="text" inputmode="numeric" data-f="pmax" placeholder="до '+f.price.max+'" value="'+esc(pend.pmax)+'"></div>',pend.pmin!==''||pend.pmax!==''?1:0);
    document.getElementById('fl').innerHTML='<div class="fl-h"><b>Фильтр</b><span><button class="fl-clear" type="button">Очистить всё</button><button class="fl-x" type="button" aria-label="Закрыть">×</button></span></div>'
      +'<div class="fl-b">'+(h||'<p style="padding:24px 0;color:var(--muted)">Для этого раздела пока нечего фильтровать</p>')+'</div>'
      +'<div class="fl-f"><button class="fl-apply" type="button">Применить</button></div>';
  }
  function counters(){
    ['brands','sizes','colors'].forEach(function(k){var e=document.querySelector('[data-n="'+k+'"]');if(e)e.textContent=pend[k].length?'выбрано '+pend[k].length:''});
  }
})();
