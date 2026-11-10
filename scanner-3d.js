/* ============================================================
   SCANNER 3D — "Escanear produto com a câmera"
   Gera a malha 3D (.glb) de um produto real a partir da câmera
   do celular, sem serviço externo e sem custo por escaneamento.

   Como funciona, em uma frase: o lojista gira o produto na frente
   da câmera, o site recorta a silhueta em cada quadro e esculpe um
   bloco de voxels até sobrar só o que aparece em TODAS as silhuetas
   (visual hull / space carving). O que sobra vira malha e sai .glb.

   Consequências honestas dessa escolha:
     · funciona bem em objeto "cheio" — caixa, garrafa, tênis, panela;
     · não enxerga buraco nem concavidade (uma caneca sai maciça,
       a alça vira um bloco);
     · precisa de fundo contrastante — produto branco em parede
       branca não segmenta;
     · a cor sai por vértice, então é uma pintura aproximada, não
       uma textura fotográfica.

   Depende do mesmo importmap do three.js usado pelo ar-viewer.js.

   Uso:
     Scanner3D.abrir({ produto, aoConcluir: (blob, previewURL) => {} })
   ============================================================ */
(function () {
'use strict';

// ---------- parâmetros da captura ----------
// Máscara em 384×512 e cor em 192×256. A resolução da máscara é o que
// define a suavidade da peça: com 192 px a borda da silhueta anda de 1 px
// inteiro a cada ~10 voxels e o produto sai com anéis; com 384 o degrau
// cai pela metade e some. A cor não precisa disso, e guardar 36 quadros
// coloridos em  384×512 custaria 28 MB na memória do celular.
const LARG = 384, ALT = 512;
const LARG_C = 192, ALT_C = 256;
let   FRAC_ALTURA = 0.50;           // quanto da altura do quadro a moldura ocupa
const FRAC_LARGURA = 0.68;
const N_ALVO = 36;                  // quadros de uma volta completa
// Medido contra objeto de tamanho conhecido: 36 quadros dão ~1% de erro
// em largura/profundidade, 18 dão ~11% e 12 dão ~20% — cada quadro é um
// plano tangente a menos, e o casco vira um prisma grosseiro. Por isso o
// "concluir volta" só libera a partir de 24.
const MIN_FRAMES = 24;
const INTERVALO_MS = 620;
// Campo de visão VERTICAL do recorte 3:4 que o scanner processa. Não é fixo:
// o vídeo do celular sai do sensor 4:3, e em 16:9 perde as bordas do lado
// curto — o mesmo recorte 3:4 cobre ~52° num vídeo 720×1280 e ~66° num
// 960×1280. fovDoRecorte() calcula pelo tamanho do vídeo de cada captura;
// este é só o padrão para quem não informa (testes).
const FOV_PADRAO = 55 * Math.PI / 180;
const FOV_LADO_LONGO = 66 * Math.PI / 180;   // lado longo do vídeo, câmera principal de celular
let FOV = FOV_PADRAO;
// Elevação assumida quando o aparelho não tem giroscópio (computador, ou
// celular que negou o sensor). No celular a elevação de cada quadro vem do
// sensor de orientação. Sem ele não há como medir (ver autocalibrar), então o
// valor é o que errou menos na bancada com a câmera de verdade entre 5° e
// 25°: supor 10° dá casco médio 0,915 e pior caso 0,835; supor 5° (o valor
// antigo, certo só para câmera apoiada na mesa) dava 0,900 e 0,806.
let ELEVACAO = 10 * Math.PI / 180;

// ---------- parâmetros do volume ----------
const NX = 96, NY = 112, NZ = 96;   // ~1,03 milhão de voxels
// Aresta do voxel e canto do volume. São o padrão de partida: antes de
// esculpir, ajustarVolume() os recalcula para o produto que foi mesmo
// capturado. A grade tem sempre 96×112×96 voxels; o que muda é o tamanho
// de cada um.
let PASSO = 0.01;                   // aresta do voxel, em unidades de moldura
let ORIGEM = [-(NX / 2) * PASSO, -(NY / 2) * PASSO, -(NZ / 2) * PASSO];
const ISO = 0.5;                    // nível da superfície no campo contínuo

// ---------- three.js sob demanda ----------
let THREE = null, OrbitControls = null, GLTFExporter = null;
let libPromise = null;

function carregarLib() {
  if (libPromise) return libPromise;
  libPromise = Promise.all([
    import('three'),
    import('three/addons/controls/OrbitControls.js'),
    import('three/addons/exporters/GLTFExporter.js')
  ]).then(function (m) {
    THREE = m[0];
    OrbitControls = m[1].OrbitControls;
    GLTFExporter = m[2].GLTFExporter;
  }).catch(function (e) { libPromise = null; throw e; });
  return libPromise;
}

// ============================================================
//  1. SEGMENTAÇÃO — separar o produto do fundo
//  Duas paletas de cor: uma aprendida NAS MARGENS do quadro (que é
//  fundo por definição, já que o produto fica dentro da moldura) e
//  outra aprendida NO MIOLO da moldura (produto provável). Cada
//  pixel vai para a paleta cuja cor está mais perto da dele.
//
//  A versão anterior só perguntava "esta cor apareceu na margem?",
//  com caixas de 32 níveis mais os vizinhos — tolerância de até 64
//  níveis por canal. Um caderno cinza-claro sobre mesa branca cabia
//  inteiro nessa tolerância: sobrava só a escrita da capa, que é a
//  única coisa distante em cor. Comparar com as DUAS paletas resolve,
//  porque a capa está a ~53 de distância do branco da mesa e a ~0
//  de si mesma.
// ============================================================

// Moldura de mira, em pixels do quadro de processamento
const ROI = {
  x0: Math.round((1 - FRAC_LARGURA) / 2 * LARG),
  y0: Math.round((1 - FRAC_ALTURA) / 2 * ALT),
  x1: Math.round((1 + FRAC_LARGURA) / 2 * LARG),
  y1: Math.round((1 + FRAC_ALTURA) / 2 * ALT)
};

const bins  = new Int32Array(4096);   // 16×16×16 caixas de 16 níveis
const somaR = new Int32Array(4096);
const somaG = new Int32Array(4096);
const somaB = new Int32Array(4096);

// Vagas na paleta do produto: rótulo, tampa, letreiro e os tons de sombra do
// próprio corpo. Com 10, um borrifador perdia os azuis da parte sombreada.
const MAX_CORES_PROD = 16;
const FUNDE = 26;                    // raio para fundir caixas da mesma cor
const TOL_PROD = 24;                 // "este pixel é mesmo de uma cor do produto"
const SOMBRA = 24;                   // folga do teste de sombra

const palProd  = new Float32Array(MAX_CORES_PROD * 3); let nProd  = 0;

// Fundo por FAIXA de altura. Na foto de verdade o fundo muda de cima para
// baixo: parede bege atrás do topo, mesa de madeira atrás da base, luz que
// cai. Uma paleta única misturava tudo, e o creme do rótulo — que está na
// altura da MESA — era tomado pelo bege da PAREDE. Cada faixa aprende só com
// as margens da mesma altura (e as vizinhas); a cor de uma parede lá em cima
// não condena mais um pixel cá embaixo.
const N_FAIXAS = 8;
const ALT_FAIXA = Math.ceil((ROI.y1 - ROI.y0) / N_FAIXAS);
const MAX_CORES_FAIXA = 8;
const palFaixa = new Float32Array(N_FAIXAS * MAX_CORES_FAIXA * 3);
const nFaixa = new Int32Array(N_FAIXAS);

function faixaDe(y) {
  const f = ((y - ROI.y0) / ALT_FAIXA) | 0;
  return f < 0 ? 0 : (f >= N_FAIXAS ? N_FAIXAS - 1 : f);
}

const trabalho  = new Uint8Array(LARG * ALT);
const trabalho2 = new Uint8Array(LARG * ALT);
const trabalho3 = new Uint8Array(LARG * ALT);
const pilha  = new Int32Array(LARG * ALT);
const marcas = new Int32Array(LARG * ALT);   // ids de componente: em 384×512
                                             // o ruído passa fácil de 255

// Decisão guardada por cor de 8 níveis: 32³ = 32768 entradas, uma tabela
// por faixa (a mesma cor pode ser produto numa altura e fundo em outra).
// Classificar pixel a pixel custaria 67 mil × 40 distâncias por quadro;
// assim são só as poucas centenas de cores que a cena tem de verdade.
const cache = new Int8Array(N_FAIXAS * 32768);

function corBin(r, g, b) { return (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4); }
function corCache(r, g, b) { return (r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3); }

function dist2(r, g, b, R, G, B) {
  const a = r - R, c = g - G, d = b - B;
  return a * a + c * c + d * d;
}

function zerarHist() { bins.fill(0); somaR.fill(0); somaG.fill(0); somaB.fill(0); }

function contarCor(px, j) {
  const b = corBin(px[j], px[j + 1], px[j + 2]);
  bins[b]++; somaR[b] += px[j]; somaG[b] += px[j + 1]; somaB[b] += px[j + 2];
}

// Tira do histograma as cores dominantes, uma a uma, apagando a cada
// passo tudo que está perto da escolhida — senão as dez vagas seriam
// gastas com dez tons do mesmo bege.
// `base` é a primeira vaga da paleta (as faixas dividem um vetor só).
function extrairPaleta(dest, minimo, maxCores, base) {
  base = base || 0;
  let n = 0;
  for (let k = 0; k < maxCores; k++) {
    let melhor = -1, melhorC = minimo;
    for (let b = 0; b < 4096; b++) if (bins[b] > melhorC) { melhorC = bins[b]; melhor = b; }
    if (melhor < 0) break;
    const c = bins[melhor];
    const R = somaR[melhor] / c, G = somaG[melhor] / c, B = somaB[melhor] / c;
    const o = (base + n) * 3;
    dest[o] = R; dest[o + 1] = G; dest[o + 2] = B; n++;
    for (let b = 0; b < 4096; b++) {
      const q = bins[b];
      if (!q) continue;
      if (dist2(somaR[b] / q, somaG[b] / q, somaB[b] / q, R, G, B) < FUNDE * FUNDE) {
        bins[b] = 0; somaR[b] = 0; somaG[b] = 0; somaB[b] = 0;
      }
    }
  }
  return n;
}

function pertoDe(pal, n, r, g, b, base) {
  let m = 1e9;
  const o = (base || 0) * 3;
  for (let i = 0; i < n; i++) {
    const k = o + i * 3;
    const d = dist2(r, g, b, pal[k], pal[k + 1], pal[k + 2]);
    if (d < m) m = d;
  }
  return m;
}

// Distância até o fundo DESTA altura: paleta da faixa e das duas vizinhas
// (o horizonte entre parede e mesa raramente cai certinho na divisa).
function pertoDoFundo(r, g, b, f) {
  let m = 1e9;
  const a = f > 0 ? f - 1 : 0, z = f < N_FAIXAS - 1 ? f + 1 : N_FAIXAS - 1;
  for (let k = a; k <= z; k++) {
    const d = pertoDe(palFaixa, nFaixa[k], r, g, b, k * MAX_CORES_FAIXA);
    if (d < m) m = d;
  }
  return m;
}

// Sombra é a cor do fundo escurecida: mesma proporção entre os canais,
// só que mais escura. Sem esta regra a sombra na mesa entra como
// produto e estica a silhueta — e a silhueta é o molde da escultura.
function ehSombraDoFundo(r, g, b, f) {
  const lp = r * 0.299 + g * 0.587 + b * 0.114;
  const a = f > 0 ? f - 1 : 0, z = f < N_FAIXAS - 1 ? f + 1 : N_FAIXAS - 1;
  for (let k = a; k <= z; k++) {
    for (let i = 0; i < nFaixa[k]; i++) {
      const o = (k * MAX_CORES_FAIXA + i) * 3;
      const R = palFaixa[o], G = palFaixa[o + 1], B = palFaixa[o + 2];
      const lf = R * 0.299 + G * 0.587 + B * 0.114;
      if (lf < 12) continue;
      const q = lp / lf;
      if (q < 0.38 || q > 1.06) continue;
      const dr = r - q * R, dg = g - q * G, db = b - q * B;
      if (dr * dr + dg * dg + db * db < SOMBRA * SOMBRA) return true;
    }
  }
  return false;
}

// 1 = produto, 0 = fundo — para um pixel da faixa f
function classificar(r, g, b, f) {
  const c = f * 32768 + corCache(r, g, b);
  const v = cache[c];
  if (v) return v - 1;
  const dP = pertoDe(palProd, nProd, r, g, b);
  const dF = pertoDoFundo(r, g, b, f);
  // Mais perto de uma cor do produto do que de qualquer cor do fundo.
  // O teste de sombra só entra quando o pixel NÃO é claramente de uma
  // cor do produto: uma capa cinza sobre mesa branca passa no teste de
  // sombra por coincidência aritmética, e reprová-la por isso seria
  // voltar exatamente ao bug que estamos corrigindo.
  let ehProd = dP < dF;
  if (ehProd && dP > TOL_PROD * TOL_PROD && ehSombraDoFundo(r, g, b, f)) ehProd = false;
  cache[c] = ehProd ? 2 : 1;
  return ehProd ? 1 : 0;
}

// Aprende o fundo pelas margens (fora de uma moldura folgada)
function aprenderFundo(px) {
  // A banda começa longe da moldura (10%, não 4%). Com 4%, um produto
  // um pouco perto demais encostava a própria cor na banda, entrava na
  // paleta de FUNDO e sumia inteiro: o scanner dizia "coloque o produto
  // na moldura" para quem já estava com o produto tomando a tela toda.
  const mx = Math.round(LARG * 0.10), my = Math.round(ALT * 0.10);
  const fx0 = Math.max(0, ROI.x0 - mx), fx1 = Math.min(LARG, ROI.x1 + mx);
  const fy0 = Math.max(0, ROI.y0 - my), fy1 = Math.min(ALT, ROI.y1 + my);

  // Uma paleta por faixa de altura, com as margens laterais da mesma altura
  // (meia faixa de sobra para cima e para baixo). A primeira faixa vê também
  // tudo o que está acima da moldura, e a última tudo o que está abaixo.
  const meia = ALT_FAIXA >> 1;
  for (let f = 0; f < N_FAIXAS; f++) {
    zerarHist();
    const ya = f === 0 ? 0 : Math.max(0, ROI.y0 + f * ALT_FAIXA - meia);
    const yb = f === N_FAIXAS - 1 ? ALT : Math.min(ALT, ROI.y0 + (f + 1) * ALT_FAIXA + meia);
    let nf = 0;
    for (let y = ya; y < yb; y++) {
      const dentroY = y >= fy0 && y < fy1;
      for (let x = 0; x < LARG; x++) {
        if (dentroY && x >= fx0 && x < fx1) { x = fx1 - 1; continue; }
        contarCor(px, (y * LARG + x) * 4); nf++;
      }
    }
    nFaixa[f] = extrairPaleta(palFaixa, Math.max(3, nf * 0.006), MAX_CORES_FAIXA, f * MAX_CORES_FAIXA);
  }
}

// Aprende o produto pelo miolo da moldura, ignorando o que já é cor de
// fundo. Se o lojista ainda não pôs nada ali, a paleta sai vazia e
// nada é achado — que é a resposta certa para uma mesa vazia.
function aprenderProdutoDoMiolo(px) {
  zerarHist();
  const mw = (ROI.x1 - ROI.x0) * 0.17, mh = (ROI.y1 - ROI.y0) * 0.17;
  const cx0 = Math.round((ROI.x0 + ROI.x1) / 2 - mw), cx1 = Math.round((ROI.x0 + ROI.x1) / 2 + mw);
  const cy0 = Math.round((ROI.y0 + ROI.y1) / 2 - mh), cy1 = Math.round((ROI.y0 + ROI.y1) / 2 + mh);
  let n = 0;
  for (let y = cy0; y < cy1; y++) {
    const f = faixaDe(y);
    for (let x = cx0; x < cx1; x++) {
      const j = (y * LARG + x) * 4;
      const r = px[j], g = px[j + 1], b = px[j + 2];
      // Sem teste de sombra aqui, de propósito. Uma capa cinza-clara
      // sobre mesa branca é aritmeticamente idêntica a uma sombra do
      // branco (mesma proporção entre canais, só mais escura), então o
      // teste jogava fora justamente o produto que queremos aprender.
      // Na classificação ele continua valendo — lá é seguro, porque só
      // se aplica a pixels que NÃO são de uma cor já aprendida.
      if (pertoDoFundo(r, g, b, f) < TOL_PROD * TOL_PROD) continue;
      contarCor(px, j); n++;
    }
  }
  const total = (cx1 - cx0) * (cy1 - cy0);
  // Menos de 12% do miolo sobrando: é mesa vazia, não produto
  if (n < total * 0.12) { nProd = 0; return; }
  nProd = extrairPaleta(palProd, Math.max(3, n * 0.02), MAX_CORES_PROD);
}

const CRESCE = 6;                    // px que a mancha cresce para olhar em volta

// Engorda a máscara alguns pixels, para poder olhar a vizinhança dela
function crescer(m, passos) {
  let a = trabalho2, b = trabalho3;
  a.set(m);
  for (let k = 0; k < passos; k++) { dilate(a, b); const t = a; a = b; b = t; }
  return a;
}

// Segunda rodada: reaprende as cores do produto olhando a mancha e uma
// faixa em volta dela. Salva dois casos:
//   • produto de várias cores — garrafa com rótulo no meio e tampa
//     colorida em cima, que o miolo sozinho não pega inteiro;
//   • caixa com logo escuro tomando todo o miolo — a semente cai em
//     cima do logo e é a faixa em volta que traz a cor da caixa.
//
// As cores novas SOMAM às do miolo, nunca as substituem. Antes a paleta era
// refeita do zero com corte de 2% da mancha inteira: num borrifador os tons
// de sombra do corpo e a faixa verde do rótulo ficavam abaixo do corte,
// sumiam da paleta, a faixa virava "fundo" e partia a silhueta em duas — e o
// corpo de baixo ia embora junto com a metade menor. Na bancada, isso tirava
// 30% do produto em TODO quadro.
const novas = new Float32Array(MAX_CORES_PROD * 3);
function reaprenderProduto(px, m) {
  const g = crescer(m, CRESCE);
  zerarHist();
  let n = 0;
  for (let y = ROI.y0; y < ROI.y1; y++) {
    const f = faixaDe(y);
    for (let x = ROI.x0; x < ROI.x1; x++) {
      const i = y * LARG + x;
      if (!g[i]) continue;
      const j = i * 4, r = px[j], gg = px[j + 1], b = px[j + 2];
      // Cor de fundo não vira cor de produto nem dentro da mancha: a mancha
      // já passou por fechamento e emenda de lacunas, que costuram pixels
      // de fundo nela — e uma cor de fundo na paleta do produto transforma
      // a parede inteira em "produto".
      if (pertoDoFundo(r, gg, b, f) < TOL_PROD * TOL_PROD) continue;
      if (!m[i]) {
        // Fora da mancha o pixel é de origem desconhecida, então aqui
        // vale ser conservador: sombra do fundo também fica de fora.
        // (Dentro é o contrário — lá a semente É o produto, e descartar
        // sombra descartaria produto cinza sobre mesa branca.)
        if (ehSombraDoFundo(r, gg, b, f)) continue;
      }
      contarCor(px, j); n++;
    }
  }
  if (n < 200) return false;
  const nNovas = extrairPaleta(novas, Math.max(3, n * 0.004), MAX_CORES_PROD);
  for (let k = 0; k < nNovas && nProd < MAX_CORES_PROD; k++) {
    const R = novas[k * 3], G = novas[k * 3 + 1], B = novas[k * 3 + 2];
    if (pertoDe(palProd, nProd, R, G, B) < 14 * 14) continue;     // essa já estava
    let deFundo = false;                                          // é de alguma faixa do fundo?
    for (let q = 0; q < N_FAIXAS && !deFundo; q++) {
      if (pertoDe(palFaixa, nFaixa[q], R, G, B, q * MAX_CORES_FAIXA) < TOL_PROD * TOL_PROD) deFundo = true;
    }
    if (deFundo) continue;
    palProd[nProd * 3] = R; palProd[nProd * 3 + 1] = G; palProd[nProd * 3 + 2] = B;
    nProd++;
  }
  return nProd > 0;
}

function pintarMascara(px, m) {
  cache.fill(0);
  m.fill(0);
  if (!nProd) return;
  for (let y = ROI.y0; y < ROI.y1; y++) {
    const f = faixaDe(y);
    for (let x = ROI.x0; x < ROI.x1; x++) {
      const i = y * LARG + x, j = i * 4;
      m[i] = classificar(px[j], px[j + 1], px[j + 2], f);
    }
  }
}

// Fecha lacunas curtas entre dois trechos de produto na mesma coluna (e,
// mais curtas, na mesma linha). Uma faixa de rótulo da cor do fundo — a
// listra mostarda de um frasco sobre mesa de madeira — atravessa o produto
// de lado a lado e o parte em dois; nenhuma limpeza de ruído junta as
// metades de volta. O vão de dentro de uma alça é bem mais alto do que isto
// e continua aberto.
const LACUNA_V = 18, LACUNA_H = 10;
function fecharLacunas(m) {
  for (let x = ROI.x0; x < ROI.x1; x++) {
    let ultimo = -1;
    for (let y = ROI.y0; y < ROI.y1; y++) {
      if (!m[y * LARG + x]) continue;
      const vao = y - ultimo - 1;
      if (ultimo >= 0 && vao > 0 && vao <= LACUNA_V) for (let k = ultimo + 1; k < y; k++) m[k * LARG + x] = 1;
      ultimo = y;
    }
  }
  for (let y = ROI.y0; y < ROI.y1; y++) {
    const base = y * LARG;
    let ultimo = -1;
    for (let x = ROI.x0; x < ROI.x1; x++) {
      if (!m[base + x]) continue;
      const vao = x - ultimo - 1;
      if (ultimo >= 0 && vao > 0 && vao <= LACUNA_H) for (let k = ultimo + 1; k < x; k++) m[base + k] = 1;
      ultimo = x;
    }
  }
}

// A máscara só existe dentro da moldura, então varrer o quadro inteiro
// nestas duas seria jogar fora dois terços do trabalho. A faixa leva
// uma folga de 8 px, que é mais do que a máscara chega a crescer.
const BY0 = Math.max(1, ROI.y0 - 8), BY1 = Math.min(ALT - 1, ROI.y1 + 8);
const BX0 = Math.max(1, ROI.x0 - 8), BX1 = Math.min(LARG - 1, ROI.x1 + 8);

function erode(src, dst) {
  dst.fill(0);
  for (let y = BY0; y < BY1; y++) {
    for (let x = BX0; x < BX1; x++) {
      const i = y * LARG + x;
      if (src[i] && src[i - 1] && src[i + 1] && src[i - LARG] && src[i + LARG]) dst[i] = 1;
    }
  }
}

function dilate(src, dst) {
  dst.fill(0);
  for (let y = BY0; y < BY1; y++) {
    for (let x = BX0; x < BX1; x++) {
      const i = y * LARG + x;
      if (src[i] || src[i - 1] || src[i + 1] || src[i - LARG] || src[i + LARG]) dst[i] = 1;
    }
  }
}

// Fica com a maior mancha conectada — mata sombra solta e reflexo — e com as
// manchas grandes logo acima ou abaixo dela, na mesma coluna: é o produto
// partido por uma faixa da cor do fundo mais alta do que fecharLacunas
// alcança. Ficar só com a maior jogava fora a outra metade do produto.
function maiorComponente(m) {
  const marca = marcas;
  marca.fill(0);
  const tams = [0], cx0 = [0], cx1 = [0], cy0 = [0], cy1 = [0];
  let melhorTam = 0, melhorId = 0, id = 0;
  for (let y = ROI.y0; y < ROI.y1; y++) {
    for (let x = ROI.x0; x < ROI.x1; x++) {
      const s = y * LARG + x;
      if (!m[s] || marca[s]) continue;
      id++;
      let topo = 0, tam = 0, ax0 = x, ax1 = x, ay0 = y, ay1 = y;
      pilha[topo++] = s;
      marca[s] = id;
      while (topo > 0) {
        const p = pilha[--topo];
        tam++;
        const py = (p / LARG) | 0, pxx = p - py * LARG;
        if (pxx < ax0) ax0 = pxx; if (pxx > ax1) ax1 = pxx;
        if (py < ay0) ay0 = py; if (py > ay1) ay1 = py;
        if (pxx > ROI.x0 && m[p - 1] && !marca[p - 1]) { marca[p - 1] = id; pilha[topo++] = p - 1; }
        if (pxx < ROI.x1 - 1 && m[p + 1] && !marca[p + 1]) { marca[p + 1] = id; pilha[topo++] = p + 1; }
        if (py > ROI.y0 && m[p - LARG] && !marca[p - LARG]) { marca[p - LARG] = id; pilha[topo++] = p - LARG; }
        if (py < ROI.y1 - 1 && m[p + LARG] && !marca[p + LARG]) { marca[p + LARG] = id; pilha[topo++] = p + LARG; }
      }
      tams.push(tam); cx0.push(ax0); cx1.push(ax1); cy0.push(ay0); cy1.push(ay1);
      if (tam > melhorTam) { melhorTam = tam; melhorId = id; }
    }
  }
  if (!melhorId) { m.fill(0); return 0; }
  const fica = new Uint8Array(id + 1);
  fica[melhorId] = 1;
  let area = melhorTam;
  const altM = cy1[melhorId] - cy0[melhorId] + 1;
  for (let k = 1; k <= id; k++) {
    if (k === melhorId || tams[k] < melhorTam * 0.12) continue;
    const sobre = Math.min(cx1[k], cx1[melhorId]) - Math.max(cx0[k], cx0[melhorId]) + 1;
    const largMenor = Math.min(cx1[k] - cx0[k], cx1[melhorId] - cx0[melhorId]) + 1;
    const vao = Math.max(cy0[k] - cy1[melhorId], cy0[melhorId] - cy1[k]);
    if (sobre >= largMenor * 0.5 && vao <= altM * 0.35) { fica[k] = 1; area += tams[k]; }
  }
  for (let i = 0; i < m.length; i++) m[i] = fica[marca[i]] ? 1 : 0;
  return area;
}

// Tapa buracos: o que é fundo mas não se liga à borda da moldura
// (um logo escuro no meio do produto, por exemplo) vira produto
function taparBuracos(m) {
  const visto = trabalho2;
  visto.fill(0);
  let topo = 0;
  for (let x = ROI.x0; x < ROI.x1; x++) {
    const a = ROI.y0 * LARG + x, b = (ROI.y1 - 1) * LARG + x;
    if (!m[a] && !visto[a]) { visto[a] = 1; pilha[topo++] = a; }
    if (!m[b] && !visto[b]) { visto[b] = 1; pilha[topo++] = b; }
  }
  for (let y = ROI.y0; y < ROI.y1; y++) {
    const a = y * LARG + ROI.x0, b = y * LARG + ROI.x1 - 1;
    if (!m[a] && !visto[a]) { visto[a] = 1; pilha[topo++] = a; }
    if (!m[b] && !visto[b]) { visto[b] = 1; pilha[topo++] = b; }
  }
  while (topo > 0) {
    const p = pilha[--topo];
    const py = (p / LARG) | 0, pxx = p - py * LARG;
    if (pxx > ROI.x0 && !m[p - 1] && !visto[p - 1]) { visto[p - 1] = 1; pilha[topo++] = p - 1; }
    if (pxx < ROI.x1 - 1 && !m[p + 1] && !visto[p + 1]) { visto[p + 1] = 1; pilha[topo++] = p + 1; }
    if (py > ROI.y0 && !m[p - LARG] && !visto[p - LARG]) { visto[p - LARG] = 1; pilha[topo++] = p - LARG; }
    if (py < ROI.y1 - 1 && !m[p + LARG] && !visto[p + LARG]) { visto[p + LARG] = 1; pilha[topo++] = p + LARG; }
  }
  for (let y = ROI.y0; y < ROI.y1; y++) {
    for (let x = ROI.x0; x < ROI.x1; x++) {
      const i = y * LARG + x;
      if (!m[i] && !visto[i]) m[i] = 1;
    }
  }
}

// Devolve { mascara, area, encosta, ... } — ver o final da função
function segmentar(px) {
  const m = trabalho;

  aprenderFundo(px);
  aprenderProdutoDoMiolo(px);
  pintarMascara(px, m);

  // Abertura (tira poeira) e fechamento (costura o produto)
  erode(m, trabalho2); dilate(trabalho2, m);
  dilate(m, trabalho2); erode(trabalho2, m);
  fecharLacunas(m);

  let area = maiorComponente(m);

  // Segunda rodada: com a mancha na mão, reaprende as cores do produto
  // e repinta. É barato e é o que traz a parte do produto que não
  // passava pelo miolo — tampa, alça, rótulo de outra cor.
  if (area > 400 && reaprenderProduto(px, m)) {
    pintarMascara(px, m);
    erode(m, trabalho2); dilate(trabalho2, m);
    dilate(m, trabalho2); erode(trabalho2, m);
    fecharLacunas(m);
    area = maiorComponente(m);
  }

  if (area) taparBuracos(m);

  // Produto cortado pela moldura estraga a escultura — precisamos avisar
  let encosta = 0;
  for (let x = ROI.x0; x < ROI.x1; x++) {
    if (m[ROI.y0 * LARG + x]) encosta++;
    if (m[(ROI.y1 - 1) * LARG + x]) encosta++;
  }
  for (let y = ROI.y0; y < ROI.y1; y++) {
    if (m[y * LARG + ROI.x0]) encosta++;
    if (m[y * LARG + ROI.x1 - 1]) encosta++;
  }

  // Centro de massa e caixa do produto: é com isso que dá para dizer
  // "centralize" ou "aproxime" em vez de só "está ruim"
  let somaX = 0, somaY = 0, minX = LARG, maxX = 0, minY = ALT, maxY = 0;
  if (area) {
    for (let y = ROI.y0; y < ROI.y1; y++) {
      for (let x = ROI.x0; x < ROI.x1; x++) {
        if (!m[y * LARG + x]) continue;
        somaX += x; somaY += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }

  // Luz média dentro da moldura, em amostragem espaçada. O estouro é
  // contado à parte, em pixels queimados: pela média, uma mesa branca
  // bem iluminada (média ~240) era acusada de contraluz sem motivo.
  let luz = 0, n = 0, queima = 0;
  for (let y = ROI.y0; y < ROI.y1; y += 2) {
    for (let x = ROI.x0; x < ROI.x1; x += 2) {
      const j = (y * LARG + x) * 4;
      luz += (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
      if (px[j] > 249 && px[j + 1] > 249 && px[j + 2] > 249) queima++;
      n++;
    }
  }
  // "Está escuro" olha também as partes CLARAS do quadro inteiro (percentil
  // 90). Só pela média da moldura, produto escuro sobre fundo escuro — caixa
  // azul-marinho numa mesa grafite, bem iluminadas — travava o scanner em
  // "acenda uma luz" para sempre. Cena escura de verdade não tem parte clara.
  // Quem junta as duas medidas é escuro().
  const histLuz = new Int32Array(64);
  let nl = 0;
  for (let y = 0; y < ALT; y += 4) {
    for (let x = 0; x < LARG; x += 4) {
      const j = (y * LARG + x) * 4;
      histLuz[((px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000) >> 2]++;
      nl++;
    }
  }
  let luzAlta = 0;
  for (let k = 63, acc = 0; k >= 0; k--) { acc += histLuz[k]; if (acc >= nl * 0.10) { luzAlta = k * 4 + 2; break; } }

  // Nitidez medida SÓ NA BORDA do produto. Medir na moldura inteira
  // confundia desfoque com cena lisa: produto fosco sobre fundo liso
  // tem pouquíssima textura e era reprovado como "tremido" mesmo em
  // foco perfeito. Na borda, o que importa é o salto de cor entre
  // produto e fundo — que é justamente o que o desfoque derrete.
  let salto = 0, nb = 0;
  for (let y = ROI.y0 + 1; y < ROI.y1 - 2; y++) {
    for (let x = ROI.x0 + 1; x < ROI.x1 - 2; x++) {
      const i = y * LARG + x;
      if (m[i] === m[i + 1] && m[i] === m[i + LARG]) continue;   // não é borda
      const j = i * 4;
      const dx = Math.abs(px[j + 4] - px[j]) + Math.abs(px[j + 5] - px[j + 1]) + Math.abs(px[j + 6] - px[j + 2]);
      const jy = j + LARG * 4;
      const dy = Math.abs(px[jy] - px[j]) + Math.abs(px[jy + 1] - px[j + 1]) + Math.abs(px[jy + 2] - px[j + 2]);
      salto += Math.max(dx, dy);
      nb++;
    }
  }

  return {
    mascara: m, area: area, encosta: encosta,
    cx: area ? somaX / area : 0,
    cy: area ? somaY / area : 0,
    larguraPx: area ? maxX - minX : 0,
    alturaPx: area ? maxY - minY : 0,
    luz: n ? luz / n : 0,
    luzAlta: luzAlta,
    queimado: n ? queima / n : 0,
    nitidez: nb ? salto / nb : 0
  };
}

// ============================================================
//  LEITURA DA CENA → UMA INSTRUÇÃO POR VEZ
//  A ideia é a mesma dos leitores de rosto: em vez de um "está
//  ruim" genérico, dizer exatamente o próximo gesto. A ordem
//  importa — resolve-se primeiro o que impede tudo o mais.
// ============================================================

const AREA_MOLDURA = (ROI.x1 - ROI.x0) * (ROI.y1 - ROI.y0);

// Encostar na moldura tolera uma franja: 2,5% do perímetro. Fixo em 6 px,
// uma ponta de sombra já reprovava o enquadramento.
const FOLGA_BORDA = Math.round(2 * ((ROI.x1 - ROI.x0) + (ROI.y1 - ROI.y0)) * 0.025);

// Cena escura de verdade: a moldura está escura E nem as partes mais claras
// do quadro inteiro passam de 50 (com a exposição automática do celular, isso
// só acontece no breu). As duas medidas juntas, porque cada uma sozinha trava
// um caso bom:
//   · só a média da moldura reprovava produto escuro em fundo escuro, os dois
//     bem iluminados (caixa azul-marinho em mesa grafite);
//   · só o percentil do quadro reprovava produto claro e pequeno sobre toalha
//     preta — ele ocupa menos de 10% do quadro, e o percentil 90 cai no fundo.
function escuro(r) {
  if (r.luz < 18) return true;
  if (r.luz > 45) return false;
  return r.luzAlta != null ? r.luzAlta < 50 : true;
}

function avaliarCena(r) {
  const frac = r.area / AREA_MOLDURA;
  // Quanto o produto ocupa da moldura. Para saber se está LONGE vale a
  // maior das duas medidas: só pela altura era impossível enquadrar
  // produto deitado — um estojo de 3 por 1 precisaria de 345 px de
  // largura para chegar aos 45% de altura, mas a moldura só tem 262, e
  // saíam "aproxime" e "está saindo da moldura" ao mesmo tempo, um
  // contra o outro, para sempre.
  const ocupaA = r.alturaPx / (ROI.y1 - ROI.y0);
  const ocupaL = r.larguraPx / (ROI.x1 - ROI.x0);
  const ocupa = Math.max(ocupaA, ocupaL);

  // Para saber se está PERTO demais, cada eixo tem o seu teto, porque
  // o volume de voxels é mais alto (1,12) do que largo (0,96) e a
  // moldura, ao contrário, é mais larga (1,02) do que alta (1,00).
  // Em altura sobra folga de sobra; em largura, não: produto ocupando
  // a moldura toda já sai com as laterais cortadas, e pior ao girar,
  // quando a diagonal passa na frente. Girar não muda a altura, então
  // só a largura precisa da margem.
  const grande = ocupaA > 0.98 || ocupaL > 0.88;



  // Cada condição vira um item da lista que o lojista vê marcar sozinho
  // `essencial` decide o que TRAVA o início. O foco fica de fora de
  // propósito: a medida cai junto com o contraste da cena, então um
  // produto fosco sobre fundo de cor próxima poderia deixar o lojista
  // preso sem nunca conseguir escanear. Ele avisa, mas não impede.
  // Limiares aferidos contra desfoque real: nítido ~210, 1px ~73,
  // 3px ~38, 8px ~16.
  const itens = [
    { chave: 'achou',   rotulo: 'Produto encontrado',  essencial: true,  ok: frac > 0.03 && frac < 0.90 },
    { chave: 'dentro',  rotulo: 'Inteiro na moldura',  essencial: true,  ok: r.encosta <= FOLGA_BORDA },
    { chave: 'tamanho', rotulo: 'Na distância certa',  essencial: true,  ok: ocupa > 0.38 && !grande },
    { chave: 'centro',  rotulo: 'Centralizado',        essencial: true,  ok: Math.abs(r.cx - (ROI.x0 + ROI.x1) / 2) < (ROI.x1 - ROI.x0) * 0.16 },
    { chave: 'luz',     rotulo: 'Luz suficiente',      essencial: true,  ok: escuro(r) === false && r.queimado < 0.25 },
    { chave: 'foco',    rotulo: 'Imagem nítida',       essencial: false, ok: r.nitidez > 22 }
  ];

  // A primeira condição que falha vira a instrução da vez
  let instrucao = null, grave = false;

  if (frac <= 0.03) {
    // Vale tanto para mesa vazia quanto para produto tão perto que toma
    // a tela inteira: só pelas cores não dá para separar os dois casos,
    // então a frase tem de ser segura nos dois.
    instrucao = 'Não achei o produto — afaste e use uma superfície de cor bem diferente';
    grave = true;
  } else if (escuro(r)) {
    instrucao = 'Está escuro demais — acenda uma luz'; grave = true;
  } else if (r.queimado >= 0.25) {
    instrucao = 'Luz estourada — tire o produto do contraluz'; grave = true;
  } else if (r.encosta > FOLGA_BORDA) {
    instrucao = 'Afaste um pouco — o produto está saindo da moldura'; grave = true;
  // Este aviso vem DEPOIS do de encostar na moldura. Máscara tomando a
  // moldura inteira quase sempre é produto perto demais, e "afaste" é a
  // instrução certa; só quando ele já cabe na moldura é que sobrar tudo
  // marcado significa mesmo que fundo e produto têm a mesma cor.
  } else if (frac >= 0.90) {
    instrucao = 'O fundo está parecido com o produto — use uma superfície de cor bem diferente'; grave = true;
  } else if (ocupa <= 0.38) {
    instrucao = 'Aproxime até o produto encher a moldura'; grave = true;
  } else if (grande) {
    instrucao = 'Afaste um pouco — deixe uma folga em volta do produto'; grave = true;
  } else if (r.cx < (ROI.x0 + ROI.x1) / 2 - (ROI.x1 - ROI.x0) * 0.16) {
    instrucao = 'Mova o produto para a direita'; grave = false;
  } else if (r.cx > (ROI.x0 + ROI.x1) / 2 + (ROI.x1 - ROI.x0) * 0.16) {
    instrucao = 'Mova o produto para a esquerda'; grave = false;
  } else if (r.nitidez <= 22) {
    instrucao = 'Segure firme — a imagem está tremida'; grave = false;
  }

  return {
    itens: itens,
    instrucao: instrucao,
    pronto: itens.every(i => !i.essencial || i.ok),
    grave: grave
  };
}

// ============================================================
//  2. CÂMERAS — o modelo de "prato giratório"
//  Assumimos que os quadros capturados cobrem uma volta inteira em
//  passos iguais. Quem gira o produto (ou anda em volta mantendo a
//  distância) produz exatamente esse movimento relativo.
// ============================================================

// poses: lista de { t: azimute, e: elevação, r: rolagem } em radianos
// ajuste.eixoPx: em que coluna da imagem o eixo do giro caiu, medido a partir
// do centro (positivo = à direita). Quem gira o produto quase nunca o põe
// exatamente no meio do quadro, e o casco é implacável com isso: medido na
// bancada, um eixo 5% da moldura fora do centro já derrubava a peça de
// IoU 0,62 para 0,27 — cada silhueta "puxa" para um lado e a interseção come
// as laterais. Deslocar o ponto principal da câmera põe o eixo onde ele está.
function montarCameras(poses, ajuste) {
  // Distância que faz um objeto de 1 unidade ocupar FRAC_ALTURA do quadro
  const D = 1 / (2 * FRAC_ALTURA * Math.tan(FOV / 2));
  const meia = D * Math.tan(FOV / 2);
  const aspecto = LARG / ALT;
  const proj = new THREE.Matrix4().makePerspective(
    -meia * aspecto, meia * aspecto, meia, -meia, D, 100
  );
  const dx = ajuste && ajuste.eixoPx ? 2 * ajuste.eixoPx / LARG : 0;
  if (dx) proj.premultiply(new THREE.Matrix4().set(1, 0, 0, dx, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1));
  const alvo = new THREE.Vector3(0, 0, 0);
  const cima = new THREE.Vector3(0, 1, 0);
  return poses.map(function (p) {
    const pos = new THREE.Vector3(
      D * Math.cos(p.e) * Math.sin(p.t),
      D * Math.sin(p.e),
      D * Math.cos(p.e) * Math.cos(p.t)
    );
    const view = new THREE.Matrix4().lookAt(pos, alvo, cima);
    // Celular torto na mão: o eixo do giro aparece inclinado na imagem
    if (p.r) view.multiply(new THREE.Matrix4().makeRotationZ(p.r));
    view.setPosition(pos);
    view.invert();
    return { vp: new THREE.Matrix4().multiplyMatrices(proj, view), pos: pos };
  });
}

// Traduz os quadros capturados em poses. Assumimos que eles cobrem uma
// volta inteira, girando em velocidade constante — por isso o lojista pode
// encerrar mais cedo sem estragar nada, desde que tenha completado o giro.
// Com o horário de cada quadro (q.t, em ms) o ângulo sai do TEMPO, não da
// contagem: um quadro descartado por sair da moldura não "segura" o giro,
// porque o produto continuou girando enquanto ele era jogado fora.
// `fator` corrige a volta suposta pela medida (autocalibrar): 0,83 = girou 300°.
function posesDosQuadros(quadros, fator) {
  const n = quadros.length;
  const f = fator || 1;
  const comTempo = n > 1 && quadros.every(q => Number.isFinite(q.t));
  const t0 = comTempo ? quadros[0].t : 0;
  // A volta fecha um passo depois do último quadro (o quadro seguinte
  // seria o primeiro de novo), por isso n / (n − 1)
  const volta = comTempo ? (quadros[n - 1].t - t0) * n / (n - 1) : 0;
  return quadros.map(function (q, i) {
    const frac = volta > 0 ? (q.t - t0) / volta : i / n;
    return { t: f * frac * Math.PI * 2, e: ELEVACAO, r: 0 };
  });
}

// Encaixa a grade de voxels no produto que foi capturado.
//
// A grade tem sempre 96×112×96 voxels; o que muda é a aresta. Com aresta
// fixa em 0,01 ela cobria 0,96 × 1,12 × 0,96, e o enquadramento só sabe
// medir o que aparece no quadro — LARGURA e ALTURA. A PROFUNDIDADE
// nenhum quadro sozinho enxerga: uma caixa comprida apontada para a
// câmera passa no porteiro pelo lado estreito e, na hora de esculpir,
// tem o fundo decepado reto na parede da grade.
//
// Medir depois da volta resolve dos dois lados: nada é cortado, e produto
// estreito ganha voxel mais fino em vez de deixar dois terços da grade
// vazios. O tamanho absoluto não importa — _construirMalha reescala a
// peça no fim, pelas medidas cadastradas ou pela altura.

// Corta o polígono, ficando com o lado nx·x + nz·z ≤ d (Sutherland–Hodgman)
function cortarPlanta(pol, nx, nz, d) {
  const saida = [];
  for (let i = 0; i < pol.length; i++) {
    const a = pol[i], b = pol[(i + 1) % pol.length];
    const da = nx * a[0] + nz * a[1] - d;
    const db = nx * b[0] + nz * b[1] - d;
    if (da <= 0) saida.push(a);
    if ((da <= 0) !== (db <= 0)) {
      const t = da / (da - db);
      saida.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return saida;
}

function ajustarVolume(quadros, poses, eixoPx) {
  // Unidades de mundo por pixel, no plano que passa pelo eixo do giro:
  // o quadro inteiro tem 1/FRAC_ALTURA de altura a essa distância.
  const U = 1 / (FRAC_ALTURA * ALT);
  const meioX = LARG / 2 + (eixoPx || 0), meioY = ALT / 2;
  const n = quadros.length;
  const meiaLarg = new Float64Array(n);
  let yLo = Infinity, yHi = -Infinity, achou = false;

  for (let q = 0; q < n; q++) {
    const m = quadros[q].mascara;
    let h = 0;
    for (let y = 0; y < ALT; y++) {
      const base = y * LARG;
      for (let x = 0; x < LARG; x++) {
        if (!m[base + x]) continue;
        achou = true;
        const d = Math.abs(x + 0.5 - meioX);
        if (d > h) h = d;
        if (y < yLo) yLo = y;
        if (y > yHi) yHi = y;
      }
    }
    meiaLarg[q] = h * U;
  }
  if (!achou) return;                          // sem silhueta: mantém o padrão

  // Planta baixa. O eixo do giro projeta no meio do quadro e a coluna da
  // imagem mede a direção (cos t, −sen t) — a elevação não mexe nisso,
  // porque o "direita" da câmera é sempre horizontal. Cada quadro diz
  // então que o produto cabe na faixa |x·cos t − z·sen t| ≤ meia-largura.
  // O produto está na interseção das faixas, e é a caixa dessa interseção
  // que a grade precisa cobrir — não o círculo que passa por ela, que
  // inflaria o voxel à toa em quem já cabia.
  //
  // O quadrado de partida leva 60% de sobra: com a volta em passos iguais
  // as próprias faixas o aparam, e começar maior do que a resposta só
  // custa uma aparada a mais. Começar menor, não — se a volta não tiver
  // quadro exatamente a 0° e a 90°, um quadrado justo cortaria a caixa
  // antes de qualquer faixa opinar.
  let raio = 0;
  for (let q = 0; q < n; q++) if (meiaLarg[q] > raio) raio = meiaLarg[q];
  const s0 = raio * 1.6;
  let pol = [[-s0, -s0], [s0, -s0], [s0, s0], [-s0, s0]];
  for (let q = 0; q < n && pol.length > 2; q++) {
    const t = poses[q].t;
    const nx = Math.cos(t), nz = -Math.sin(t), d = meiaLarg[q];
    pol = cortarPlanta(pol, nx, nz, d);
    if (pol.length > 2) pol = cortarPlanta(pol, -nx, -nz, d);
  }
  let meiaX = 0, meiaZ = 0;
  for (let i = 0; i < pol.length; i++) {
    const ax = Math.abs(pol[i][0]), az = Math.abs(pol[i][1]);
    if (ax > meiaX) meiaX = ax;
    if (az > meiaZ) meiaZ = az;
  }
  if (!(meiaX > 0) || !(meiaZ > 0)) { meiaX = raio; meiaZ = raio; }

  const altura = (yHi - yLo + 1) * U;
  const centroY = (meioY - (yLo + yHi + 1) / 2) * U;

  // 6% de folga: a silhueta medida já superestima (a face de perto projeta
  // maior que o tamanho real), mas a elevação de 5° inclina um pouco o
  // topo, e raspar a parede custa mais caro do que sobrar grade.
  const p = Math.max(2 * meiaX / NX, 2 * meiaZ / NZ, altura / NY) * 1.06;
  if (!(p > 0)) return;

  PASSO = p;
  ORIGEM = [-(NX / 2) * PASSO, centroY - (NY / 2) * PASSO, -(NZ / 2) * PASSO];
}

// ============================================================
//  2b. O QUE A PRÓPRIA CAPTURA DIZ SOBRE A CÂMERA
//  O modelo de "prato giratório" acima supõe câmera parada na
//  altura do produto, eixo no meio da imagem e uma volta exata.
//  Na mão do lojista nada disso é verdade, então medimos.
// ============================================================

function mediana(v) {
  if (!v.length) return NaN;
  const s = v.slice().sort(function (a, b) { return a - b; });
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Campo de visão vertical do recorte 3:4, a partir do tamanho do vídeo.
// O lado longo do vídeo cobre ~66° na câmera principal dos celulares (e
// nas webcams); o recorte 3:4 pega a fração dele que _quadroAtual usa.
function fovDoRecorte(vw, vh) {
  if (!(vw > 0 && vh > 0)) return FOV_PADRAO;
  const alvo = LARG / ALT;
  const alturaRecorte = vw / vh > alvo ? vh : vw / alvo;   // em px do vídeo
  const meioLongo = Math.max(vw, vh) / 2;
  return 2 * Math.atan(Math.tan(FOV_LADO_LONGO / 2) * (alturaRecorte / 2) / meioLongo);
}

// Giroscópio → { e: elevação da câmera, r: rolagem }, em radianos.
// "Cima" do mundo nas coordenadas do aparelho (x à direita da tela, y para
// o topo, z saindo da tela) é (−cos β·sen γ, sen β, cos β·cos γ) — vale para
// qualquer α. A câmera traseira olha para −z, então a elevação (quanto ela
// aponta para baixo) é asen(cima.z). A rolagem é o quanto o "cima" do mundo
// aparece girado na imagem — já nas coordenadas da TELA, que é como o vídeo
// chega (o celular deitado de lado muda o que é "cima" na imagem).
function orientacaoDaCamera(beta, gamma, anguloTela) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const b = beta * Math.PI / 180, g = gamma * Math.PI / 180;
  const ux = -Math.cos(b) * Math.sin(g), uy = Math.sin(b), uz = Math.cos(b) * Math.cos(g);
  const a = (anguloTela || 0) * Math.PI / 180;
  const sx = ux * Math.cos(a) - uy * Math.sin(a);
  const sy = ux * Math.sin(a) + uy * Math.cos(a);
  const e = Math.asin(Math.max(-1, Math.min(1, uz)));
  return { e: e, r: Math.atan2(sx, sy) };
}

// Caixa e área de cada silhueta (a máscara só existe dentro da moldura)
function caixaDaSilhueta(m) {
  let x0 = LARG, x1 = -1, y0 = ALT, y1 = -1, area = 0;
  for (let y = ROI.y0; y < ROI.y1; y++) {
    const base = y * LARG;
    for (let x = ROI.x0; x < ROI.x1; x++) {
      if (!m[base + x]) continue;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return area ? { x0: x0, x1: x1, y0: y0, y1: y1, area: area } : null;
}

// Um quadro com o recorte quebrado apagaria material de verdade: o casco é a
// INTERSEÇÃO das silhuetas, e nenhum outro quadro devolve o que um tirou. Na
// bancada, um único quadro de um livro (pegou 12% do produto) esvaziou a
// peça inteira. Girar em volta do eixo vertical quase não muda a ALTURA da
// silhueta nem onde ficam o topo e a base, então um quadro que destoa dos
// vizinhos nisso está quebrado. A largura muda de verdade com o giro (livro
// de lado tem um quinto da largura de frente), então ela só derruba quadro
// quando a queda é grande demais para ser giro.
function quadrosConfiaveis(caixas) {
  const n = caixas.length;
  const ok = caixas.map(function (c) { return !!c; });
  const nota = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = caixas[i];
    if (!c) continue;
    const viz = [];
    for (let d = -3; d <= 3; d++) {
      if (!d) continue;
      const v = caixas[(i + d + n) % n];          // a volta fecha: o último é vizinho do primeiro
      if (v) viz.push(v);
    }
    if (viz.length < 3) continue;
    const altV = mediana(viz.map(function (v) { return v.y1 - v.y0; }));
    const topoV = mediana(viz.map(function (v) { return v.y0; }));
    const baseV = mediana(viz.map(function (v) { return v.y1; }));
    const areaV = mediana(viz.map(function (v) { return v.area; }));
    const alt = c.y1 - c.y0;
    const ruim = Math.max(
      (0.88 * altV - alt) / altV,                   // ficou baixo demais
      (c.y0 - topoV - 0.07 * altV) / altV,          // perdeu o topo
      (baseV - c.y1 - 0.07 * altV) / altV,          // perdeu a base
      (0.35 * areaV - c.area) / areaV               // sumiu um pedaço grande
    );
    if (ruim > 0) { ok[i] = false; nota[i] = ruim; }
  }
  // Defeito em quase todo quadro não é acidente, é o recorte errando sempre do
  // mesmo jeito; aí descartar não resolve e só tira informação. Fica no
  // máximo um quarto de fora — os piores.
  const fora = [];
  for (let i = 0; i < n; i++) if (caixas[i] && !ok[i]) fora.push(i);
  const limite = Math.floor(n / 4);
  if (fora.length > limite) {
    fora.sort(function (a, b) { return nota[b] - nota[a]; });
    for (let k = limite; k < fora.length; k++) ok[fora[k]] = true;
  }
  return ok;
}

// Coluna da imagem por onde passa o eixo do giro, medida do centro.
// Numa volta inteira cada lado de cada fatia do produto passa pelas duas
// bordas da silhueta, então a média dos meios cai sobre o eixo — vale para
// qualquer forma, simétrica ou não.
// O meio é medido LINHA a LINHA e só no miolo da altura (de 25% a 75%), com
// a mediana das linhas. A caixa do quadro inteiro não serve: a sombra na mesa
// encosta na base e, com a luz parada, cai do MESMO lado em todo quadro —
// esticava a caixa para lá e o eixo saía 25 px fora (na bancada, isso
// derrubou um frasco bem centralizado para IoU 0,02).
function eixoDaImagem(quadros, caixas, usar) {
  let s = 0, n = 0;
  for (let i = 0; i < caixas.length; i++) {
    const c = caixas[i];
    if (!c || (usar && !usar[i])) continue;
    const m = quadros[i].mascara;
    const h = c.y1 - c.y0;
    const meios = [];
    for (let y = c.y0 + Math.round(h * 0.25); y <= c.y1 - Math.round(h * 0.25); y += 2) {
      const base = y * LARG;
      let l = -1, r = -1;
      for (let x = c.x0; x <= c.x1; x++) if (m[base + x]) { if (l < 0) l = x; r = x; }
      if (l >= 0) meios.push((l + r + 1) / 2);
    }
    if (!meios.length) continue;
    s += mediana(meios); n++;
  }
  const d = n ? s / n - LARG / 2 : 0;
  return Math.abs(d) < 1.5 ? 0 : d;       // abaixo disso é ruído de recorte
}

// Sentido do giro. O modelo supõe que a frente do produto anda para a
// ESQUERDA na imagem a cada quadro; girar ao contrário não deforma o casco,
// mas espelha a peça (o rótulo sai escrito ao contrário). A textura do
// produto denuncia o sentido: procura o deslocamento horizontal que melhor
// alinha quadros vizinhos, só no miolo da silhueta, longe das bordas (que
// num cilindro não se mexem). Devolve +1 (o suposto), −1 (o contrário) ou
// 0 (produto liso ou simétrico: sem como saber, e aí tanto faz).
function sentidoDoGiro(quadros) {
  const W = LARG_C, H = ALT_C, sx = LARG / LARG_C, sy = ALT / ALT_C;
  const MAXD = 6;
  const lum = function (c, j) { return c[j] * 0.299 + c[j + 1] * 0.587 + c[j + 2] * 0.114; };
  let votoMais = 0, votoMenos = 0;
  for (let i = 0; i + 1 < quadros.length; i++) {
    const a = quadros[i], b = quadros[i + 1];
    if (!a.cores || !b.cores) continue;
    // miolo comum: dentro das duas máscaras, longe 4 px (na resolução da cor) das bordas
    const custo = new Float64Array(2 * MAXD + 1), cont = new Float64Array(2 * MAXD + 1);
    for (let y = 4; y < H - 4; y += 2) {
      for (let x = MAXD + 4; x < W - MAXD - 4; x += 1) {
        const im = ((y * sy) | 0) * LARG + ((x * sx) | 0);
        if (!a.mascara[im] || !b.mascara[im]) continue;
        const d4 = 4 * sx | 0;
        if (!a.mascara[im - d4] || !a.mascara[im + d4] || !b.mascara[im - d4] || !b.mascara[im + d4]) continue;
        const ja = (y * W + x) * 4;
        const la = lum(a.cores, ja);
        for (let d = -MAXD; d <= MAXD; d++) {
          const jb = (y * W + x + d) * 4;
          const dif = la - lum(b.cores, jb);
          custo[d + MAXD] += dif < 0 ? -dif : dif; cont[d + MAXD]++;
        }
      }
    }
    if (!cont[MAXD] || cont[MAXD] < 150) continue;
    let melhor = 0, melhorC = Infinity, pior = 0;
    for (let d = -MAXD; d <= MAXD; d++) {
      const c = custo[d + MAXD] / Math.max(1, cont[d + MAXD]);
      if (c < melhorC) { melhorC = c; melhor = d; }
      if (c > pior) pior = c;
    }
    // Só vota quem tem textura de verdade e um mínimo nítido fora do zero
    const c0 = custo[MAXD] / cont[MAXD];
    if (melhor === 0 || pior - melhorC < 3 || c0 - melhorC < 1) continue;
    if (melhor < 0) votoMais++; else votoMenos++;
  }
  const total = votoMais + votoMenos;
  if (total < 4) return 0;
  if (votoMais >= 0.7 * total) return 1;
  if (votoMenos >= 0.7 * total) return -1;
  return 0;
}

// ---------- autocalibração do eixo pelo próprio casco ----------
// Com o eixo errado, as silhuetas discordam entre si e a interseção ENCOLHE;
// com ele certo, ela fica a maior possível. Testar candidatos num casco
// grosso e ficar com o que deixa mais volume é a calibração clássica de prato
// giratório — e não depende de textura nem de recorte perfeito: na bancada,
// fundo estampado deixava a estimativa direta do eixo 5 px fora, o bastante
// para derrubar a peça.
const NXg = 40, NYg = 46, NZg = 40;

function camposDosQuadros(quadros) {
  return quadros.map(function (q) {
    const s = mascaraSuave(q.mascara);
    const c = new Uint8Array(LARG * ALT);
    for (let i = 0; i < c.length; i++) c[i] = (s[i] * 255 + 0.5) | 0;
    return c;
  });
}

// Volume (ponderado pela borda suave) do casco grosso para estas poses
function volumeGrosso(campos, poses, eixoPx, passoQ) {
  const cams = montarCameras(poses, { eixoPx: eixoPx });
  const px = PASSO * NX / NXg, py = PASSO * NY / NYg, pz = PASSO * NZ / NZg;
  const es = [];
  for (let f = 0; f < cams.length; f += passoQ) es.push([cams[f].vp.elements, campos[f]]);
  let vol = 0;
  for (let z = 0; z < NZg; z++) {
    const wz = ORIGEM[2] + (z + 0.5) * pz;
    for (let y = 0; y < NYg; y++) {
      const wy = ORIGEM[1] + (y + 0.5) * py;
      for (let x = 0; x < NXg; x++) {
        const wx = ORIGEM[0] + (x + 0.5) * px;
        let v = 255;
        for (let k = 0; k < es.length; k++) {
          const e = es[k][0];
          const cw = e[3] * wx + e[7] * wy + e[11] * wz + e[15];
          if (cw <= 0) { v = 0; break; }
          const ix = (((e[0] * wx + e[4] * wy + e[8] * wz + e[12]) / cw) * 0.5 + 0.5) * LARG | 0;
          const iy = (0.5 - ((e[1] * wx + e[5] * wy + e[9] * wz + e[13]) / cw) * 0.5) * ALT | 0;
          if (ix < 0 || ix >= LARG || iy < 0 || iy >= ALT) { v = 0; break; }
          const s = es[k][1][iy * LARG + ix];
          if (s < v) { v = s; if (v < 128) break; }
        }
        if (v >= 128) vol += v;
      }
    }
  }
  return vol;
}

// Ajusta a coluna do eixo para o casco mais cheio. As poses não mudam.
//
// Só o eixo sai daqui. A volta e a elevação também foram tentadas pelo mesmo
// critério e retiradas, porque nelas "mais volume" não mede acerto — é
// viciado:
//   · volta: espalhar os quadros num ângulo menor sempre deixa o casco maior
//     (menos direções diferentes esculpem menos), e a busca puxava a volta
//     para baixo à toa, até num pote liso;
//   · elevação: supor a câmera mais alta estica o casco na vertical e engorda
//     as "tendas" de cima e de baixo. Na bancada a busca parou no teto (40°)
//     nos nove casos, com a câmera de verdade a 5°, 25° ou 35° — e com ela a
//     5° a peça saía até 19% mais alta. Num produto de revolução (garrafa,
//     pote) a elevação nem é observável pelas silhuetas: toda elevação
//     explica as mesmas imagens com uma forma diferente.
// A elevação vem do giroscópio; sem ele, vale a suposta (ELEVACAO).
function autocalibrar(quadros, poses, eixo0) {
  const campos = camposDosQuadros(quadros);
  const passoQ = quadros.length > 24 ? 2 : 1;
  const medir = function (ex) { return volumeGrosso(campos, poses, ex, passoQ); };

  // ±8 px em passos de 1, depois ±0,75 em passos de 0,25
  let eixo = eixo0, melhor = medir(eixo0);
  const v0 = melhor;
  for (let d = -8; d <= 8; d++) { if (!d) continue; const v = medir(eixo0 + d); if (v > melhor) { melhor = v; eixo = eixo0 + d; } }
  const eixoGrosso = eixo;
  for (let d = -0.75; d <= 0.75; d += 0.25) { if (!d) continue; const v = medir(eixoGrosso + d); if (v > melhor) { melhor = v; eixo = eixoGrosso + d; } }
  return { eixoPx: eixo, ganho: melhor / Math.max(1, v0) };
}

// Elevação e rolagem de cada quadro. O giroscópio dá as duas com erro de
// ~1°; a mediana móvel de 5 quadros tira o tremido sem atrasar a curva.
function orientacoesDosQuadros(quadros) {
  const n = quadros.length;
  const lidos = quadros.map(function (q) { return q.orient && Number.isFinite(q.orient.e) ? q.orient : null; });
  const validos = lidos.filter(Boolean);
  if (validos.length < n * 0.6) return null;      // sem sensor (computador) ou leitura falhando
  const eMed = mediana(validos.map(function (o) { return o.e; }));
  const rMed = mediana(validos.map(function (o) { return o.r || 0; }));
  return lidos.map(function (_, i) {
    const es = [], rs = [];
    for (let d = -2; d <= 2; d++) {
      const o = lidos[i + d];
      if (o) { es.push(o.e); rs.push(o.r || 0); }
    }
    return { e: es.length ? mediana(es) : eMed, r: rs.length ? mediana(rs) : rMed };
  });
}

// ---------- limpeza do volume ----------

// Fica só com o pedaço principal do casco: quadros diferentes deixam pra trás
// grãos soltos (o modelo do Enzo tinha dois cubinhos de um voxel flutuando).
// Pedaços com pelo menos 10% do maior ficam — produto de duas partes existe.
function limparVolume(vol) {
  const N = NX * NY * NZ;
  const rotulo = new Int32Array(N);
  const fila = new Int32Array(N);
  const tamanhos = [0];
  let id = 0;
  for (let s = 0; s < N; s++) {
    if (vol[s] < ISO || rotulo[s]) continue;
    id++;
    let ini = 0, fim = 0, tam = 0;
    fila[fim++] = s; rotulo[s] = id;
    while (ini < fim) {
      const p = fila[ini++];
      tam++;
      const x = p % NX, y = ((p / NX) | 0) % NY, z = (p / (NX * NY)) | 0;
      const viz = [x > 0 ? p - 1 : -1, x < NX - 1 ? p + 1 : -1,
                   y > 0 ? p - NX : -1, y < NY - 1 ? p + NX : -1,
                   z > 0 ? p - NX * NY : -1, z < NZ - 1 ? p + NX * NY : -1];
      for (let k = 0; k < 6; k++) {
        const q = viz[k];
        if (q >= 0 && !rotulo[q] && vol[q] >= ISO) { rotulo[q] = id; fila[fim++] = q; }
      }
    }
    tamanhos.push(tam);
  }
  if (id <= 1) return;
  let maior = 0;
  for (let k = 1; k <= id; k++) if (tamanhos[k] > maior) maior = tamanhos[k];
  for (let s = 0; s < N; s++) {
    if (rotulo[s] && tamanhos[rotulo[s]] < maior * 0.10) vol[s] = Math.min(vol[s], ISO * 0.5);
  }
}

// A "saia" sob a base. Visto de cima (mesmo de leve), cada silhueta inclui a
// aresta de baixo da FRENTE do produto, e o cone dessa aresta segue descendo
// por trás dela: a interseção deixa uma tenda de cabeça para baixo sob a
// base, com profundidade ≈ meia-largura × tan(elevação). A 5° é pouco; com o
// celular na mão, a 25–35°, a peça ganhava 15–25% de altura que não existe.
// O produto está apoiado numa mesa plana, então a base é UM plano: o raio da
// câmera que passa pelo pixel mais baixo da silhueta toca o casco primeiro
// justamente na aresta da frente, que está na mesa. A altura desse primeiro
// toque, mediana sobre quadros e colunas, é a altura da mesa.
// Devolve { y, inclinacao } — a inclinação (tangente) com que esses raios
// descem, que é a da tenda — ou null se não deu para medir.
function alturaDaMesa(vol, quadros, cams) {
  const alturas = [], inclinacoes = [];
  const inv = new THREE.Matrix4();
  const longe = new THREE.Vector4();
  // A grade inteira cabe numa esfera em volta do centro dela, e o raio só
  // precisa andar o trecho que a atravessa. O plano de trás da câmera está a
  // 100 unidades: sem este limite, cada raio que erra o casco (pixel de
  // sombra na base) dava 20 mil passos no vazio.
  const passo = PASSO * 0.5;
  const gx = ORIGEM[0] + NX * PASSO / 2, gy = ORIGEM[1] + NY * PASSO / 2, gz = ORIGEM[2] + NZ * PASSO / 2;
  const rGrade = 0.5 * PASSO * Math.hypot(NX, NY, NZ);
  for (let i = 0; i < quadros.length; i += 2) {
    const c = caixaDaSilhueta(quadros[i].mascara);
    if (!c) continue;
    const m = quadros[i].mascara;
    const cam = cams[i].pos;
    inv.copy(cams[i].vp).invert();
    const dCentro = Math.hypot(cam.x - gx, cam.y - gy, cam.z - gz);
    const s0 = Math.floor(Math.max(0, dCentro - rGrade) / passo) * passo;
    const s1 = dCentro + rGrade;
    const larg = c.x1 - c.x0;
    for (let x = c.x0 + Math.round(larg * 0.3); x <= c.x1 - Math.round(larg * 0.3); x += 3) {
      let yb = -1;
      for (let y = c.y1; y >= c.y0; y--) if (m[y * LARG + x]) { yb = y; break; }
      if (yb < 0) continue;
      const nx = (x + 0.5) / LARG * 2 - 1, ny = 1 - (yb + 0.5) / ALT * 2;
      longe.set(nx, ny, 1, 1).applyMatrix4(inv); longe.divideScalar(longe.w);
      const dx = longe.x - cam.x, dy = longe.y - cam.y, dz = longe.z - cam.z;
      const comp = Math.hypot(dx, dy, dz);
      const ux = dx / comp, uy = dy / comp, uz = dz / comp;
      // anda da câmera para dentro até o primeiro voxel cheio
      for (let s = s0; s < s1 && s < comp; s += passo) {
        const wx = cam.x + ux * s, wy = cam.y + uy * s, wz = cam.z + uz * s;
        const vx = Math.floor((wx - ORIGEM[0]) / PASSO), vy = Math.floor((wy - ORIGEM[1]) / PASSO), vz = Math.floor((wz - ORIGEM[2]) / PASSO);
        if (vx < 0 || vy < 0 || vz < 0 || vx >= NX || vy >= NY || vz >= NZ) continue;
        if (vol[vx + NX * (vy + NY * vz)] >= ISO) {
          alturas.push(wy);
          inclinacoes.push(-uy / Math.max(1e-6, Math.hypot(ux, uz)));
          break;
        }
      }
    }
  }
  return alturas.length >= 6 ? { y: mediana(alturas), inclinacao: mediana(inclinacoes) } : null;
}

function cortarAbaixo(vol, yMesa) {
  for (let y = 0; y < NY; y++) {
    const wy = ORIGEM[1] + (y + 0.5) * PASSO;
    if (wy >= yMesa - PASSO * 0.5) continue;
    for (let z = 0; z < NZ; z++) {
      const base = NX * (y + NY * z);
      for (let x = 0; x < NX; x++) if (vol[base + x] > 0) vol[base + x] = 0;
    }
  }
}

// ============================================================
//  3. ESCULTURA — carve o volume com cada silhueta
// ============================================================

// Máscara binária → campo contínuo, com 0,5 exatamente sobre a borda.
// É isso que tira o serrilhado: testar o voxel contra um único pixel
// "sim/não" cria um moiré entre a grade de voxels e a de pixels, e o
// produto sai com costelas horizontais.
const suaveA = new Float32Array(LARG * ALT);   // campo final
const distA = new Float32Array(LARG * ALT);    // distância até o fundo
const distB = new Float32Array(LARG * ALT);    // distância até o produto

const INF = 1e9, DIAG = Math.SQRT2, RAMPA = 3; // meia-largura da transição, em px

// Distância de chamfer em duas varreduras. Semente = pixels com valor
// alvo; o resto recebe a distância aproximada até a semente mais próxima.
function chamfer(m, d, alvo) {
  for (let i = 0; i < m.length; i++) d[i] = (m[i] === alvo) ? 0 : INF;
  for (let y = 0; y < ALT; y++) {
    for (let x = 0; x < LARG; x++) {
      const i = y * LARG + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0)              v = Math.min(v, d[i - 1] + 1);
      if (y > 0)              v = Math.min(v, d[i - LARG] + 1);
      if (x > 0 && y > 0)     v = Math.min(v, d[i - LARG - 1] + DIAG);
      if (x < LARG - 1 && y > 0) v = Math.min(v, d[i - LARG + 1] + DIAG);
      d[i] = v;
    }
  }
  for (let y = ALT - 1; y >= 0; y--) {
    for (let x = LARG - 1; x >= 0; x--) {
      const i = y * LARG + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < LARG - 1)       v = Math.min(v, d[i + 1] + 1);
      if (y < ALT - 1)        v = Math.min(v, d[i + LARG] + 1);
      if (x < LARG - 1 && y < ALT - 1) v = Math.min(v, d[i + LARG + 1] + DIAG);
      if (x > 0 && y < ALT - 1)        v = Math.min(v, d[i + LARG - 1] + DIAG);
      d[i] = v;
    }
  }
}

// Máscara binária → campo contínuo com 0,5 exatamente sobre a borda.
// É isso que tira o serrilhado: testar o voxel contra um único pixel
// "sim/não" cria um moiré entre a grade de voxels e a de pixels, e o
// produto sai com costelas. Borrar a máscara não basta — a borda
// continua presa ao pixel. A distância assinada dá posição de borda
// com precisão de sub-pixel, que é o que a isosuperfície precisa.
function mascaraSuave(m) {
  chamfer(m, distA, 0);          // dentro: distância até o fundo
  chamfer(m, distB, 1);          // fora: distância até o produto
  const k = 1 / (2 * RAMPA);
  for (let i = 0; i < m.length; i++) {
    const d = distA[i] - distB[i];
    const v = 0.5 + d * k;
    suaveA[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
  }
  return suaveA;
}

function esculpir(volume, mascara, cam) {
  const suave = mascaraSuave(mascara);
  const e = cam.vp.elements;
  let vivos = 0, idx = 0;
  for (let z = 0; z < NZ; z++) {
    const wz = ORIGEM[2] + (z + 0.5) * PASSO;
    for (let y = 0; y < NY; y++) {
      const wy = ORIGEM[1] + (y + 0.5) * PASSO;
      for (let x = 0; x < NX; x++, idx++) {
        if (volume[idx] <= 0) continue;
        const wx = ORIGEM[0] + (x + 0.5) * PASSO;

        const cw = e[3] * wx + e[7] * wy + e[11] * wz + e[15];
        if (cw <= 0) { volume[idx] = 0; continue; }
        const cx = (e[0] * wx + e[4] * wy + e[8] * wz + e[12]) / cw;
        const cy = (e[1] * wx + e[5] * wy + e[9] * wz + e[13]) / cw;

        // Amostra bilinear: um voxel entre dois pixels recebe o valor
        // intermediário, e a superfície final passa suave entre eles
        const fx = (cx * 0.5 + 0.5) * LARG - 0.5;
        const fy = (0.5 - cy * 0.5) * ALT - 0.5;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        if (ix < 0 || ix >= LARG - 1 || iy < 0 || iy >= ALT - 1) { volume[idx] = 0; continue; }
        const tx = fx - ix, ty = fy - iy, p = iy * LARG + ix;
        const s =
          (suave[p]        * (1 - tx) + suave[p + 1]        * tx) * (1 - ty) +
          (suave[p + LARG] * (1 - tx) + suave[p + LARG + 1] * tx) * ty;

        if (s < volume[idx]) volume[idx] = s;
        if (volume[idx] >= ISO) vivos++;
      }
    }
  }
  return vivos;
}

// ============================================================
//  4. MALHA — surface nets (mais simples que marching cubes e já
//  entrega superfície suave, que é o que interessa aqui)
// ============================================================

const CANTOS = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
const ARESTAS = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];

function gerarMalha(vol) {
  const iv = (x, y, z) => x + NX * (y + NY * z);
  const CX = NX - 1, CY = NY - 1, CZ = NZ - 1;
  const ic = (x, y, z) => x + CX * (y + CY * z);
  const celula = new Int32Array(CX * CY * CZ).fill(-1);
  const pos = [];
  const v = new Float32Array(8);

  for (let z = 0; z < CZ; z++) {
    for (let y = 0; y < CY; y++) {
      for (let x = 0; x < CX; x++) {
        let dentro = 0;
        for (let c = 0; c < 8; c++) {
          const k = CANTOS[c];
          v[c] = vol[iv(x + k[0], y + k[1], z + k[2])];
          if (v[c] >= ISO) dentro++;
        }
        if (dentro === 0 || dentro === 8) continue;

        // O vértice vai no cruzamento interpolado de cada aresta, não no
        // meio dela — é o que transforma degrau de voxel em curva
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let a = 0; a < 12; a++) {
          const p = ARESTAS[a][0], q = ARESTAS[a][1];
          if ((v[p] >= ISO) === (v[q] >= ISO)) continue;
          let t = (ISO - v[p]) / (v[q] - v[p]);
          if (!(t >= 0 && t <= 1)) t = 0.5;
          sx += CANTOS[p][0] + (CANTOS[q][0] - CANTOS[p][0]) * t;
          sy += CANTOS[p][1] + (CANTOS[q][1] - CANTOS[p][1]) * t;
          sz += CANTOS[p][2] + (CANTOS[q][2] - CANTOS[p][2]) * t;
          n++;
        }
        celula[ic(x, y, z)] = pos.length / 3;
        pos.push(
          ORIGEM[0] + (x + sx / n) * PASSO,
          ORIGEM[1] + (y + sy / n) * PASSO,
          ORIGEM[2] + (z + sz / n) * PASSO
        );
      }
    }
  }

  const idx = [];
  function quad(a, b, c, d, inverte) {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (inverte) { idx.push(a, c, b, a, d, c); }
    else { idx.push(a, b, c, a, c, d); }
  }

  for (let z = 1; z < NZ - 1; z++) {
    for (let y = 1; y < NY - 1; y++) {
      for (let x = 1; x < NX - 1; x++) {
        const s = vol[iv(x, y, z)] >= ISO;
        // aresta em +X: as 4 células que a compartilham
        if (s !== (vol[iv(x + 1, y, z)] >= ISO) && x < CX) {
          quad(celula[ic(x, y - 1, z - 1)], celula[ic(x, y, z - 1)],
               celula[ic(x, y, z)],         celula[ic(x, y - 1, z)], !s);
        }
        if (s !== (vol[iv(x, y + 1, z)] >= ISO) && y < CY) {
          quad(celula[ic(x - 1, y, z - 1)], celula[ic(x, y, z - 1)],
               celula[ic(x, y, z)],         celula[ic(x - 1, y, z)], s);
        }
        if (s !== (vol[iv(x, y, z + 1)] >= ISO) && z < CZ) {
          quad(celula[ic(x - 1, y - 1, z)], celula[ic(x, y - 1, z)],
               celula[ic(x, y, z)],         celula[ic(x - 1, y, z)], !s);
        }
      }
    }
  }
  return { pos: new Float32Array(pos), idx: idx };
}

// Suavização laplaciana: tira o aspecto de Lego que o voxel deixa
const MAX_VIZ = 16;                 // surface nets dá 4–6 vizinhos por vértice

// Suavização de Taubin: um passo que encolhe (λ) seguido de um que
// infla (μ). Um laplaciano puro tiraria as costelas do voxel mas
// murcharia o produto junto — e aqui o tamanho é a informação que importa.
function suavizar(pos, idx, passos) {
  const n = pos.length / 3;
  const viz = new Int32Array(n * MAX_VIZ);
  const grau = new Uint8Array(n);

  for (let i = 0; i < idx.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[i + k], b = idx[i + (k + 1) % 3];
      let repetido = false;
      for (let q = 0; q < grau[a]; q++) if (viz[a * MAX_VIZ + q] === b) { repetido = true; break; }
      if (!repetido && grau[a] < MAX_VIZ) viz[a * MAX_VIZ + grau[a]++] = b;
    }
  }

  const tmp = new Float32Array(pos.length);
  const passo = function (peso) {
    for (let i = 0; i < n; i++) {
      const g = grau[i], i3 = i * 3;
      if (!g) { tmp[i3] = pos[i3]; tmp[i3+1] = pos[i3+1]; tmp[i3+2] = pos[i3+2]; continue; }
      let sx = 0, sy = 0, sz = 0;
      for (let k = 0; k < g; k++) {
        const j3 = viz[i * MAX_VIZ + k] * 3;
        sx += pos[j3]; sy += pos[j3+1]; sz += pos[j3+2];
      }
      tmp[i3]   = pos[i3]   + peso * (sx / g - pos[i3]);
      tmp[i3+1] = pos[i3+1] + peso * (sy / g - pos[i3+1]);
      tmp[i3+2] = pos[i3+2] + peso * (sz / g - pos[i3+2]);
    }
    pos.set(tmp);
  };

  // λ/μ clássicos de Taubin: encolhe e devolve, sem passa-banda instável
  for (let p = 0; p < passos; p++) { passo(0.50); passo(-0.53); }
}

// ============================================================
//  5. COR POR VÉRTICE — projeta cada vértice nos quadros em que
//  ele aparece de frente e mistura as cores
// ============================================================

function pintar(pos, normais, quadros, cams) {
  const n = pos.length / 3;
  const cor = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const wx = pos[i*3], wy = pos[i*3+1], wz = pos[i*3+2];
    const nx = normais[i*3], ny = normais[i*3+1], nz = normais[i*3+2];
    let r = 0, g = 0, b = 0, peso = 0;

    for (let c = 0; c < cams.length; c++) {
      const cam = cams[c];
      let dx = cam.pos.x - wx, dy = cam.pos.y - wy, dz = cam.pos.z - wz;
      const inv = 1 / Math.hypot(dx, dy, dz);
      dx *= inv; dy *= inv; dz *= inv;
      const face = nx * dx + ny * dy + nz * dz;
      if (face <= 0.2) continue;                 // vértice de costas para essa câmera

      const e = cam.vp.elements;
      const cw = e[3]*wx + e[7]*wy + e[11]*wz + e[15];
      if (cw <= 0) continue;
      const px = (((e[0]*wx + e[4]*wy + e[8]*wz + e[12]) / cw) * 0.5 + 0.5) * LARG | 0;
      const py = ((0.5 - ((e[1]*wx + e[5]*wy + e[9]*wz + e[13]) / cw) * 0.5)) * ALT | 0;
      if (px < 4 || px >= LARG - 4 || py < 4 || py >= ALT - 4) continue;
      const q = quadros[c];
      // Só vale cor tirada de DENTRO da silhueta, longe da borda: a cor vem
      // do quadro em meia resolução, e na borda ela já mistura o fundo — era
      // daí que a peça saía com a cor da mesa nas laterais.
      const im = py * LARG + px;
      if (!q.mascara[im] || !q.mascara[im - 3] || !q.mascara[im + 3] ||
          !q.mascara[im - 3 * LARG] || !q.mascara[im + 3 * LARG]) continue;

      // a cor vem do quadro reduzido, então reescala o pixel
      const jx = (px * LARG_C / LARG) | 0, jy = (py * ALT_C / ALT) | 0;
      const j = (jy * LARG_C + jx) * 4;
      const w = face * face;
      r += q.cores[j] * w; g += q.cores[j+1] * w; b += q.cores[j+2] * w;
      peso += w;
    }

    if (peso > 0) {
      // sRGB → linear, que é o espaço que o glTF espera em COLOR_0
      cor[i*3]   = Math.pow(r / peso / 255, 2.2);
      cor[i*3+1] = Math.pow(g / peso / 255, 2.2);
      cor[i*3+2] = Math.pow(b / peso / 255, 2.2);
    } else {
      cor[i*3] = -1;                                // ninguém viu: preencher pelos vizinhos
    }
  }
  return cor;
}

// Vértice que nenhuma câmera viu de frente (embaixo da base, fundo de
// reentrância) herda a cor média dos vizinhos que foram vistos, em vez do
// cinza fixo que manchava a peça.
function preencherCores(cor, idx) {
  const n = cor.length / 3;
  let faltam = 0;
  for (let i = 0; i < n; i++) if (cor[i * 3] < 0) faltam++;
  if (!faltam) return;
  const viz = [];
  for (let i = 0; i < n; i++) viz.push([]);
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k], b = idx[k + 1], c = idx[k + 2];
    viz[a].push(b, c); viz[b].push(a, c); viz[c].push(a, b);
  }
  for (let volta = 0; volta < 60 && faltam; volta++) {
    const novos = [];
    for (let i = 0; i < n; i++) {
      if (cor[i * 3] >= 0) continue;
      let r = 0, g = 0, b = 0, k = 0;
      for (const j of viz[i]) if (cor[j * 3] >= 0) { r += cor[j * 3]; g += cor[j * 3 + 1]; b += cor[j * 3 + 2]; k++; }
      if (k) novos.push(i, r / k, g / k, b / k);
    }
    if (!novos.length) break;
    for (let q = 0; q < novos.length; q += 4) {
      const i = novos[q];
      cor[i * 3] = novos[q + 1]; cor[i * 3 + 1] = novos[q + 2]; cor[i * 3 + 2] = novos[q + 3];
      faltam--;
    }
  }
  for (let i = 0; i < n; i++) if (cor[i * 3] < 0) { cor[i * 3] = cor[i * 3 + 1] = cor[i * 3 + 2] = 0.45; }
}

// ============================================================
//  6. ORIENTAÇÃO E TAMANHO DA PEÇA
// ============================================================

// Retângulo de menor área que contém a planta baixa (pinças giratórias sobre
// o casco convexo). O giro do primeiro quadro é arbitrário — o lojista pôs o
// produto de qualquer jeito no começo —, então uma caixa saía torta, com a
// planta 30° fora dos eixos e a caixa delimitadora (de onde vêm as medidas)
// inflada à toa. Devolve o ângulo que alinha o retângulo aos eixos.
function alinhamentoDaPlanta(pos) {
  const pts = [];
  for (let i = 0; i < pos.length; i += 3) pts.push([pos[i], pos[i + 2]]);
  pts.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
  const cruz = function (o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); };
  const baixo = [], cima = [];
  for (const p of pts) {
    while (baixo.length >= 2 && cruz(baixo[baixo.length - 2], baixo[baixo.length - 1], p) <= 0) baixo.pop();
    baixo.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (cima.length >= 2 && cruz(cima[cima.length - 2], cima[cima.length - 1], p) <= 0) cima.pop();
    cima.push(p);
  }
  const casco = baixo.slice(0, -1).concat(cima.slice(0, -1));
  const areaEm = function (ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of casco) {
      const x = p[0] * c + p[1] * s, z = -p[0] * s + p[1] * c;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    return (x1 - x0) * (z1 - z0);
  };
  let melhor = 0, melhorA = areaEm(0);
  const area0 = melhorA;
  for (let i = 0; i < casco.length; i++) {
    const a = casco[i], b = casco[(i + 1) % casco.length];
    let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    // o menor giro que leva essa aresta a um dos eixos: entre −45° e 45°
    ang = ang - Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
    const ar = areaEm(ang);
    if (ar < melhorA) { melhorA = ar; melhor = ang; }
  }
  // Planta redonda (garrafa, pote) não tem lado certo: girar só tiraria o
  // rótulo de frente. Só alinha quando o ganho é claro.
  return melhorA < area0 * 0.92 ? melhor : 0;
}

// Escala UNIFORME a partir das medidas do cadastro. As medidas do formulário
// são da EMBALAGEM, e o escaneamento não sabe qual lado do produto foi parar
// em qual eixo. Esticar eixo por eixo até elas (o que se fazia antes) mudava
// a FORMA: o borrifador do Enzo (3×7×5) ficou 4× mais largo do que alto.
// Aqui a peça só cresce ou encolhe por igual, até o maior tamanho que ainda
// cabe na embalagem em alguma posição — medidas ordenadas contra medidas
// ordenadas. Se a embalagem é do tamanho do produto, sai exato; se é maior,
// sai um teto, e o lojista confirma a altura na tela de resultado.
function escalaPelaEmbalagem(tam, produto) {
  const emb = [Number(produto.largura), Number(produto.altura), Number(produto.comprimento)];
  if (!emb.every(function (v) { return Number.isFinite(v) && v > 0; })) return null;
  const e = emb.map(function (v) { return v / 100; }).sort(function (a, b) { return b - a; });
  const m = [tam.x, tam.y, tam.z].sort(function (a, b) { return b - a; });
  if (!(m[2] > 0)) return null;
  const razoes = [e[0] / m[0], e[1] / m[1], e[2] / m[2]];
  const menor = Math.min(razoes[0], razoes[1], razoes[2]);
  // Embalagem com proporção bem diferente da peça: as medidas são de uma caixa
  // maior (ou foram digitadas trocadas), e o tamanho que sai é só um teto — o
  // maior que cabe nela. Com a proporção batendo, as medidas são do próprio
  // produto, e a média (geométrica) das três razões divide o erro do casco
  // entre os eixos em vez de encolher a peça inteira pelo eixo que o casco
  // mais engordou.
  const folga = Math.max(razoes[0], razoes[1], razoes[2]) / menor;
  const confiavel = folga < 1.3;
  const s = confiavel ? Math.cbrt(razoes[0] * razoes[1] * razoes[2]) : menor;
  return { escala: s, confiavel: confiavel };
}

// ============================================================
//  7. RECONSTRUÇÃO COMPLETA, SEM INTERFACE
//  O scanner roda isto depois da volta (um quadro por vez, para a
//  barra de progresso andar) e os testes rodam de uma vez só.
//    quadros: [{ mascara, cores, t (ms), orient: {e, r} | null }]
//    produto: { largura, altura, comprimento } em cm (embalagem)
//    op: { fov (rad) }
// ============================================================

function Reconstrucao(quadros, produto, op) {
  op = op || {};
  this.produto = produto || {};
  FOV = op.fov || FOV_PADRAO;
  const n = quadros.length;

  const caixas = quadros.map(function (q) { return caixaDaSilhueta(q.mascara); });
  const ok = quadrosConfiaveis(caixas);

  const todas = posesDosQuadros(quadros, op.fatorVolta || 1);
  const sentido = op.sentido != null ? op.sentido : sentidoDoGiro(quadros);
  if (sentido < 0) todas.forEach(function (p) { p.t = -p.t; });
  const orient = orientacoesDosQuadros(quadros);
  if (orient) todas.forEach(function (p, i) { p.e = orient[i].e; p.r = orient[i].r; });

  this.usados = quadros.filter(function (_, i) { return ok[i]; });
  const poses = todas.filter(function (_, i) { return ok[i]; });
  const eixo0 = op.eixoPx != null ? op.eixoPx : eixoDaImagem(quadros, caixas, ok);
  ajustarVolume(this.usados, poses, eixo0);
  let eixoPx = eixo0;
  const fator = op.fatorVolta || 1;
  if (op.calibrar !== false) {
    eixoPx = autocalibrar(this.usados, poses, eixo0).eixoPx;
    ajustarVolume(this.usados, poses, eixoPx);
  }
  this.poses = poses;
  this.cams = montarCameras(this.poses, { eixoPx: eixoPx });
  this.volume = new Float32Array(NX * NY * NZ).fill(1);
  this.i = 0;
  const graus = function (r) { return Math.round(r * 1800 / Math.PI) / 10; };
  this.meta = {
    quadros: n, usados: this.usados.length, descartados: n - this.usados.length,
    eixoPx: Math.round(eixoPx * 10) / 10, eixoDireto: Math.round(eixo0 * 10) / 10,
    sentido: sentido, sensor: !!orient,
    voltaGraus: Math.round(360 * fator * (n - 1) / n),     // quanto girou do 1º ao último quadro
    elevacao: graus(mediana(this.poses.map(function (p) { return p.e; }))),
    rolagem: graus(mediana(this.poses.map(function (p) { return p.r || 0; }))),
    fov: graus(FOV)
  };
}

Reconstrucao.prototype.total = function () { return this.usados.length; };

// Esculpe com o próximo quadro. Devolve false quando acabou.
Reconstrucao.prototype.esculpirProximo = function () {
  if (this.i >= this.usados.length) return false;
  this.vivos = esculpir(this.volume, this.usados[this.i].mascara, this.cams[this.i]);
  this.i++;
  return this.i < this.usados.length;
};

// Malha final em METROS, base em y = 0, centrada, já na escala.
// Devolve null se não sobrou volume.
Reconstrucao.prototype.finalizar = function () {
  const vol = this.volume;
  // chão: corta a saia, se a medida for plausível
  let yMin = Infinity, yMax = -Infinity, raio = 0;
  for (let z = 0; z < NZ; z++) {
    const wz = ORIGEM[2] + (z + 0.5) * PASSO;
    for (let y = 0; y < NY; y++) {
      const base = NX * (y + NY * z);
      for (let x = 0; x < NX; x++) {
        if (vol[base + x] < ISO) continue;
        const wy = ORIGEM[1] + (y + 0.5) * PASSO, wx = ORIGEM[0] + (x + 0.5) * PASSO;
        if (wy < yMin) yMin = wy;
        if (wy > yMax) yMax = wy;
        const rr = Math.max(Math.abs(wx), Math.abs(wz));
        if (rr > raio) raio = rr;
      }
    }
  }
  if (!(yMax > yMin)) return null;
  const mesa = alturaDaMesa(vol, this.usados, this.cams);
  // A saia teórica é a tenda sob a planta, com a inclinação dos raios que
  // passam pela base da silhueta: com folga de 50%, é o máximo que se aceita
  // cortar — medida maior que isso é engano da medida, não saia.
  // Essa inclinação NÃO é a elevação da câmera. A base fica abaixo do centro
  // do quadro, e o raio até ela desce bem mais (câmera a 5° → raio a 15–20°).
  // Pelo teto calculado com a elevação, a saia de verdade era três vezes
  // maior do que o permitido e o corte era recusado justamente em produto
  // baixo e largo: um pote saía até 24% mais alto.
  if (mesa) {
    const saiaMax = raio * Math.max(mesa.inclinacao, Math.tan(3 * Math.PI / 180)) * 1.5 + 2 * PASSO;
    const corte = mesa.y - yMin;
    if (corte > 0 && corte <= saiaMax && corte < (yMax - yMin) * 0.6) {
      cortarAbaixo(vol, mesa.y);
      this.meta.saiaCortada = Math.round(corte / (yMax - yMin) * 1000) / 10;   // % da altura
    }
  }
  limparVolume(vol);

  const bruta = gerarMalha(vol);
  if (bruta.idx.length < 12) return null;
  suavizar(bruta.pos, bruta.idx, 3);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(bruta.pos, 3));
  geo.setIndex(bruta.idx);
  geo.computeVertexNormals();
  const cor = pintar(bruta.pos, geo.attributes.normal.array, this.usados, this.cams);
  preencherCores(cor, bruta.idx);
  geo.setAttribute('color', new THREE.BufferAttribute(cor, 3));

  // planta alinhada aos eixos, base em y = 0, centro em x/z
  const giro = alinhamentoDaPlanta(bruta.pos);
  if (giro) geo.rotateY(giro);
  geo.computeBoundingBox();
  let bb = geo.boundingBox;
  const ctr = bb.getCenter(new THREE.Vector3());
  geo.translate(-ctr.x, -bb.min.y, -ctr.z);
  const tam = bb.getSize(new THREE.Vector3());

  // tamanho: uniforme, pela embalagem; sem medidas, 20 cm de altura
  const ajuste = escalaPelaEmbalagem(tam, this.produto);
  const s = ajuste ? ajuste.escala : 0.20 / tam.y;
  geo.scale(s, s, s);
  geo.computeBoundingBox();
  geo.computeVertexNormals();
  bb = geo.boundingBox;
  const cm = function (v) { return Math.round(v * 1000) / 10; };
  this.meta.giroPlanta = Math.round(giro * 1800 / Math.PI) / 10;
  return {
    geometria: geo,
    dims: { largura: cm(bb.max.x - bb.min.x), altura: cm(bb.max.y - bb.min.y), profundidade: cm(bb.max.z - bb.min.z) },
    medidasConfiaveis: !!(ajuste && ajuste.confiavel),
    semMedidas: !ajuste,
    vertices: bruta.pos.length / 3, triangulos: bruta.idx.length / 3,
    meta: this.meta
  };
};

