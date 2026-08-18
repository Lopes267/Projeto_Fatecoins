// ============================================================
//  charts.js — primitivas de gráfico compartilhadas
//
//  Usado pelo painel de Vendas (dashboard.html) e pelo painel de
//  Desempenho do entregador (entregas.html), para que os dois falem a
//  mesma língua visual:
//    • UMA matiz (--data) — a distinção vem de posição e rótulo, não de cor
//    • rótulo direto só no pico, nunca um número sobre cada marca
//    • toda figura tem uma gêmea em tabela (o botão "Ver tabela")
//    • a dica do ponteiro e a do teclado mostram exatamente a mesma coisa
//
//  Nada aqui conhece vendas ou entregas: o chamador passa os dados, como
//  formatá-los e o texto do resumo para leitores de tela.
// ============================================================

const SVGNS = 'http://www.w3.org/2000/svg';

// ---------- Formatação ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtInt     = n => new Intl.NumberFormat('pt-BR').format(n);
const fmtCompact = n => new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const fmt1       = n => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(n);
const fmtData    = (d, o) => new Intl.DateTimeFormat('pt-BR', o).format(d);
const chaveDia   = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DIAS       = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// Eixo em dinheiro: acima de mil vira "R$ 12,3 mil" para não empurrar a área do gráfico
const fmtMoedaEixo = n => n >= 1000 ? 'R$ ' + fmtCompact(n) : 'R$ ' + fmtInt(Math.round(n));
// Eixo em contagem: inteiro sempre (meia entrega não existe)
const fmtQtdEixo   = n => fmtInt(Math.round(n));
// Distância e duração, para os painéis de entrega
const fmtKm  = n => (n >= 100 ? fmtInt(Math.round(n)) : fmt1(n)) + ' km';
const fmtMin = n => {
  if (!(n > 0)) return '—';
  if (n < 60) return Math.round(n) + ' min';
  const h = Math.floor(n / 60), m = Math.round(n % 60);
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
};
const fmtMetros = m => m >= 1000 ? fmt1(m / 1000) + ' km' : Math.round(m) + ' m';

const cortar = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, Math.max(1, n - 1)).trimEnd() + '…' : s; };

// Teto "redondo" do eixo: 1, 2, 2.5, 5 ou 10 × potência de dez
function tetoRedondo(v) {
  if (!(v > 0)) return 10;
  const e = Math.floor(Math.log10(v)), f = v / Math.pow(10, e);
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * Math.pow(10, e);
}

// Barra horizontal: ponta arredondada 4px, quadrada na linha de base
function pathBarraH(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w, h / 2));
  if (w <= 0.5) return `M${x},${y} h0.5 v${h} h-0.5 Z`;
  return `M${x},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x} Z`;
}
// Coluna vertical: topo arredondado 4px, quadrada na linha de base
function pathColuna(x, yTopo, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h));
  if (h <= 0.5) return `M${x},${yTopo + h} h${w} v-0.5 h-${w} Z`;
  return `M${x},${yTopo + h} V${yTopo + r} A${r},${r} 0 0 1 ${x + r},${yTopo} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${yTopo + r} V${yTopo + h} Z`;
}

// ============================================================
//  Janela de tempo, comparação e agrupamento
// ============================================================

// Intervalo do período escolhido + o período anterior de igual tamanho,
// para o "vs. período anterior" comparar maçã com maçã.
function janela(periodo, registros, dataDe = r => r.data) {
  const fim = new Date(); fim.setHours(23, 59, 59, 999);
  if (periodo === 'all') {
    const ts = registros.map(r => { const d = dataDe(r); return d && +new Date(d); }).filter(Boolean);
    const ini = new Date(ts.length ? Math.min(...ts) : Date.now());
    ini.setHours(0, 0, 0, 0);
    return { ini, fim, prevIni: null, prevFim: null, tudo: true };
  }
  const n = parseInt(periodo, 10);
  const ini = new Date(fim); ini.setDate(ini.getDate() - (n - 1)); ini.setHours(0, 0, 0, 0);
  const prevFim = new Date(ini.getTime() - 1);
  const prevIni = new Date(prevFim); prevIni.setDate(prevIni.getDate() - (n - 1)); prevIni.setHours(0, 0, 0, 0);
  return { ini, fim, prevIni, prevFim, tudo: false };
}

