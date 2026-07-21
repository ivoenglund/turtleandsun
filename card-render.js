/* card-render.js — ONE renderer for what is inside a card.
 *
 * Used by the editor (print-brochure.html) and by the print library
 * (studio-groups.html). It exists so a preview can never drift from the real
 * page: there is a single copy of postBlock/personCard/mediaBlock, not two.
 *
 * The module owns the current paper (setPaper) rather than reaching into the
 * editor's document, which is what lets the library render a cover for a print
 * on a different paper than whatever is open.
 *
 * Look lives in card-render.css; geometry is inline per object.
 */
window.CardRender = (function(){
  'use strict';
  const MMPX = 96/25.4;
  let CUR_PAPER = 'a4';
  function setPaper(k){ CUR_PAPER = k || 'a4'; }
  function pScale(){ return paperOf(CUR_PAPER).w*MMPX/794; }
  const RADpx = () => (4.5*pScale());
  const PADpx = () => (5.4*pScale());
  const r4 = v => Math.round(v*10000)/10000;

  const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const STYLE_OK=['font-family','font-size','color','font-weight','font-style','text-decoration'];

  function cleanStyle(s){
    return String(s||'').split(';').map(d=>{
      const i=d.indexOf(':'); if(i<0) return '';
      const p=d.slice(0,i).trim().toLowerCase(), v=d.slice(i+1).trim();
      if(!STYLE_OK.includes(p)) return '';
      if(/url\s*\(|expression|javascript|@import|[<>]/i.test(v)) return '';
      return p+':'+v;
    }).filter(Boolean).join(';');
  }

  function sanitizeHtml(s){
    const t=document.createElement('template');
    t.innerHTML=String(s||'');
    t.content.querySelectorAll('script,style,iframe,object,embed,link,meta,svg,img,video,audio,form,input,button,textarea,select').forEach(e=>e.remove());
    const OK=['H3','P','B','STRONG','U','I','EM','BR','DIV','SPAN'];
    (function walk(node){
      [...node.children].forEach(el=>{
        walk(el);
        if(!OK.includes(el.tagName)){          // unknown (font, a, …) → unwrap, keep content
          while(el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
          el.remove(); return;
        }
        [...el.attributes].forEach(a=>{ if(a.name.toLowerCase()!=='style') el.removeAttribute(a.name); });
        const cs=cleanStyle(el.getAttribute('style'));
        if(cs) el.setAttribute('style',cs); else el.removeAttribute('style');
      });
    })(t.content);
    return t.innerHTML;
  }

  const BORDER_STYLES=['solid','dashed','dotted','double'];

  // Century Gothic is wide and heavy — a poor stand-in. Jost at 300 is the closest
  // open face to Futura Book, so go straight to it.
  const FONTSTACK={ 'Futura Book': "'Futura Book','Jost',sans-serif" };

  function fontCss(name){
    if(!name) return '';
    return FONTSTACK[name] || ("'"+String(name).replace(/'/g,'')+"'");
  }

  const SHB=[[0,0,0],[2,5,.4],[4,9,.55],[6,14,.75]];

  const SHT=[[0,0,0],[1,2.5,.5],[2,4.5,.65],[3,7,.8]];

  function shStr(arr,i){
    const s=pScale(), a=arr[i]||arr[0];
    return '0 '+(a[0]*s).toFixed(1)+'px '+(a[1]*s).toFixed(1)+'px rgba(0,0,0,'+a[2]+')';
  }

  function decoCss(ov,isBareText){
    let s='';
    if(ov.bg) s+='background:'+esc(ov.bg)+';'+(!+ov.bw?'padding:'+PADpx().toFixed(1)+'px;':'');
    const sh=+ov.sh||0;
    if(sh){
      if(isBareText&&!ov.bg&&!+ov.bw) s+='text-shadow:'+shStr(SHT,sh)+';';
      else s+='box-shadow:'+shStr(SHB,sh)+';';
    }
    return s;
  }

  function borderCss(ov){
    const bw=+ov.bw||0; if(!bw) return '';
    const bs=BORDER_STYLES.includes(ov.bs)?ov.bs:'solid';
    return 'border:'+(bw*pScale()).toFixed(1)+'px '+bs+' '+esc(ov.bc||'#23291d')+';padding:'+PADpx().toFixed(1)+'px;';
  }

  function postBlock(it){
    const c=it.content||{}, ov=it.overrides||{};
    const part=ov.part||'txt';
    if(part.slice(0,3)==='img'){
      const ph=(c.photos||[])[+part.slice(3)||0];
      // Crop = a WINDOW (height phr, overflow hidden) over the picture, which
      // keeps its own size (pwr) and offset (ixr/iyr) — all ratios of the
      // window width, so paper changes and resizing leave the crop intact.
      let bs='', ist='';
      if(+ov.pwr){
        const cr=cropEms(ov);
        bs=' style="position:relative;overflow:hidden;height:'+r4(cr.ph)+'em;"';
        ist=' style="position:absolute;width:'+r4(cr.pw)+'em;max-width:none;left:'+r4(cr.ix)+'em;top:'+r4(cr.iy)+'em;border-radius:0;"';
      }else if(+ov.ph){   // ancient cover-crop: still renders; converts on crop entry
        ist=' style="height:'+(+ov.ph)+'em;object-fit:cover;object-position:'+
          (ov.px!=null?+ov.px:50)+'% '+(ov.py!=null?+ov.py:50)+'%;"';
      }
      const icls='block imgo'+(+ov.pwr?' cropped':'')+(ov.sq?' sqc':'');
      return '<div class="'+icls+'"'+bs+' data-idx="'+it._idx+'">'+
        (ph?'<img src="'+esc(ph)+'"'+ist+'>':'<div class="hint">picture missing</div>')+'</div>';
    }
    const cls=['block','txtobj', ov.txt?'txt-'+ov.txt:'', ov.font?'font-'+ov.font:'',
               ov.ff?'ffo':'', ov.tc?'tco':''].filter(Boolean).join(' ');
    const ffs=ov.ff?' style="font-family:'+esc(fontCss(ov.ff))+'"':'';
    let inner;
    if(ov.text){ inner='<div class="bd">'+sanitizeHtml(ov.text)+'</div>'; }
    else{
      const paras=String(c.body||'').split(/\n\n+/).filter(Boolean).slice(0,12)
        .map(p=>'<p>'+esc(p)+'</p>').join('');
      inner='<div class="bd">'+(c.title?'<h3>'+esc(c.title)+'</h3>':'')+
        (c.author&&!ov.nodate?'<div class="meta">'+esc(c.author)+'</div>':'')+paras+'</div>';
    }
    return '<div class="'+cls+'"'+ffs+' data-idx="'+it._idx+'">'+inner+'</div>';
  }

  function personCard(it){
    const c=it.content, ov=it.overrides||{};
    const init=(c.name||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
    const cls=['person','block', ov.tc?'tco':'', ov.ff?'ffo':''].filter(Boolean).join(' ');
    // ov.flds (set by a group card's rule) says which fields to show. Absent = all.
    const show = ov.flds!=null ? new Set(String(ov.flds).split(',')) : null;
    const on = f => !show || show.has(f);
    const inner = ov.text ? sanitizeHtml(ov.text)
      : (on('name')?'<b>'+esc(c.name||'')+'</b>':'')+
        (on('title')&&c.job_title?'<div class="role">'+esc(c.job_title)+'</div>':'')+
        '<div class="ct">'+[on('email')?c.email:null, on('phone')?c.phone:null]
          .filter(Boolean).map(esc).join('<br>')+'</div>';
    return '<div class="'+cls+'" data-idx="'+it._idx+'">'+
      (on('photo')
        ? (c.photo_url?'<img src="'+esc(c.photo_url)+'">':'<div class="init">'+esc(init)+'</div>')
        : '')+
      '<div class="bd">'+inner+'</div></div>';
  }

  function mediaBlock(it){
    const c=it.content||{}, ov=it.overrides||{};
    const showCap = ov.caption && c.title;
    let bs='', ist='';
    if(+ov.pwr){
      const cr=cropEms(ov);
      bs=' style="position:relative;overflow:hidden;height:'+r4(cr.ph)+'em;"';
      ist=' style="position:absolute;width:'+r4(cr.pw)+'em;max-width:none;left:'+r4(cr.ix)+'em;top:'+r4(cr.iy)+'em;border-radius:0;object-fit:fill;"';
    }
    const wcls='imgo'+(+ov.pwr?' cropped':'')+(ov.sq?' sqc':'');
    return '<div class="block media'+(ov.tc?' tco':'')+(ov.sq?' sqc':'')+'" data-idx="'+it._idx+'">'+
      (c.url?'<div class="'+wcls+'"'+bs+'><img src="'+esc(c.url)+'"'+ist+'></div>':'')+
      (showCap?'<div class="cap">'+esc(c.title)+'</div>':'')+'</div>';
  }

  function cardInner(it){
    return it.ref_type==='contact' ? personCard(it)
         : it.ref_type==='media'   ? mediaBlock(it)
         : postBlock(it);
  }

  function cropEms(ov){
    const P=paperOf(CUR_PAPER);
    const fs=fsOf(ov);
    const Wem=P.w*MMPX*((+ov.w||28)/100)/fs;
    return { Wem, pw:(+ov.pwr||1)*Wem, ph:(+ov.phr||0.6)*Wem, ix:(+ov.ixr||0)*Wem, iy:(+ov.iyr||0)*Wem };
  }

  function fsOf(ov){
    const w=(ov&&ov.w!=null)?+ov.w:28, ts=(ov&&ov.ts)?+ov.ts:1;
    return Math.max(2, 13.5*(w/28)*ts*pScale());   // no ceiling — big papers want BIG type
  }

  const PAPERS=[
    {k:'a0',n:'A0',w:841,h:1189,u:'cm'},
    {k:'a1',n:'A1',w:594,h:841,u:'cm'},
    {k:'a2',n:'A2',w:420,h:594,u:'cm'},
    {k:'a3',n:'A3',w:297,h:420,u:'cm'},
    {k:'a4',n:'A4',w:210,h:297,u:'cm'},
    {k:'a5',n:'A5',w:148,h:210,u:'cm'},
    {k:'a6',n:'A6',w:105,h:148,u:'cm'},
    {k:'letter', n:'US Letter',  w:215.9,h:279.4,u:'in'},
    {k:'legal',  n:'US Legal',   w:215.9,h:355.6,u:'in'},
    {k:'tabloid',n:'US Tabloid', w:279.4,h:431.8,u:'in'},
    {k:'ansic',  n:'US ANSI C',  w:431.8,h:558.8,u:'in'},
    {k:'ansid',  n:'US ANSI D',  w:558.8,h:863.6,u:'in'},
    {k:'ansie',  n:'US ANSI E',  w:863.6,h:1117.6,u:'in'},
    {k:'poster', n:'Poster',     w:700,  h:1000,  u:'cm', canvas:true},
  ];
  function paperOf(k){ return PAPERS.find(x=>x.k===k) || PAPERS.find(x=>x.k==='a4'); }


  // A whole page, rendered at TRUE page size and scaled down by one transform.
  // Recomputing a small font-size per object cannot work: browsers refuse to
  // render text below a minimum size, so small text stays put, becomes
  // proportionally huge and clips. Scaling the rendered result is faithful by
  // construction — the same reason the editor's filmstrip looks right.
  function pageHtml(doc, W){
    setPaper(doc.paper || 'a4');
    const P = paperOf(CUR_PAPER);
    const natW = P.w*MMPX, natH = P.h*MMPX;
    const k = W/natW, H = Math.round(natH*k);
    const objHtml = (ov, inner) => {
      const w = +ov.w||28, ts = (ov.ts?+ov.ts:1);
      const fs = Math.max(2, 13.5*(w/28)*ts*pScale());
      const st = 'position:absolute;left:'+(+ov.x||0)+'%;top:'+(+ov.y||0)+'%;width:'+w+'%;'+
        'font-size:'+fs.toFixed(2)+'px;z-index:'+(+ov.z||0)+';'+
        'border-radius:'+(ov.sq?'0':RADpx().toFixed(1)+'px')+';'+
        ((+ov.r)?'transform:rotate('+(+ov.r)+'deg);':'')+
        (ov.ff?'font-family:'+esc(fontCss(ov.ff))+';':'')+
        (ov.tc?'color:'+esc(ov.tc)+';':'')+
        borderCss(ov)+decoCss(ov,false);
      return '<div class="'+(ov.sq?'sqo':'')+'" style="'+st+'">'+inner+'</div>';
    };
    const parts = [];
    (doc.items||[]).forEach(it => parts.push({ z:+((it.overrides||{}).z)||0,
      h: objHtml(it.overrides||{}, cardInner({ ...it, _idx:-1 })) }));
    (doc.texts||[]).forEach(t => parts.push({ z:+t.z||0,
      h: objHtml(t, '<div class="block txtobj'+(t.ff?' ffo':'')+(t.tc?' tco':'')+'">'+
        '<div class="bd">'+sanitizeHtml(t.text||'')+'</div></div>') }));
    parts.sort((a,c) => a.z - c.z);
    return '<div style="position:relative;width:'+W+'px;height:'+H+'px;background:#fff;overflow:hidden;">'+
      '<div style="position:absolute;top:0;left:0;width:'+natW.toFixed(0)+'px;height:'+natH.toFixed(0)+'px;'+
        'transform:scale('+k.toFixed(5)+');transform-origin:top left;">'+
        parts.map(x=>x.h).join('')+
      '</div></div>';
  }

  return { setPaper, pageHtml, PAPERS, paperOf, MMPX, r4, pScale, RADpx, PADpx,
           esc, cleanStyle, sanitizeHtml, STYLE_OK, BORDER_STYLES, FONTSTACK, fontCss,
           SHB, SHT, shStr, decoCss, borderCss, cropEms, fsOf,
           postBlock, personCard, mediaBlock, cardInner };
})();