// ============================================================
//  CSS
// ============================================================

const CSS = `
.sc-back{position:fixed;inset:0;z-index:1300;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.8);backdrop-filter:blur(8px);padding:1.2rem}
.sc-modal{display:flex;flex-direction:column;width:min(560px,100%);height:min(820px,100%);
  background:var(--card,#161616);color:var(--text,#f0ece3);border:1px solid var(--border,#2a2a2a);
  border-radius:18px;overflow:hidden;font-family:var(--font-texto,'Inter',system-ui,sans-serif);box-shadow:0 24px 70px rgba(0,0,0,.5)}
.sc-head{display:flex;align-items:center;gap:.8rem;padding:.9rem 1.2rem;border-bottom:1px solid var(--border,#2a2a2a);flex-shrink:0}
.sc-head h3{font-size:.98rem;font-weight:600;margin:0}
.sc-head p{font-size:.74rem;color:var(--muted,#888);margin:.12rem 0 0}
.sc-x{margin-left:auto;width:34px;height:34px;border-radius:9px;border:1px solid var(--border,#2a2a2a);
  background:transparent;color:var(--text,#f0ece3);cursor:pointer;font-size:1.05rem;flex-shrink:0}
.sc-x:hover{border-color:var(--accent,#e8854a);color:var(--accent,#e8854a)}

.sc-palco{position:relative;flex:1;min-height:0;background:#000;overflow:hidden;
  display:flex;align-items:center;justify-content:center}
.sc-quadro{position:relative;height:100%;aspect-ratio:3/4;max-width:100%;overflow:hidden;background:#000}
.sc-quadro video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}
.sc-quadro canvas.sc-mask{position:absolute;inset:0;width:100%;height:100%;z-index:1;opacity:.55;pointer-events:none}
.sc-quadro canvas.sc-3d{position:absolute;inset:0;width:100%;height:100%;z-index:1;touch-action:none}
.sc-moldura{position:absolute;z-index:2;border:2px dashed rgba(255,255,255,.75);border-radius:10px;
  pointer-events:none;box-shadow:0 0 0 2000px rgba(0,0,0,.28)}
.sc-anel{position:absolute;z-index:5;left:50%;bottom:1.1rem;transform:translateX(-50%);
  filter:drop-shadow(0 3px 12px rgba(0,0,0,.6))}

.sc-aviso{position:absolute;z-index:4;left:50%;top:.9rem;transform:translateX(-50%);max-width:90%;
  background:rgba(0,0,0,.74);color:#fff;font-size:.95rem;font-weight:600;line-height:1.35;
  padding:.6rem 1.1rem;border-radius:14px;text-align:center;transition:background-color .25s}
.sc-aviso.ruim{background:rgba(184,58,48,.92)}
.sc-aviso.ajuste{background:rgba(190,130,40,.92)}
.sc-aviso.bom{background:rgba(46,132,96,.94)}

/* Lista de condições, igual às checagens de um leitor de rosto */
.sc-checks{position:absolute;z-index:4;left:.9rem;bottom:.9rem;display:flex;flex-direction:column;gap:.28rem}
.sc-check{display:flex;align-items:center;gap:.45rem;font-size:.72rem;color:rgba(255,255,255,.62);
  background:rgba(0,0,0,.5);padding:.22rem .6rem .22rem .38rem;border-radius:50px;transition:color .2s}
.sc-check i{width:14px;height:14px;border-radius:50%;border:1.5px solid currentColor;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;font-style:normal;font-size:.6rem;line-height:1}
.sc-check.ok{color:#6ede9f}
.sc-check.ok i{background:#6ede9f;border-color:#6ede9f;color:#0d2b1c}

/* A moldura responde ao estado, como o oval do reconhecimento facial */
.sc-moldura.ruim{border-color:rgba(230,110,100,.95)}
.sc-moldura.ajuste{border-color:rgba(240,180,80,.95)}
.sc-moldura.bom{border-color:rgba(110,222,159,.98);border-style:solid}

/* Contagem regressiva antes de começar sozinho */
.sc-conta{position:absolute;z-index:6;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:5rem;font-weight:700;color:#fff;text-shadow:0 3px 20px rgba(0,0,0,.7);pointer-events:none}

.sc-msg{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:.8rem;text-align:center;padding:2rem;color:var(--muted,#888);font-size:.88rem;background:rgba(10,10,10,.9)}
.sc-msg b{color:var(--text,#f0ece3);display:block;margin-bottom:.2rem}
.sc-spin{width:34px;height:34px;border-radius:50%;border:3px solid var(--border,#2a2a2a);
  border-top-color:var(--accent,#e8854a);animation:scSpin .8s linear infinite}
@keyframes scSpin{to{transform:rotate(360deg)}}
.sc-barra{width:min(280px,80%);height:6px;border-radius:6px;background:var(--border,#2a2a2a);overflow:hidden}
.sc-barra i{display:block;height:100%;width:0;background:var(--accent,#e8854a);transition:width .2s}

.sc-passos{padding:1rem 1.2rem;font-size:.82rem;color:var(--muted,#888);line-height:1.65;overflow-y:auto}
.sc-passos ol{margin:.5rem 0 0;padding-left:1.15rem}
.sc-passos li{margin-bottom:.35rem}
.sc-passos b{color:var(--text,#f0ece3)}
.sc-tam{display:flex;flex-direction:column;gap:.5rem}
.sc-tam-linha{color:var(--text,#f0ece3)}
.sc-tam-alt{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.sc-tam-alt input{width:6.5rem;min-height:40px;padding:.4rem .6rem;border-radius:8px;border:1px solid var(--border,#2a2a2a);
  background:var(--card2,#1e1e1e);color:var(--text,#f0ece3);font:inherit;font-size:16px}
.sc-tam-alt input:focus-visible{outline:2px solid var(--accent,#e8854a);outline-offset:1px}
.sc-tam-alt input[aria-invalid="true"]{border-color:#e5484d}
.sc-tam-nota{margin:0;font-size:.78rem;line-height:1.5}
.sc-tam-nota.atencao{color:var(--accent2,#f4c56a)}

.sc-pe{display:flex;align-items:center;gap:.7rem;padding:.8rem 1.2rem;border-top:1px solid var(--border,#2a2a2a);flex-shrink:0}
.sc-dica{font-size:.75rem;color:var(--muted,#888);flex:1;line-height:1.4}
.sc-btn{padding:.55rem 1.1rem;border-radius:8px;border:1px solid var(--border,#2a2a2a);background:transparent;
  color:var(--text,#f0ece3);font:inherit;font-size:.84rem;font-weight:600;cursor:pointer;white-space:nowrap}
.sc-btn:hover:not(:disabled){border-color:var(--accent,#e8854a);color:var(--accent,#e8854a)}
.sc-btn.pri{background:var(--accent,#e8854a);border-color:var(--accent,#e8854a);color:#fff}
.sc-btn.pri:hover:not(:disabled){background:var(--accent-hover,#d9733c);color:#fff}
.sc-btn:disabled{opacity:.4;cursor:not-allowed}

@media(max-width:640px){
  .sc-back{padding:0}
  .sc-modal{width:100%;height:100%;border-radius:0;border:none}
}
`;