function noIntervalo(registro, a, b, dataDe = r => r.data) {
  const d = dataDe(registro);
  const t = d && +new Date(d);
  return !!t && t >= +a && t <= +b;
}

// primeiroTxt: o que dizer quando não há base de comparação — cada painel usa a
// palavra do seu domínio ("Primeiras vendas", "Primeiras entregas").
function variacao(atual, anterior, primeiroTxt = 'Primeiro registro') {
  if (anterior <= 0) return atual > 0 ? { dir: 'up', txt: primeiroTxt } : { dir: 'flat', txt: 'Sem histórico' };
  const p = (atual - anterior) / anterior * 100;
  if (Math.abs(p) < 0.5) return { dir: 'flat', txt: 'Estável' };
  // Base quase zero gera porcentagem sem sentido ("▲ 99.999.900%") — corta em 999%
  if (Math.abs(p) > 999) return { dir: p > 0 ? 'up' : 'down', txt: (p > 0 ? '▲ ' : '▼ ') + 'mais de 999%' };
  return { dir: p > 0 ? 'up' : 'down', txt: (p > 0 ? '▲ ' : '▼ ') + fmt1(Math.abs(p)) + '%' };
}

// Agrupa registros em baldes de tempo, com granularidade adaptada ao intervalo:
// até 92 dias por dia, até 550 por semana, acima disso por mês.
//   dataDe(r)         → a data do registro
//   zero()            → as medidas iniciais do balde (ex.: { valor:0, qtd:0 })
//   somar(balde, r)   → acumula o registro no balde
function agruparNoTempo(registros, ini, fim, { dataDe = r => r.data, zero = () => ({ valor: 0 }), somar }) {
  const dias = Math.round((fim - ini) / 864e5) + 1;
  const gran = dias <= 92 ? 'dia' : dias <= 550 ? 'semana' : 'mes';
  const baldes = [], indice = new Map();
  const cursor = new Date(ini); cursor.setHours(0, 0, 0, 0);
  if (gran === 'semana') cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
  if (gran === 'mes')    cursor.setDate(1);

  while (cursor <= fim) {
    indice.set(chaveDia(cursor), baldes.length);
    baldes.push({ t: new Date(cursor), ...zero() });
    if (gran === 'dia')    cursor.setDate(cursor.getDate() + 1);
    if (gran === 'semana') cursor.setDate(cursor.getDate() + 7);
    if (gran === 'mes')    cursor.setMonth(cursor.getMonth() + 1);
  }
  const chaveDe = d => {
    const c = new Date(d); c.setHours(0, 0, 0, 0);
    if (gran === 'semana') c.setDate(c.getDate() - ((c.getDay() + 6) % 7));
    if (gran === 'mes')    c.setDate(1);
    return chaveDia(c);
  };
  registros.forEach(r => {
    const d = dataDe(r);
    if (!d) return;
    const i = indice.get(chaveDe(new Date(d)));
    if (i !== undefined) somar(baldes[i], r);
  });
  return { baldes, gran };
}

const rotuloBalde = (b, gran) =>
    gran === 'mes'    ? fmtData(b.t, { month: 'short', year: '2-digit' })
  : gran === 'semana' ? 'Semana de ' + fmtData(b.t, { day: '2-digit', month: 'short' })
  :                     fmtData(b.t, { day: '2-digit', month: 'short' });

// ============================================================
//  Tabela — a gêmea acessível de cada gráfico, não um plano B
// ============================================================
function tabela(legenda, colunas, linhas) {
  return `<div class="vtable-wrap"><table class="vtable">
    <caption>${esc(legenda)}</caption>
    <thead><tr>${colunas.map(c => `<th scope="col"${c.num ? ' class="num"' : ''}>${esc(c.t)}</th>`).join('')}</tr></thead>
    <tbody>${linhas.map(r => `<tr>${r.map((v, i) => {
      const cls = [colunas[i].num ? 'num' : '', i === 0 ? 'cell-clip' : ''].filter(Boolean).join(' ');
      return `<td${cls ? ` class="${cls}"` : ''}${i === 0 ? ` title="${esc(v)}"` : ''}>${esc(v)}</td>`;
    }).join('')}</tr>`).join('')}
    </tbody></table></div>`;
}

