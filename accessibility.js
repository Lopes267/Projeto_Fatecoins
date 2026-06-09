// ============================================================
//  accessibility.js — Botão flutuante de acessibilidade
//  • Botão redondo no canto da tela
//  • Ao clicar, abre uma "roda" de ações ao redor do botão
//  • Ação inicial: Lupa — ao passar o mouse, mostra um pop-up
//    com o texto sob o cursor em tamanho aumentado
//  Autossuficiente: injeta seu próprio CSS, HTML e lógica.
// ============================================================
(function () {
  if (window.__a11yLoaded) return;        // evita carregar duas vezes
  window.__a11yLoaded = true;

  // Aplica o tema salvo o quanto antes (mantém o modo claro entre páginas, sem piscar)
  try { if (localStorage.getItem('a11y_theme') === 'light' && document.body) document.body.classList.add('a11y-light'); } catch (e) {}

  // ---------- ESTILOS ----------
  const css = `
  .a11y-root{position:fixed;right:26px;bottom:26px;z-index:99999;font-family:'DM Sans',system-ui,sans-serif}
  .a11y-fab{
    position:relative;z-index:2;width:54px;height:54px;border-radius:50%;cursor:pointer;
    border:none;display:flex;align-items:center;justify-content:center;color:#fff;
    background:#2563eb;box-shadow:0 6px 20px rgba(37,99,235,.5);
    transition:transform .3s cubic-bezier(.34,1.56,.64,1),box-shadow .3s,background .2s;
  }
  .a11y-fab:hover{background:#1d4ed8;box-shadow:0 8px 26px rgba(37,99,235,.65)}
  .a11y-fab svg{width:28px;height:28px;transition:transform .35s}
  .a11y-root.open .a11y-fab{transform:rotate(90deg)}
  .a11y-root.open .a11y-fab svg{transform:rotate(-90deg)}

  .a11y-action{
    position:absolute;right:7px;bottom:7px;width:40px;height:40px;border-radius:50%;
    border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;
    background:#1e293b;color:#cbd5e1;box-shadow:0 4px 14px rgba(0,0,0,.4);
    transform:translate(0,0) scale(.2);opacity:0;pointer-events:none;
    transition:transform .38s cubic-bezier(.34,1.56,.64,1),opacity .25s,background .2s,color .2s;
  }
  .a11y-action svg{width:20px;height:20px}
  .a11y-action:hover{background:#334155;color:#fff}
  .a11y-action.active{background:#2563eb;color:#fff;box-shadow:0 0 0 3px rgba(37,99,235,.35),0 4px 14px rgba(0,0,0,.4)}
  .a11y-root.open .a11y-action{
    transform:translate(var(--tx,0),var(--ty,0)) scale(1);opacity:1;pointer-events:auto;
  }

  .a11y-tip{
    position:absolute;right:52px;top:50%;transform:translateY(-50%);white-space:nowrap;
    background:#0f172a;color:#fff;font-size:.74rem;font-weight:600;padding:.3rem .55rem;
    border-radius:6px;opacity:0;pointer-events:none;transition:opacity .2s;
  }
  .a11y-action:hover .a11y-tip{opacity:1}

  /* Pop-up da lupa */
  .a11y-lens{
    position:fixed;z-index:100000;max-width:380px;display:none;pointer-events:none;
    background:#0b1220;color:#f1f5f9;border:1px solid #2563eb;border-radius:12px;
    padding:.7rem .9rem;font-size:1.9rem;line-height:1.3;font-weight:600;
    box-shadow:0 10px 40px rgba(0,0,0,.55),0 0 0 4px rgba(37,99,235,.15);
  }
  body.a11y-mag-on{cursor:zoom-in}

  /* Modo claro do site — sobrescreve as variáveis de tema para todos os descendentes do body */
  body{transition:background-color .3s ease,color .3s ease}
  body.a11y-light{
    --bg:#f4f1ea; --card:#ffffff; --card2:#ece7dd;
    --border:#dcd5c8; --text:#1f1b16; --muted:#6f6658;
  }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- ÍCONES ----------
  const icoA11y = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"></circle>
    <circle cx="12" cy="7.5" r="1.2" fill="currentColor" stroke="none"></circle>
    <path d="M6.8 9.6c1.9.8 3.4 1 5.2 1s3.3-.2 5.2-1"></path>
    <path d="M12 10.6V15"></path><path d="M9.2 18l2.8-3 2.8 3"></path></svg>`;
  const icoLupa = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path>
    <path d="M11 8v6M8 11h6"></path></svg>`;
  const icoSol = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="4"></circle>
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>`;
  const icoLua = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path></svg>`;

  // ---------- AÇÕES (fácil adicionar novas no futuro) ----------
  const actions = [
    { id: 'lupa', label: 'Lupa', icon: icoLupa, toggle: true, onToggle: setMagnifier },
    { id: 'tema', label: 'Modo claro', toggle: true,
      // No escuro mostra o SOL (clique p/ clarear); no claro mostra a LUA (clique p/ escurecer)
      iconFor: (light) => (light ? icoLua : icoSol),
      isActive: () => document.body.classList.contains('a11y-light'),
      onToggle: setLightMode },
  ];

  // ---------- MONTAGEM ----------
  const root = document.createElement('div');
  root.className = 'a11y-root';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Acessibilidade');

  const fab = document.createElement('button');
  fab.className = 'a11y-fab';
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Abrir acessibilidade');
  fab.setAttribute('aria-expanded', 'false');
  fab.innerHTML = icoA11y;
  root.appendChild(fab);

  const actionEls = actions.map((a) => {
    const btn = document.createElement('button');
    btn.className = 'a11y-action';
    btn.type = 'button';
    btn.setAttribute('aria-label', a.label);

    // Define o ícone do botão conforme o estado (usa iconFor quando existir, senão o ícone fixo)
    const setIcon = (active) => {
      const svg = a.iconFor ? a.iconFor(active) : a.icon;
      btn.innerHTML = svg + `<span class="a11y-tip">${a.label}</span>`;
    };

    // Estado inicial (ex.: se o modo claro já está salvo, o botão de tema já mostra a lua e fica ativo)
    const startActive = a.isActive ? a.isActive() : false;
    setIcon(startActive);
    if (a.toggle) {
      btn.classList.toggle('active', startActive);
      btn.setAttribute('aria-pressed', String(startActive));
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (a.toggle) {
        const nowActive = !btn.classList.contains('active');
        btn.classList.toggle('active', nowActive);
        btn.setAttribute('aria-pressed', String(nowActive));
        setIcon(nowActive);
        a.onToggle(nowActive);
      } else if (a.onClick) {
        a.onClick();
      }
    });
    root.appendChild(btn);
    return btn;
  });

  // Posiciona as ações em arco ao redor do botão (canto inferior direito → sobe/esquerda)
  const RADIUS = 86;
  const n = actionEls.length;
  actionEls.forEach((el, i) => {
    const deg = n === 1 ? 135 : 90 + (90 * i) / (n - 1); // 90°=cima, 180°=esquerda
    const rad = (deg * Math.PI) / 180;
    el.style.setProperty('--tx', `${Math.cos(rad) * RADIUS}px`);
    el.style.setProperty('--ty', `${-Math.sin(rad) * RADIUS}px`);
    el.style.transitionDelay = `${i * 0.04}s`;
  });

  // Abre/fecha a roda
  let open = false;
  function setOpen(v) {
    open = v;
    root.classList.toggle('open', v);
    fab.setAttribute('aria-expanded', String(v));
  }
  fab.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!open); });
  document.addEventListener('click', (e) => { if (open && !root.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) setOpen(false); });

  // ---------- LUPA ----------
  const lens = document.createElement('div');
  lens.className = 'a11y-lens';
  lens.setAttribute('aria-hidden', 'true');

  let magOn = false;
  function setMagnifier(on) {
    magOn = on;
    document.body.classList.toggle('a11y-mag-on', on);
    if (!on) lens.style.display = 'none';
  }

  // ---------- TEMA (modo claro/escuro) ----------
  // Ativa/desativa o modo claro e salva a escolha — mantém entre páginas e recarregamentos
  function setLightMode(on) {
    document.body.classList.toggle('a11y-light', on);
    try { localStorage.setItem('a11y_theme', on ? 'light' : 'dark'); } catch (e) {}
  }

  // Pega o texto exatamente sob o cursor (nó de texto), sem pegar o container inteiro
  function textUnderCursor(x, y) {
    let node = null;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      node = r && r.startContainer;
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      node = p && p.offsetNode;
    }
    if (node && node.nodeType === 3 && node.textContent.trim()) {
      return node.textContent.trim();
    }
    // fallback: texto do elemento se for curto
    const el = document.elementFromPoint(x, y);
    if (el && el.textContent) {
      const t = el.textContent.trim();
      if (t && t.length <= 160) return t;
    }
    return '';
  }

  document.addEventListener('mousemove', (e) => {
    if (!magOn) return;
    if (root.contains(e.target)) { lens.style.display = 'none'; return; } // não ampliar o próprio widget
    const text = textUnderCursor(e.clientX, e.clientY);
    if (!text) { lens.style.display = 'none'; return; }

    lens.textContent = text;
    lens.style.display = 'block';

    // posiciona perto do cursor, mantendo dentro da tela
    const pad = 16;
    const rect = lens.getBoundingClientRect();
    let lx = e.clientX + 20;
    let ly = e.clientY + 20;
    if (lx + rect.width + pad > window.innerWidth)  lx = e.clientX - rect.width - 20;
    if (ly + rect.height + pad > window.innerHeight) ly = e.clientY - rect.height - 20;
    lens.style.left = Math.max(pad, lx) + 'px';
    lens.style.top  = Math.max(pad, ly) + 'px';
  });

  // ---------- INSERE NA PÁGINA ----------
  function mount() {
    document.body.appendChild(root);
    document.body.appendChild(lens);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