function injetarCSS() {
  if (document.getElementById('sc-css')) return;
  const st = document.createElement('style');
  st.id = 'sc-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

// ============================================================
//  O SCANNER
// ============================================================

let ativo = null;

function Scanner(opcoes) {
  this.produto = opcoes.produto || {};
  this.aoConcluir = opcoes.aoConcluir || function () {};
  this.quadros = [];
  this.destruido = false;
  this.stream = null;
  this.capturando = false;
  this._montarUI();
}

Scanner.prototype._montarUI = function () {
  const self = this;
  const back = el('div', 'sc-back');
  back.setAttribute('role', 'dialog');
  back.setAttribute('aria-modal', 'true');
  back.setAttribute('aria-label', 'Escanear produto em 3D');

  const modal = el('div', 'sc-modal');
  back.appendChild(modal);

  const head = el('div', 'sc-head');
  const t = el('div');
  const h3 = el('h3', null, 'Escanear em 3D');
  t.appendChild(h3);
  t.appendChild(el('p', null, this.produto.nome || 'Novo produto'));
  head.appendChild(t);
  const x = el('button', 'sc-x', '✕');
  x.setAttribute('aria-label', 'Fechar');
  x.onclick = function () { self.fechar(); };
  head.appendChild(x);
  modal.appendChild(head);

  const palco = el('div', 'sc-palco');
  const quadro = el('div', 'sc-quadro');
  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.muted = true; video.autoplay = true;
  quadro.appendChild(video);

  const mask = document.createElement('canvas');
  mask.className = 'sc-mask';
  mask.width = LARG; mask.height = ALT;
  quadro.appendChild(mask);

  const moldura = el('div', 'sc-moldura');
  moldura.style.left = (100 * ROI.x0 / LARG) + '%';
  moldura.style.top = (100 * ROI.y0 / ALT) + '%';
  moldura.style.width = (100 * (ROI.x1 - ROI.x0) / LARG) + '%';
  moldura.style.height = (100 * (ROI.y1 - ROI.y0) / ALT) + '%';
  quadro.appendChild(moldura);

  const aviso = el('div', 'sc-aviso');
  quadro.appendChild(aviso);

  // Lista de condições que o lojista vê marcar sozinha
  const checks = el('div', 'sc-checks');
  quadro.appendChild(checks);

  const conta = el('div', 'sc-conta');
  conta.style.display = 'none';
  quadro.appendChild(conta);

  const anel = document.createElement('canvas');
  anel.className = 'sc-anel';
  anel.width = anel.height = 116;
  anel.style.display = 'none';
  quadro.appendChild(anel);

  palco.appendChild(quadro);
  const msg = el('div', 'sc-msg');
  palco.appendChild(msg);
  modal.appendChild(palco);

  const passos = el('div', 'sc-passos');
  modal.appendChild(passos);

  const pe = el('div', 'sc-pe');
  const dica = el('div', 'sc-dica');
  const btnSec = el('button', 'sc-btn', 'Cancelar');
  const btnPri = el('button', 'sc-btn pri', 'Ligar câmera');
  pe.appendChild(dica); pe.appendChild(btnSec); pe.appendChild(btnPri);
  modal.appendChild(pe);

  this.dom = { back: back, modal: modal, palco: palco, quadro: quadro, video: video,
               mask: mask, moldura: moldura, aviso: aviso, anel: anel, msg: msg,
               checks: checks, conta: conta,
               passos: passos, dica: dica, btnSec: btnSec, btnPri: btnPri };

  // Canvas de processamento, fora da tela
  this.proc = document.createElement('canvas');
  this.proc.width = LARG; this.proc.height = ALT;
  this.ctxProc = this.proc.getContext('2d', { willReadFrequently: true });
  this.procCor = document.createElement('canvas');
  this.procCor.width = LARG_C; this.procCor.height = ALT_C;
  this.ctxCor = this.procCor.getContext('2d', { willReadFrequently: true });
  this.ctxMask = mask.getContext('2d');

  this._onKey = function (e) { if (e.key === 'Escape') self.fechar(); };
  document.addEventListener('keydown', this._onKey);

  document.body.appendChild(back);
  this._faseIntro();
};

// ---------- fase 1: instruções ----------
Scanner.prototype._faseIntro = function () {
  const self = this;
  const d = this.dom;
  d.msg.style.display = 'none';
  d.mask.style.display = 'none';
  d.moldura.style.display = 'none';
  d.aviso.style.display = 'none';
  d.palco.style.flex = '0 0 auto';
  d.quadro.style.display = 'none';

  d.passos.innerHTML =
    '<b>Para o escaneamento dar certo:</b>' +
    '<ol>' +
    '<li>Apoie o produto <b>sozinho</b> sobre uma superfície lisa, com <b>fundo de cor bem diferente</b> da dele (uma folha de papel, uma toalha lisa). Tire de perto o que não for o produto.</li>' +
    '<li>Luz uniforme, <b>sem sombra forte</b> e sem contraluz.</li>' +
    '<li>Deixe o produto <b>inteiro dentro da moldura, com uma folga em volta</b>, e apoie o celular <b>na altura do produto</b>, olhando de frente e não de cima — quem gira é o produto, não a câmera.</li>' +
    '<li>Gire devagar <b>uma volta completa</b> enquanto o anel se preenche.</li>' +
    '</ol>' +
    '<p style="margin-top:.7rem">Funciona bem em produto “cheio” (caixa, garrafa, tênis, panela). ' +
    'Objeto vazado, muito fino, transparente ou espelhado não sai bem — nesses casos use a foto normal.</p>';

  d.dica.textContent = 'A câmera só é usada no seu aparelho; os quadros não saem daqui.';
  d.btnSec.textContent = 'Cancelar';
  d.btnSec.onclick = function () { self.fechar(); };
  d.btnPri.textContent = 'Ligar câmera';
  d.btnPri.disabled = false;
  d.btnPri.onclick = function () { self._faseMira(); };
};

// ---------- fase 2: mira, com máscara ao vivo ----------
Scanner.prototype._faseMira = async function () {
  const self = this;
  const d = this.dom;

  d.palco.style.flex = '1';
  d.quadro.style.display = '';
  d.passos.innerHTML = '';
  d.msg.style.display = '';
  d.msg.innerHTML = '';
  d.msg.appendChild(el('div', 'sc-spin'));
  d.msg.appendChild(el('div', null, 'Ligando a câmera…'));
  d.btnPri.disabled = true;

  // Giroscópio: é dele que sai a inclinação real do celular em cada quadro.
  // No iPhone a permissão precisa ser pedida AINDA no toque do botão, antes
  // de qualquer await; no Android e no computador basta ouvir o evento.
  this._ligarOrientacao();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return this._erro('Câmera indisponível.', 'Este navegador não dá acesso à câmera.');
  }
  try {
    await carregarLib();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false
    });
  } catch (e) {
    return this._erro('Não consegui abrir a câmera.',
      'Autorize a câmera no navegador. O site precisa estar em HTTPS (ou localhost).');
  }
  if (this.destruido) { this._pararCamera(); return; }

  d.video.srcObject = this.stream;
  const p = d.video.play();
  if (p && p.catch) p.catch(function () {});

  d.msg.style.display = 'none';
  d.mask.style.display = '';
  d.moldura.style.display = '';
  d.aviso.style.display = '';
  d.checks.style.display = '';
  d.dica.textContent = 'A área destacada é o que o site enxerga como produto.';
  d.btnSec.textContent = 'Voltar';
  d.btnSec.onclick = function () { self._pararCamera(); self._faseIntro(); };
  d.btnPri.textContent = 'Iniciar captura';
  d.btnPri.onclick = function () { self._faseCaptura(); };

  this._loopMira();
};