// ============================================================
//  Dica flutuante com paridade de teclado: o foco mostra o mesmo
//  que o ponteiro, e as setas andam pelas marcas.
// ============================================================
function ligarDica(box, seletorTip, dadosDe, total, mira, X, Yv) {
  const svg = box.querySelector('svg'), tip = box.querySelector(seletorTip);
  if (!svg || !tip) return;
  let ativo = -1;

  const mostrar = i => {
    if (i < 0 || i >= total) return;
    ativo = i;
    const d = dadosDe(i), r = svg.getBoundingClientRect(), bb = box.getBoundingClientRect();
    const k = r.width / svg.viewBox.baseVal.width;
    tip.innerHTML = d.html;
    tip.style.left = ((r.left - bb.left) + d.x * k) + 'px';
    tip.style.top  = ((r.top  - bb.top ) + d.y * k) + 'px';
    tip.dataset.show = 'true';
    if (mira && X) {
      mira.setAttribute('opacity', '1');
      mira.querySelector('line').setAttribute('x1', X(i));
      mira.querySelector('line').setAttribute('x2', X(i));
      mira.querySelector('circle').setAttribute('cx', X(i));
      mira.querySelector('circle').setAttribute('cy', Yv(i));
    }
  };
  const esconder = () => { ativo = -1; tip.dataset.show = 'false'; mira?.setAttribute('opacity', '0'); };

  box.querySelectorAll('.hitbox').forEach(hb => {
    hb.addEventListener('pointerenter', () => mostrar(+hb.dataset.i));
    hb.addEventListener('pointermove',  () => mostrar(+hb.dataset.i));
  });
  svg.addEventListener('pointerleave', esconder);
  svg.addEventListener('blur', esconder);
  svg.addEventListener('focus', () => mostrar(Math.max(0, ativo)));
  svg.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); mostrar(Math.min(total - 1, ativo + 1)); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); mostrar(Math.max(0, ativo - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); mostrar(0); }
    else if (e.key === 'End')  { e.preventDefault(); mostrar(total - 1); }
    else if (e.key === 'Escape') { esconder(); }
  });
}