Scanner.prototype._ligarOrientacao = function () {
  const self = this;
  if (this._onOrient) return;
  this._orient = null;
  this._onOrient = function (ev) {
    if (ev.beta == null || ev.gamma == null) return;
    self._orient = { beta: ev.beta, gamma: ev.gamma };
  };
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().catch(function () {});
    }
  } catch (e) {}
  window.addEventListener('deviceorientation', this._onOrient);
};

Scanner.prototype._desligarOrientacao = function () {
  if (this._onOrient) window.removeEventListener('deviceorientation', this._onOrient);
  this._onOrient = null;
};

// { e, r } da câmera agora, ou null sem giroscópio
Scanner.prototype._lerOrientacao = function () {
  const o = this._orient;
  if (!o) return null;
  let ang = 0;
  if (screen.orientation && Number.isFinite(screen.orientation.angle)) ang = screen.orientation.angle;
  else if (Number.isFinite(window.orientation)) ang = window.orientation;
  return orientacaoDaCamera(o.beta, o.gamma, ang);
};

// Desenha a máscara em tempo real e diz se a cena está boa
Scanner.prototype._loopMira = function () {
  const self = this;
  const d = this.dom;

  // Só começa sozinho depois de a cena ficar boa por um tempo seguido.
  // Sem essa espera, um acerto de meio segundo já dispararia a captura.
  const ESTAVEL_MS = 1200;
  let bomDesde = 0, contando = false;

  d.checks.innerHTML = '';
  const linhas = {};

  let ultimo = 0;
  const tick = function (agora) {
    if (self.destruido || self.capturando) return;
    if (agora - ultimo < 120) { self._raf = requestAnimationFrame(tick); return; }
    ultimo = agora;

    const px = self._quadroAtual();
    if (px) {
      const r = segmentar(px.data);
      self._desenharMascara(r.mascara);
      const cena = avaliarCena(r);

      // ---- lista de condições ----
      cena.itens.forEach(function (item) {
        let li = linhas[item.chave];
        if (!li) {
          li = el('div', 'sc-check');
          li.appendChild(el('i', null, '✓'));
          li.appendChild(el('span', null, item.rotulo));
          d.checks.appendChild(li);
          linhas[item.chave] = li;
        }
        li.className = 'sc-check' + (item.ok ? ' ok' : '');
      });

      // ---- instrução da vez ----
      // Celular muito acima do produto não impede (a inclinação é medida e
      // entra na conta), mas a peça sai mais fiel com a câmera na altura dele:
      // de cima, o topo e a base viram uma "tenda" que o casco não desfaz.
      const o = self._lerOrientacao();
      const alto = o && o.e > 32 * Math.PI / 180;
      const classe = cena.pronto ? 'bom' : (cena.grave ? 'ruim' : 'ajuste');
      d.aviso.textContent = cena.pronto
        ? (alto ? 'Pronto — se der, abaixe o celular até a altura do produto' : 'Pronto — segure assim')
        : (cena.instrucao || 'Ajuste o enquadramento');
      d.aviso.className = 'sc-aviso ' + classe;
      d.moldura.className = 'sc-moldura ' + classe;
      d.btnPri.disabled = !cena.pronto;

      // ---- começa sozinho, como o leitor de rosto ----
      if (cena.pronto) {
        if (!bomDesde) bomDesde = agora;
        const falta = ESTAVEL_MS - (agora - bomDesde);
        if (falta <= 0) {
          d.conta.style.display = 'none';
          self._faseCaptura();
          return;
        }
        contando = true;
        d.conta.style.display = '';
        d.conta.textContent = Math.ceil(falta / 400);
      } else {
        bomDesde = 0;
        if (contando) { contando = false; d.conta.style.display = 'none'; }
      }
    }
    self._raf = requestAnimationFrame(tick);
  };
  tick(0);
};

// Recorta o vídeo em 3:4 pelo centro — exatamente o que o
// object-fit:cover faz na tela, então a moldura bate com o processamento
Scanner.prototype._quadroAtual = function (comCor) {
  const v = this.dom.video;
  if (!v.videoWidth || !v.videoHeight) return null;
  const alvo = LARG / ALT;
  const asp = v.videoWidth / v.videoHeight;
  let sw, sh, sx, sy;
  if (asp > alvo) { sh = v.videoHeight; sw = sh * alvo; sx = (v.videoWidth - sw) / 2; sy = 0; }
  else { sw = v.videoWidth; sh = sw / alvo; sx = 0; sy = (v.videoHeight - sh) / 2; }
  this.ctxProc.drawImage(v, sx, sy, sw, sh, 0, 0, LARG, ALT);
  if (comCor) {
    this.ctxCor.drawImage(v, sx, sy, sw, sh, 0, 0, LARG_C, ALT_C);
    this._ultimaCor = this.ctxCor.getImageData(0, 0, LARG_C, ALT_C);
  }
  return this.ctxProc.getImageData(0, 0, LARG, ALT);
};

Scanner.prototype._desenharMascara = function (m) {
  const img = this.ctxMask.createImageData(LARG, ALT);
  const d = img.data;
  for (let i = 0; i < m.length; i++) {
    const j = i * 4;
    if (m[i]) { d[j] = 232; d[j+1] = 133; d[j+2] = 74; d[j+3] = 150; }
    else { d[j+3] = 0; }
  }
  this.ctxMask.putImageData(img, 0, 0);
};