// ============================================================
//  1. Série no tempo — área + linha, série única
// ============================================================
//  baldes    [{ t, ... }]  já agrupados por agruparNoTempo
//  valorDe   b => number
//  fmtValor  v => string   (eixo Y e rótulo do pico)
//  tipHtml   (b,i) => html
//  resumo    texto do aria-label
//  padEsq    largura reservada aos rótulos do eixo Y (padrão 62, cabe "R$ 12,3 mil")
function desenharLinha(box, cfg) {
  const { baldes, gran, valorDe, fmtValor, tipHtml, resumo, id = 'serie', padEsq = 62 } = cfg;
  const w = Math.max(320, box.clientWidth || 640), h = cfg.altura || 250;
  const pad = { t: 18, r: 22, b: 30, l: padEsq };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const n = baldes.length;
  if (!n) { box.innerHTML = ''; return; }
  const valores = baldes.map(valorDe);
  const teto = tetoRedondo(Math.max(...valores, 0)) || 10;
  const X = i => pad.l + (n <= 1 ? iw / 2 : i * (iw / (n - 1)));
  const Y = v => pad.t + ih - (v / teto) * ih;
  const iMax = valores.reduce((best, v, i) => v > valores[best] ? i : best, 0);

  let g = '';
  // Grade: hairline sólida, recuada
  for (let k = 0; k <= 4; k++) {
    const v = teto * k / 4, y = Y(v);
    g += `<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`;
    g += `<text x="${pad.l - 10}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--axis)"
            style="font-variant-numeric:tabular-nums">${esc(fmtValor(v))}</text>`;
  }
  // Eixo x: ~5 marcas
  const passo = Math.max(1, Math.ceil(n / 5));
  for (let i = 0; i < n; i += passo) {
    g += `<text x="${X(i)}" y="${h - 10}" text-anchor="middle" font-size="11" fill="var(--axis)">${
      esc(gran === 'dia' ? fmtData(baldes[i].t, { day: '2-digit', month: 'short' }) : rotuloBalde(baldes[i], gran))}</text>`;
  }
  const linha = baldes.map((b, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(valores[i]).toFixed(1)}`).join(' ');
  g += `<defs><linearGradient id="grad-${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--data)" stop-opacity="0.16"/>
          <stop offset="100%" stop-color="var(--data)" stop-opacity="0"/>
        </linearGradient></defs>`;
  g += `<path d="${linha} L${X(n - 1)},${Y(0)} L${X(0)},${Y(0)} Z" fill="url(#grad-${id})"/>`;
  g += `<path d="${linha}" fill="none" stroke="var(--data)" stroke-width="2"
          stroke-linejoin="round" stroke-linecap="round"/>`;
  // Marcadores: todos quando cabem; senão só pico e ponta. Anel de 2px na superfície.
  const pontos = n <= 14 ? baldes.map((_, i) => i) : [...new Set([iMax, n - 1])];
  pontos.forEach(i => {
    g += `<circle cx="${X(i)}" cy="${Y(valores[i])}" r="4.5" fill="var(--data)"
            stroke="var(--card)" stroke-width="2"/>`;
  });
  // Rótulo direto: só o pico (e a ponta, se não colidir)
  const rotular = [iMax];
  if (n - 1 !== iMax && Math.abs(X(n - 1) - X(iMax)) > 78) rotular.push(n - 1);
  rotular.forEach(i => {
    if (valores[i] <= 0) return;
    const anchor = X(i) > w - 90 ? 'end' : X(i) < pad.l + 40 ? 'start' : 'middle';
    g += `<text x="${X(i)}" y="${Math.max(pad.t + 2, Y(valores[i]) - 13)}" text-anchor="${anchor}"
            font-size="11.5" font-weight="600" fill="var(--text)"
            style="font-variant-numeric:tabular-nums">${esc(fmtValor(valores[i]))}</text>`;
  });
  // Camada de leitura: mira + faixas de toque largas
  g += `<g id="mira-${id}" opacity="0">
          <line y1="${pad.t}" y2="${pad.t + ih}" stroke="var(--data)" stroke-width="1" opacity=".55"/>
          <circle r="5.5" fill="var(--data)" stroke="var(--card)" stroke-width="2"/>
        </g>`;
  baldes.forEach((b, i) => {
    const bw = n <= 1 ? iw : iw / (n - 1);
    g += `<rect class="hitbox" x="${X(i) - bw / 2}" y="${pad.t}" width="${bw}" height="${ih}" data-i="${i}"/>`;
  });

  box.innerHTML =
      `<div class="peak-glow" aria-hidden="true" style="left:${X(iMax)}px"></div>`
    + `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" tabindex="0"
         aria-label="${esc(resumo)}" style="max-width:100%">${g}</svg>`
    + `<div class="vtip" id="tip-${id}" role="status"></div>`;

  ligarDica(box, `#tip-${id}`, i => ({ x: X(i), y: Y(valores[i]), html: tipHtml(baldes[i], i) }),
            n, box.querySelector(`#mira-${id}`), X, i => Y(valores[i]));
}