// ---------- fase 3: captura da volta ----------
Scanner.prototype._faseCaptura = function () {
  const self = this;
  const d = this.dom;
  this.capturando = true;
  this.quadros = [];
  if (this._raf) cancelAnimationFrame(this._raf);

  d.anel.style.display = '';
  d.conta.style.display = 'none';
  d.checks.style.display = 'none';
  d.moldura.className = 'sc-moldura bom';
  d.dica.textContent = 'Gire o produto devagar, sempre no mesmo sentido.';
  d.btnSec.textContent = 'Cancelar';
  d.btnSec.onclick = function () { self._pararCaptura(); self._faseMira(); };
  d.btnPri.textContent = 'Concluir volta';
  d.btnPri.disabled = true;
  d.btnPri.onclick = function () { self._pararCaptura(); self._faseProcessar(); };

  let anterior = null, corAnterior = null;

  const capturar = function () {
    if (self.destruido || !self.capturando) return;
    const px = self._quadroAtual(true);
    let movimento = null, cortado = false;

    if (px) {
      const r = segmentar(px.data);
      // Silhueta cortada pela moldura não entra na conta. O casco é a
      // INTERSEÇÃO de todas as silhuetas: um único quadro cortado tira
      // material de verdade do modelo, e nenhum quadro seguinte devolve.
      cortado = r.area > 0 && r.encosta > FOLGA_BORDA;
      if (cortado) self._desenharMascara(r.mascara);
      if (r.area > 0 && !cortado) {
        const cor = self._ultimaCor.data;

        // Quanto mudou desde o quadro anterior. Duas medidas, porque
        // nenhuma sozinha serve: a silhueta pega caixa girando mas é
        // cega para garrafa e lata (sólido de revolução tem a mesma
        // silhueta em todo ângulo), e a cor pega o rótulo girando mas
        // é cega para peça lisa. Vale a maior das duas.
        if (anterior && corAnterior) {
          let difForma = 0;
          for (let i = 0; i < r.mascara.length; i++) if (r.mascara[i] !== anterior[i]) difForma++;
          difForma = difForma / Math.max(1, r.area);

          let somaCor = 0, nc = 0;
          for (let i = 0; i < cor.length; i += 16) {
            somaCor += Math.abs(cor[i] - corAnterior[i]) +
                       Math.abs(cor[i + 1] - corAnterior[i + 1]) +
                       Math.abs(cor[i + 2] - corAnterior[i + 2]);
            nc++;
          }
          const difCor = nc ? (somaCor / nc) / 60 : 0;

          movimento = Math.max(difForma, difCor);
        }
        anterior = new Uint8Array(r.mascara);
        corAnterior = new Uint8ClampedArray(cor);

        const v = self.dom.video;
        self._video = { w: v.videoWidth, h: v.videoHeight };
        self.quadros.push({
          mascara: new Uint8Array(r.mascara),
          cores: new Uint8ClampedArray(cor),
          t: performance.now(),                 // o ângulo sai do tempo
          orient: self._lerOrientacao()         // inclinação real do celular
        });
        self._desenharMascara(r.mascara);
      }
    }

    const n = self.quadros.length;
    self._desenharAnel(n);

    // Instrução da vez, no mesmo espírito da fase de enquadramento
    // Não existe aviso de "você parou de girar". Foi tentado e removido:
    // garrafa, lata e pote são sólidos de revolução — girá-los produz
    // quadros idênticos em forma E em cor, então nenhuma medida separa
    // "parado" de "simétrico". O aviso disparava em todo escaneamento
    // correto desses produtos, que são justamente os mais comuns. E,
    // para peça simétrica, capturar sem girar dá o mesmo resultado certo.
    // Girar rápido demais, esse sim, tem sinal confiável: a volta fecha
    // antes dos 36 quadros e os ângulos assumidos saem todos errados.
    let txt = 'Continue girando', classe = 'bom';
    if (cortado) {
      txt = 'Afaste — o produto está saindo da moldura';
      classe = 'ruim';
    } else if (movimento !== null && movimento > 0.55) {
      txt = 'Devagar — está girando rápido demais';
      classe = 'ajuste';
    }
    d.aviso.textContent = txt + ' · ' + n + '/' + N_ALVO;
    d.aviso.className = 'sc-aviso ' + classe;
    d.btnPri.disabled = n < MIN_FRAMES;

    if (n >= N_ALVO) { self._pararCaptura(); self._faseProcessar(); return; }
    self._timer = setTimeout(capturar, INTERVALO_MS);
  };
  capturar();
};