// ============================================================
//  2. Barras horizontais — ranking, matiz única
// ============================================================
//  itens [...], rotuloDe, valorDe, fmtValor, tipHtml, resumo, id
function desenharBarrasH(box, cfg) {
  const { itens, rotuloDe, valorDe, fmtValor, tipHtml, resumo, id = 'top', reservaValor = 96 } = cfg;
  if (!itens.length) { box.innerHTML = ''; return; }
  const w = Math.max(300, box.clientWidth || 420);
  const linhaH = 48, barH = 18, padR = 8;
  const h = itens.length * linhaH;
  const valores = itens.map(valorDe);
  const teto = Math.max(...valores) || 1;
  const larguraMax = w - padR - reservaValor;   // reserva espaço p/ o valor na ponta

  let g = '';
  itens.forEach((it, i) => {
    const y = i * linhaH, bw = Math.max(2, (valores[i] / teto) * larguraMax), by = y + 20;
    g += `<text x="0" y="${y + 12}" font-size="12.5" fill="var(--text)">${esc(cortar(rotuloDe(it), Math.floor(w / 8.4)))}</text>`;
    g += `<path d="${pathBarraH(0, by, bw, barH, 4)}" fill="var(--data)"/>`;
    g += `<text x="${bw + 10}" y="${by + 13}" font-size="12" font-weight="600" fill="var(--text)"
            style="font-variant-numeric:tabular-nums">${esc(fmtValor(valores[i]))}</text>`;
    g += `<rect class="hitbox" x="0" y="${y}" width="${w}" height="${linhaH}" data-i="${i}"/>`;
  });
  box.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" tabindex="0"
      aria-label="${esc(resumo)}" style="max-width:100%">${g}</svg><div class="vtip" id="tip-${id}" role="status"></div>`;

  ligarDica(box, `#tip-${id}`, i => ({
    x: Math.min(w - 70, (valores[i] / teto) * larguraMax),
    y: i * linhaH + 20,
    html: tipHtml(itens[i], i)
  }), itens.length);
}

// ============================================================
//  3. Colunas — categorias em ordem natural (dias, faixas de hora)
// ============================================================
//  Rótulo direto só no pico; as demais colunas ficam a 55% de opacidade
//  para o olho achar o máximo sem precisar ler número nenhum.
function desenharColunas(box, cfg) {
  const { itens, rotuloDe, valorDe, fmtValor, tipHtml, resumo, id = 'dow', passoRotulo = 1 } = cfg;
  if (!itens.length) { box.innerHTML = ''; return; }
  const w = Math.max(300, box.clientWidth || 420), h = cfg.altura || 250;
  const pad = { t: 26, r: 4, b: 28, l: 4 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const valores = itens.map(valorDe);
  const teto = tetoRedondo(Math.max(...valores)) || 10;
  const banda = iw / itens.length, barW = Math.min(24, Math.max(4, banda - 10));
  const iMax = valores.reduce((b, v, i) => v > valores[b] ? i : b, 0);

  let g = `<line x1="${pad.l}" y1="${pad.t + ih}" x2="${w - pad.r}" y2="${pad.t + ih}" stroke="var(--grid)" stroke-width="1"/>`;
  itens.forEach((it, i) => {
    const cx = pad.l + banda * i + banda / 2;
    const bh = valores[i] > 0 ? Math.max(2, (valores[i] / teto) * ih) : 0;
    if (bh) g += `<path d="${pathColuna(cx - barW / 2, pad.t + ih - bh, barW, bh, 4)}"
                    fill="var(--data)" fill-opacity="${i === iMax ? 1 : .55}"/>`;
    if (i === iMax && valores[i] > 0)
      g += `<text x="${cx}" y="${pad.t + ih - bh - 9}" text-anchor="middle" font-size="11.5" font-weight="600"
              fill="var(--text)" style="font-variant-numeric:tabular-nums">${esc(fmtValor(valores[i]))}</text>`;
    if (i % passoRotulo === 0 || i === iMax)
      g += `<text x="${cx}" y="${h - 9}" text-anchor="middle" font-size="11"
              fill="${i === iMax ? 'var(--text)' : 'var(--axis)'}">${esc(rotuloDe(it))}</text>`;
    g += `<rect class="hitbox" x="${pad.l + banda * i}" y="${pad.t}" width="${banda}" height="${ih}" data-i="${i}"/>`;
  });
  box.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" tabindex="0"
      aria-label="${esc(resumo)}" style="max-width:100%">${g}</svg><div class="vtip" id="tip-${id}" role="status"></div>`;

  ligarDica(box, `#tip-${id}`, i => ({
    x: pad.l + banda * i + banda / 2,
    y: pad.t + ih - (valores[i] / teto) * ih,
    html: tipHtml(itens[i], i)
  }), itens.length);
}

// Redesenha os gráficos quando a largura muda — SVG nítido em vez de esticado
function aoRedimensionar(alvo, redesenhar, ms = 140) {
  let t;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(redesenhar, ms); }).observe(alvo);
}