// Um traço por quadro que falta capturar, e eles acendem conforme a
// volta anda. Assim o lojista vê quanto falta em quadros, não em
// porcentagem — e a roda é a metáfora certa para um giro.
Scanner.prototype._desenharAnel = function (n) {
  const L = 116, meio = L / 2, raio = 44;
  const c = this.dom.anel.getContext('2d');
  c.clearRect(0, 0, L, L);

  for (let i = 0; i < N_ALVO; i++) {
    const ang = -Math.PI / 2 + (i / N_ALVO) * Math.PI * 2;
    const aceso = i < n;
    const r1 = raio - (aceso ? 9 : 5), r2 = raio;
    c.strokeStyle = aceso ? '#e8854a' : 'rgba(255,255,255,.3)';
    c.lineWidth = aceso ? 4 : 2.5;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(meio + Math.cos(ang) * r1, meio + Math.sin(ang) * r1);
    c.lineTo(meio + Math.cos(ang) * r2, meio + Math.sin(ang) * r2);
    c.stroke();
  }

  c.fillStyle = '#fff';
  c.font = '700 22px system-ui, sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(String(n), meio, meio - 5);
  c.font = '500 10px system-ui, sans-serif';
  c.fillStyle = 'rgba(255,255,255,.7)';
  c.fillText('de ' + N_ALVO, meio, meio + 12);
};

Scanner.prototype._pararCaptura = function () {
  this.capturando = false;
  if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  this.dom.anel.style.display = 'none';
};

// ---------- fase 4: esculpir ----------
Scanner.prototype._faseProcessar = function () {
  const self = this;
  const d = this.dom;
  this._pararCamera();

  if (this.quadros.length < MIN_FRAMES) {
    return this._erro('Poucos quadros para reconstruir.',
      'Preciso de pelo menos ' + MIN_FRAMES + ' quadros de uma volta completa.');
  }

  d.mask.style.display = 'none';
  d.moldura.style.display = 'none';
  d.aviso.style.display = 'none';
  d.msg.style.display = '';
  d.msg.innerHTML = '';
  d.msg.appendChild(el('div', 'sc-spin'));
  const texto = el('div', null, 'Analisando os quadros…');
  d.msg.appendChild(texto);
  const barra = el('div', 'sc-barra');
  const preench = document.createElement('i');
  barra.appendChild(preench);
  d.msg.appendChild(barra);
  d.btnSec.textContent = 'Cancelar';
  d.btnSec.onclick = function () { self.fechar(); };
  d.btnPri.disabled = true;
  d.btnPri.textContent = 'Processando…';

  // A preparação (sentido do giro, eixo, encaixe do volume) roda de uma vez
  // só e leva alguns segundos no celular. Devolve a thread antes: sem isso a
  // tela ficava parada no último quadro da captura, sem a roda de espera —
  // parecia travada.
  setTimeout(function () {
    if (self.destruido) return;
    let rec;
    try {
      const v = self._video;
      rec = new Reconstrucao(self.quadros, self.produto, { fov: v ? fovDoRecorte(v.w, v.h) : FOV_PADRAO });
    } catch (e) {
      console.error('[Scanner3D]', e);
      return self._erro('Falhou ao preparar a reconstrução.', 'Tente escanear novamente.');
    }
    const total = rec.total();

    const passo = function () {
      if (self.destruido) return;
      let continua;
      try {
        continua = rec.esculpirProximo();
      } catch (e) {
        // sem isto, um erro aqui deixava a roda de espera girando para sempre
        console.error('[Scanner3D]', e);
        return self._erro('Falhou ao esculpir o volume.', 'Tente escanear novamente.');
      }
      preench.style.width = Math.round(100 * rec.i / total) + '%';
      texto.textContent = 'Esculpindo o volume… (' + rec.i + '/' + total + ')';
      if (rec.vivos === 0) {
        return self._erro('A escultura ficou vazia.',
          'As silhuetas não se cruzaram — normalmente é a volta que não foi completa ' +
          'ou o produto que saiu da moldura no meio do caminho.');
      }
      if (continua) {
        setTimeout(passo, 0);           // devolve a thread pra tela respirar
      } else {
        texto.textContent = 'Gerando a malha…';
        setTimeout(function () { self._construirMalha(rec); }, 30);
      }
    };
    passo();
  }, 50);
};

Scanner.prototype._construirMalha = function (rec) {
  try {
    const res = rec.finalizar();
    if (!res) {
      return this._erro('Não sobrou volume suficiente.',
        'Tente de novo com um fundo mais contrastante e uma volta mais lenta.');
    }
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.8, metalness: 0.02
    });
    this.malha = new THREE.Mesh(res.geometria, mat);
    this.resultado = res;
    this._ajusteAltura = 1;
    if (window.console && console.info) console.info('[Scanner3D]', JSON.stringify(res.meta));
    this._faseResultado(res.vertices, res.triangulos);
  } catch (e) {
    console.error('[Scanner3D]', e);
    this._erro('Falhou ao montar a malha.', 'Tente escanear novamente.');
  }
};

// ---------- fase 5: resultado, com preview girável ----------
Scanner.prototype._faseResultado = function (nVerts, nTris) {
  const self = this;
  const d = this.dom;
  this._exportando = false;
  d.msg.style.display = 'none';

  const cv = document.createElement('canvas');
  cv.className = 'sc-3d';
  d.quadro.appendChild(cv);
  this.cvPreview = cv;

  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  r.outputColorSpace = THREE.SRGBColorSpace;
  this.renderer = r;

  const cena = new THREE.Scene();
  cena.background = new THREE.Color(0x14141a);
  cena.add(new THREE.HemisphereLight(0xffffff, 0x606070, 2.2));
  const luz = new THREE.DirectionalLight(0xffffff, 1.6);
  luz.position.set(2, 3, 2);
  cena.add(luz);
  cena.add(this.malha);

  const bb = this.malha.geometry.boundingBox;
  const tam = bb.getSize(new THREE.Vector3());
  const maior = Math.max(tam.x, tam.y, tam.z);
  const cam = new THREE.PerspectiveCamera(50, 3 / 4, maior * 0.01, maior * 40);
  cam.position.set(maior * 1.5, tam.y * 0.75 + maior * 0.5, maior * 1.9);
  const ctr = new OrbitControls(cam, cv);
  ctr.enableDamping = true;
  ctr.target.set(0, tam.y * 0.5, 0);
  ctr.update();

  const ajusta = function () {
    const b = cv.getBoundingClientRect();
    r.setSize(Math.max(1, b.width), Math.max(1, b.height), false);
    cam.aspect = b.width / b.height;
    cam.updateProjectionMatrix();
  };
  ajusta();
  this._ro = new ResizeObserver(ajusta);
  this._ro.observe(cv);

  r.setAnimationLoop(function () { ctr.update(); r.render(cena, cam); });

  this._montarTamanho();
  d.dica.innerHTML = '<b style="color:var(--text,#f0ece3)">Modelo pronto.</b> ' +
    nTris.toLocaleString('pt-BR') + ' triângulos · gire para conferir.';
  d.btnSec.textContent = '↺ Refazer';
  d.btnSec.disabled = false;
  d.btnSec.onclick = function () { self._refazer(); };
  d.btnPri.textContent = 'Usar este modelo';
  d.btnPri.disabled = false;
  d.btnPri.onclick = function () { self._exportar(); };
};

// Tamanho da peça + altura real do produto. A forma vem do escaneamento; o
// tamanho sai das medidas da embalagem, que são um teto — o lojista confere
// a altura (a medida mais fácil de tirar com uma régua) e a peça inteira
// acompanha, por igual, sem deformar.
Scanner.prototype._montarTamanho = function () {
  const self = this;
  const d = this.dom, res = this.resultado;
  const fmt = function (v) { return (Math.round(v * 10) / 10).toLocaleString('pt-BR'); };
  d.passos.innerHTML = '';
  const caixa = el('div', 'sc-tam');
  const linha = el('div', 'sc-tam-linha');
  linha.appendChild(el('b', null, 'Tamanho do modelo: '));
  const dims = el('span');
  linha.appendChild(dims);
  caixa.appendChild(linha);

  const lbl = el('label', 'sc-tam-alt');
  lbl.appendChild(el('span', null, 'Altura real do produto'));
  const inp = document.createElement('input');
  inp.type = 'number'; inp.min = '0.5'; inp.max = '400'; inp.step = '0.1'; inp.inputMode = 'decimal';
  inp.value = String(res.dims.altura);
  inp.setAttribute('aria-describedby', 'sc-tam-nota');
  lbl.appendChild(inp);
  lbl.appendChild(el('span', null, 'cm'));
  caixa.appendChild(lbl);

  const nota = el('p', 'sc-tam-nota');
  nota.id = 'sc-tam-nota';
  const p = this.produto;
  nota.textContent = res.semMedidas
    ? 'Sem as medidas da embalagem o tamanho é um chute: confira a altura com uma régua.'
    : (res.medidasConfiaveis
      ? 'Calculado pelas medidas da embalagem (' + fmt(+p.comprimento) + ' × ' + fmt(+p.largura) + ' × ' + fmt(+p.altura) +
        ' cm). Se a altura não bater, corrija — a forma não muda, só o tamanho.'
      : 'A embalagem (' + fmt(+p.comprimento) + ' × ' + fmt(+p.largura) + ' × ' + fmt(+p.altura) +
        ' cm) tem outra proporção que o produto, então este é só o maior tamanho que cabe nela. ' +
        'Meça a altura do produto e corrija aqui.');
  if (!res.semMedidas && !res.medidasConfiaveis) nota.classList.add('atencao');
  caixa.appendChild(nota);
  d.passos.appendChild(caixa);

  const atualizar = function () {
    const k = self._ajusteAltura;
    dims.textContent = fmt(res.dims.largura * k) + ' L × ' + fmt(res.dims.altura * k) + ' A × ' +
      fmt(res.dims.profundidade * k) + ' P cm';
  };
  inp.oninput = function () {
    const v = parseFloat(String(inp.value).replace(',', '.'));
    const ok = Number.isFinite(v) && v >= 0.5 && v <= 400;
    inp.setAttribute('aria-invalid', ok ? 'false' : 'true');
    // Altura inválida não exporta: sem isto o arquivo saía com a última altura
    // válida, diferente do que estava escrito no campo.
    if (!self._exportando) d.btnPri.disabled = !ok;
    if (!ok) return;
    // Só o número muda. A peça da prévia fica como está: a forma é a mesma em
    // qualquer tamanho, e escalá-la ali a tirava do enquadramento (e a
    // miniatura do cadastro saía com a peça minúscula ou cortada).
    self._ajusteAltura = v / res.dims.altura;
    atualizar();
  };
  atualizar();
};

Scanner.prototype._refazer = function () {
  this._limparPreview();
  this.quadros = [];
  this.malha = null;
  this.resultado = null;
  this.dom.passos.innerHTML = '';
  this._faseMira();
};

Scanner.prototype._exportar = function () {
  const self = this;
  const d = this.dom;
  if (this._exportando) return;
  this._exportando = true;
  d.btnPri.disabled = true;
  d.btnPri.textContent = 'Gerando .glb…';

  // Miniatura do preview pra usar como prévia no formulário
  let previewURL = null;
  try { previewURL = this.cvPreview.toDataURL('image/png'); } catch (e) {}

  // A altura que o lojista confirmou vai gravada na geometria, e o arquivo
  // leva junto (extras do glTF) que já está em METROS de verdade: o
  // visualizador do cliente usa o tamanho dele em vez de reencaixar nas
  // medidas da embalagem.
  const k = this._ajusteAltura || 1;
  const geo = this.malha.geometry.clone();
  if (k !== 1) geo.scale(k, k, k);
  geo.computeBoundingBox();
  const tam = geo.boundingBox.getSize(new THREE.Vector3());
  const saida = new THREE.Mesh(geo, this.malha.material);
  saida.name = 'produto-escaneado';
  saida.userData = {
    escaneado: true, escalaReal: true,
    larguraCm: Math.round(tam.x * 1000) / 10,
    alturaCm: Math.round(tam.y * 1000) / 10,
    profundidadeCm: Math.round(tam.z * 1000) / 10
  };

  new GLTFExporter().parse(saida, function (res) {
    const blob = new Blob([res], { type: 'model/gltf-binary' });
    const arquivo = new File([blob], 'escaneado.glb', { type: 'model/gltf-binary' });
    self.aoConcluir(arquivo, previewURL);
    self.fechar();
  }, function (err) {
    console.error('[Scanner3D] export', err);
    self._exportando = false;
    self._erro('Não consegui gerar o arquivo .glb.', 'Tente novamente.');
  }, { binary: true });
};

// ---------- utilidades ----------
Scanner.prototype._erro = function (titulo, detalhe) {
  const self = this;
  const d = this.dom;
  this._pararCaptura();
  this._pararCamera();
  d.mask.style.display = 'none';
  d.moldura.style.display = 'none';
  d.aviso.style.display = 'none';
  d.msg.style.display = '';
  d.msg.innerHTML = '';
  d.msg.appendChild(el('div', null, '😕'));
  const t = el('div');
  t.appendChild(el('b', null, titulo));
  t.appendChild(document.createTextNode(detalhe || ''));
  d.msg.appendChild(t);
  d.btnSec.textContent = 'Fechar';
  d.btnSec.disabled = false;
  d.btnSec.onclick = function () { self.fechar(); };
  d.btnPri.textContent = 'Tentar de novo';
  d.btnPri.disabled = false;
  d.btnPri.onclick = function () { self.quadros = []; self._faseMira(); };
};

Scanner.prototype._pararCamera = function () {
  this._desligarOrientacao();
  if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  if (this.stream) {
    this.stream.getTracks().forEach(function (t) { t.stop(); });
    this.stream = null;
  }
  if (this.dom && this.dom.video) this.dom.video.srcObject = null;
};

Scanner.prototype._limparPreview = function () {
  if (this._ro) { this._ro.disconnect(); this._ro = null; }
  if (this.renderer) {
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    if (this.renderer.forceContextLoss) this.renderer.forceContextLoss();
    this.renderer = null;
  }
  if (this.malha) {
    this.malha.geometry.dispose();
    this.malha.material.dispose();
  }
  if (this.cvPreview && this.cvPreview.parentNode) {
    this.cvPreview.parentNode.removeChild(this.cvPreview);
    this.cvPreview = null;
  }
};

Scanner.prototype.fechar = function () {
  if (this.destruido) return;
  this.destruido = true;
  this._pararCaptura();
  this._pararCamera();
  this._limparPreview();
  this.quadros = [];
  document.removeEventListener('keydown', this._onKey);
  if (this.dom.back.parentNode) this.dom.back.parentNode.removeChild(this.dom.back);
  if (ativo === this) ativo = null;
};

// ============================================================
//  API PÚBLICA
// ============================================================

window.Scanner3D = {
  abrir: function (opcoes) {
    injetarCSS();
    if (ativo) ativo.fechar();
    ativo = new Scanner(opcoes || {});
    return ativo;
  },
  fechar: function () { if (ativo) ativo.fechar(); },
  suportado: function () {
    try {
      const cv = document.createElement('canvas');
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
        (cv.getContext('webgl2') || cv.getContext('webgl')));
    } catch (e) { return false; }
  },

  // Exposto para teste automatizado: roda o pipeline em silhuetas
  // já prontas, sem câmera nenhuma.
  _carregarLib: carregarLib,
  _setElevacao: function (g) { ELEVACAO = g * Math.PI / 180; },
  _distancia: function () { return 1 / (2 * FRAC_ALTURA * Math.tan(FOV / 2)); },
  _posesDosQuadros: posesDosQuadros,
  _segmentar: segmentar,
  _avaliarCena: avaliarCena,
  _suavizar: suavizar,
  _montarCameras: montarCameras,
  _pipeline: function (quadros, poses) {
    const ps = poses || posesDosQuadros(quadros);
    const cams = montarCameras(ps);
    ajustarVolume(quadros, ps);
    const volume = new Float32Array(NX * NY * NZ).fill(1);
    let vivos = 0;
    for (let i = 0; i < quadros.length; i++) vivos = esculpir(volume, quadros[i].mascara, cams[i]);
    const malha = gerarMalha(volume);
    return { volume: volume, vivos: vivos, malha: malha, cams: cams };
  },
  _ajustarVolume: ajustarVolume,
  // A reconstrução inteira, como o scanner faz depois da volta
  _reconstruir: function (quadros, produto, op) {
    const rec = new Reconstrucao(quadros, produto, op);
    while (rec.esculpirProximo()) { /* um quadro por vez */ }
    const res = rec.finalizar();
    if (!res) return { vazio: true, meta: rec.meta };
    return {
      volume: rec.volume, passo: PASSO, origem: ORIGEM.slice(),
      distancia: 1 / (2 * FRAC_ALTURA * Math.tan(FOV / 2)),
      final: { pos: res.geometria.attributes.position.array, idx: res.geometria.index.array },
      dims: res.dims, medidasConfiaveis: res.medidasConfiaveis, meta: res.meta
    };
  },
  _roi: function () { return { x0: ROI.x0, y0: ROI.y0, x1: ROI.x1, y1: ROI.y1 }; },
  _fovDoRecorte: fovDoRecorte,
  _orientacaoDaCamera: orientacaoDaCamera,
  _sentidoDoGiro: sentidoDoGiro,
  _escalaPelaEmbalagem: escalaPelaEmbalagem,
  // PASSO e ORIGEM mudam a cada escaneamento, então são lidos na hora
  _consts: {
    LARG: LARG, ALT: ALT, NX: NX, NY: NY, NZ: NZ,
    get PASSO() { return PASSO; },
    get ORIGEM() { return ORIGEM; }
  }
};
})();
