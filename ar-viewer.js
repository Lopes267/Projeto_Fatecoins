/* ============================================================
   AR VIEWER — "Ver no meu espaço"
   Renderização 3D e Realidade Aumentada dos produtos.

   Como ligar numa página (script clássico, depois do app.js):

     <script type="importmap">
     {"imports":{
       "three":"https://unpkg.com/three@0.161.0/build/three.module.js",
       "three/addons/":"https://unpkg.com/three@0.161.0/examples/jsm/"
     }}
     </script>
     <script src="ar-viewer.js"></script>

   E então:  ARViewer.open(produto)  /  ARViewer.openById(id)

   O produto precisa de nome + imagem_url e, de preferência, das
   medidas em cm (comprimento/largura/altura) — são elas que dão a
   escala real. Sem medidas caímos num padrão por categoria e
   avisamos o cliente na tela. Se o lojista enviou um modelo .glb
   (modelo_3d_url), ele entra no lugar da caixa texturizada.

   A biblioteca 3D só é baixada quando o cliente abre o visualizador;
   quem nunca clicar não paga o custo do download.
   ============================================================ */
(function () {
'use strict';

// ---------- constantes ----------
const CM = 0.01;                       // cm → metros (a cena trabalha em metros)
const MIN_M = 0.02, MAX_M = 4;         // limites sãos pra medida vinda do cadastro

// Sem medidas cadastradas, um chute por categoria: [largura, altura, profundidade] em cm
const MEDIDAS_PADRAO = {
  'Eletrônicos':      [35, 25, 15],
  'Moda':             [30, 40, 10],
  'Alimentos':        [20, 25, 15],
  'Casa & Decoração': [50, 45, 40],
  'Esportes':         [40, 30, 25],
  'Beleza':           [10, 18,  8],
  'Livros':           [16, 23,  3],
  'Brinquedos':       [30, 25, 20],
  '_':                [30, 25, 20]
};

// ---------- carregamento sob demanda do three.js ----------
let THREE = null, OrbitControls = null, GLTFLoader = null;
let _v1 = null, _v2 = null;   // reaproveitados no laço de quadro, que roda 60x/s
let libPromise = null;

function carregarLib() {
  if (libPromise) return libPromise;
  libPromise = Promise.all([
    import('three'),
    import('three/addons/controls/OrbitControls.js'),
    import('three/addons/loaders/GLTFLoader.js')
  ]).then(function (mods) {
    THREE = mods[0];
    OrbitControls = mods[1].OrbitControls;
    GLTFLoader = mods[2].GLTFLoader;
  }).catch(function (err) {
    libPromise = null;                 // deixa tentar de novo numa próxima abertura
    throw err;
  });
  return libPromise;
}

// ============================================================
//  MEDIDAS
// ============================================================

function limita(n) { return Math.min(MAX_M, Math.max(MIN_M, n)); }

// Devolve as medidas em METROS + se foram estimadas
function medidasDoProduto(p) {
  const l = Number(p.largura), a = Number(p.altura), c = Number(p.comprimento);
  const temTudo = [l, a, c].every(v => Number.isFinite(v) && v > 0);
  if (temTudo) {
    return { w: limita(l * CM), h: limita(a * CM), d: limita(c * CM), estimado: false };
  }
  const padrao = MEDIDAS_PADRAO[p.categoria] || MEDIDAS_PADRAO._;
  return { w: padrao[0] * CM, h: padrao[1] * CM, d: padrao[2] * CM, estimado: true };
}

function emCm(m) {
  const v = m * 100;
  return v >= 100 ? (v / 100).toFixed(2).replace('.', ',') + ' m' : Math.round(v) + ' cm';
}

// ============================================================
//  IMAGEM DO PRODUTO → TEXTURAS
// ============================================================

// Carrega a foto liberando o uso em WebGL (o Cloudinary devolve CORS aberto)
function carregarImagem(url) {
  return new Promise(function (resolve) {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);        // sem foto seguimos com cor sólida
    img.src = url;
  });
}

// Cor média da foto — vira a cor das laterais da caixa
function corMedia(img) {
  if (!img) return 'rgb(138,138,138)';
  try {
    const cv = document.createElement('canvas');
    cv.width = 24; cv.height = 24;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 24, 24);
    const d = ctx.getImageData(0, 0, 24, 24).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) continue;            // ignora pixel transparente
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    if (!n) return 'rgb(138,138,138)';
    // Puxa pro claro pra caixa não ficar pesada demais
    const mix = v => Math.round(Math.min(255, (v / n) * 0.72 + 62));
    return 'rgb(' + mix(r) + ',' + mix(g) + ',' + mix(b) + ')';
  } catch (e) { return 'rgb(138,138,138)'; }
}

// Sem foto cadastrada, a caixa precisa dizer o que ela é. Antes todo
// produto virava o mesmo bloco cinza e o cliente não reconhecia nada.
const EMOJI_CAT = {
  'Eletrônicos': '💻', 'Moda': '👗', 'Alimentos': '🍎', 'Casa & Decoração': '🏠',
  'Esportes': '⚽', 'Beleza': '💄', 'Livros': '📚', 'Brinquedos': '🧸', '_': '📦'
};

// Cor por categoria: dois produtos de setores diferentes não saem iguais
const COR_CAT = {
  'Eletrônicos': [74, 92, 110], 'Moda': [138, 90, 109], 'Alimentos': [134, 112, 62],
  'Casa & Decoração': [122, 103, 82], 'Esportes': [63, 106, 85], 'Beleza': [142, 106, 122],
  'Livros': [90, 90, 122], 'Brinquedos': [138, 100, 62], '_': [104, 104, 104]
};

// Dentro da mesma categoria, o nome desloca a cor um pouco, para dois
// produtos vizinhos não ficarem idênticos na prateleira
function corDaCategoria(produto) {
  const base = COR_CAT[produto.categoria] || COR_CAT._;
  let h = 0;
  const nome = produto.nome || '';
  for (let i = 0; i < nome.length; i++) h = (h * 31 + nome.charCodeAt(i)) >>> 0;

  // Cada canal pega uma fatia diferente do hash. Deslocar os três juntos
  // só mexia no brilho, e dois produtos da mesma categoria continuavam
  // com a mesma cara.
  const canal = (v, bits) => Math.max(45, Math.min(205, v + ((h >>> bits) & 0xff) % 41 - 20));
  return 'rgb(' + canal(base[0], 0) + ',' + canal(base[1], 8) + ',' + canal(base[2], 16) + ')';
}

// Quebra o nome em até `maxLinhas` linhas que caibam na largura dada
function escreverNome(ctx, texto, cx, cy, maxLargura, alturaLinha, maxLinhas) {
  const palavras = String(texto || '').split(/\s+/);
  const linhas = [];
  let atual = '';

  for (let i = 0; i < palavras.length; i++) {
    const teste = atual ? atual + ' ' + palavras[i] : palavras[i];
    if (ctx.measureText(teste).width > maxLargura && atual) {
      linhas.push(atual);
      atual = palavras[i];
      if (linhas.length === maxLinhas) break;
    } else {
      atual = teste;
    }
  }
  if (linhas.length < maxLinhas && atual) linhas.push(atual);

  // Sobrou nome? Corta a última linha com reticências
  if (linhas.length === maxLinhas) {
    let ultima = linhas[maxLinhas - 1];
    const restou = palavras.join(' ').length > linhas.join(' ').length;
    if (restou) {
      while (ultima.length > 1 && ctx.measureText(ultima + '…').width > maxLargura) {
        ultima = ultima.slice(0, -1);
      }
      linhas[maxLinhas - 1] = ultima + '…';
    }
  }

  const topo = cy - ((linhas.length - 1) * alturaLinha) / 2;
  linhas.forEach((linha, i) => ctx.fillText(linha, cx, topo + i * alturaLinha));
}

// Textura de UMA face da caixa, na proporção real daquela face.
// `papel` diz o que a face mostra: 'frente' (foto ou nome), 'topo'
// (foto ou só o ícone) e 'lado' (nem foto nem texto).
function texturaFace(img, larguraM, alturaM, cor, papel, produto) {
  const base = 640;
  const asp = larguraM / alturaM;
  const cw = Math.max(64, Math.round(asp >= 1 ? base : base * asp));
  const ch = Math.max(64, Math.round(asp >= 1 ? base / asp : base));

  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');

  ctx.fillStyle = cor;
  ctx.fillRect(0, 0, cw, ch);

  // Degradê de leve pra face não sair chapada
  const g = ctx.createLinearGradient(0, 0, 0, ch);
  g.addColorStop(0, 'rgba(255,255,255,.12)');
  g.addColorStop(1, 'rgba(0,0,0,.16)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cw, ch);

  const mostra = papel === 'frente' || papel === 'topo';

  if (mostra && img) {
    const pad = Math.min(cw, ch) * 0.07;
    const s = Math.min((cw - pad * 2) / img.width, (ch - pad * 2) / img.height);
    const dw = img.width * s, dh = img.height * s;
    ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);

  } else if (mostra && produto) {
    // Sem foto: ícone da categoria e, na frente, o nome do produto
    const base = Math.min(cw, ch);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const emoji = EMOJI_CAT[produto.categoria] || EMOJI_CAT._;
    const soIcone = papel === 'topo';

    ctx.font = Math.round(base * (soIcone ? 0.42 : 0.30)) + 'px system-ui, "Segoe UI Emoji", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fillText(emoji, cw / 2, soIcone ? ch / 2 : ch * 0.40);

    if (!soIcone) {
      ctx.font = '600 ' + Math.round(base * 0.088) + 'px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.94)';
      escreverNome(ctx, produto.nome, cw / 2, ch * 0.64, cw * 0.84, base * 0.115, 3);
    }
  }

  // Borda escura sugerindo a quina da embalagem
  const lw = Math.max(2, Math.min(cw, ch) * 0.012);
  ctx.strokeStyle = 'rgba(0,0,0,.22)';
  ctx.lineWidth = lw;
  ctx.strokeRect(lw / 2, lw / 2, cw - lw, ch - lw);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Mancha de sombra sob o objeto — vale pra sala e pra câmera, sem
// depender de shadow map (caro e serrilhado no celular)
function planoDeSombra(w, d) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 6, 128, 128, 124);
  g.addColorStop(0, 'rgba(0,0,0,.45)');
  g.addColorStop(0.55, 'rgba(0,0,0,.18)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(Math.max(w, d) * 2.0, Math.max(w, d) * 2.0),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(cv),
      transparent: true, depthWrite: false, opacity: 0.9
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.002;
  mesh.renderOrder = -1;
  return mesh;
}

// ============================================================
//  O OBJETO: caixa texturizada ou modelo .glb do lojista
// ============================================================

async function montarObjeto(produto, dims) {
  const grupo = new THREE.Group();
  grupo.userData.altura = dims.h;

  if (produto.modelo_3d_url) {
    try {
      const gltf = await new GLTFLoader().loadAsync(produto.modelo_3d_url);
      const modelo = gltf.scene;

      // Encaixa o modelo nas medidas cadastradas sem distorcer e
      // apoia a base no chão (y = 0)
      const box = new THREE.Box3().setFromObject(modelo);
      const tam = box.getSize(new THREE.Vector3());
      const centro = box.getCenter(new THREE.Vector3());
      if (tam.x > 0 && tam.y > 0 && tam.z > 0) {
        const escala = Math.min(dims.w / tam.x, dims.h / tam.y, dims.d / tam.z);
        modelo.scale.setScalar(escala);
        modelo.position.set(
          -centro.x * escala,
          -(centro.y - tam.y / 2) * escala,
          -centro.z * escala
        );
        grupo.userData.altura = tam.y * escala;
      }
      grupo.add(modelo);
      grupo.add(planoDeSombra(dims.w, dims.d));
      grupo.userData.tipo = 'glb';
      return grupo;
    } catch (e) {
      console.warn('[ARViewer] modelo 3D não carregou, usando a caixa da foto:', e);
    }
  }

  // Caminho padrão: caixa no tamanho real com a foto do produto
  const img = await carregarImagem(produto.imagem_url);
  // Com foto, a cor sai da própria foto. Sem foto, sai da categoria —
  // devolver sempre o mesmo cinza fazia todo produto virar a mesma caixa.
  const cor = img ? corMedia(img) : corDaCategoria(produto);
  const w = dims.w, h = dims.h, d = dims.d;

  // Ordem das faces da BoxGeometry: +X, -X, +Y, -Y, +Z, -Z
  const mats = [
    texturaFace(img, d, h, cor, 'lado', produto),     // lateral direita
    texturaFace(img, d, h, cor, 'lado', produto),     // lateral esquerda
    texturaFace(img, w, d, cor, 'topo', produto),     // topo
    texturaFace(img, w, d, cor, 'lado', produto),     // base
    texturaFace(img, w, h, cor, 'frente', produto),   // frente
    texturaFace(img, w, h, cor, 'frente', produto)    // verso
  ].map(map => new THREE.MeshStandardMaterial({ map: map, roughness: 0.78, metalness: 0.03 }));

  const caixa = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats);
  caixa.position.y = h / 2;
  grupo.add(caixa);
  grupo.add(planoDeSombra(w, d));
  grupo.userData.tipo = 'caixa';
  return grupo;
}

// ============================================================
//  A SALA DE REFERÊNCIA
//  Piso, duas paredes, rodapé, uma porta de 2,10 m e a silhueta de
//  uma pessoa de 1,70 m. Tudo em escala real — é o que faz o cliente
//  sentir o tamanho do produto sem ter uma fita métrica na mão.
// ============================================================

function texturaPiso() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#b98d5f';
  ctx.fillRect(0, 0, 512, 512);
  // Tábuas de 512/4 px = 1 m de largura na repetição usada abaixo
  for (let i = 0; i < 4; i++) {
    const y = i * 128;
    ctx.fillStyle = i % 2 ? 'rgba(0,0,0,.05)' : 'rgba(255,255,255,.04)';
    ctx.fillRect(0, y, 512, 128);
    ctx.strokeStyle = 'rgba(60,35,15,.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke();
  }
  // Veios discretos
  ctx.strokeStyle = 'rgba(90,55,25,.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 60; i++) {
    const y = Math.random() * 512;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(170, y + 6, 340, y - 6, 512, y);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);          // com o piso de 12 m dá tábuas de ~37 cm
  tex.anisotropy = 8;
  return tex;
}

function texturaPessoa() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 320;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(30,30,35,.30)';
  // cabeça
  ctx.beginPath(); ctx.arc(64, 34, 22, 0, Math.PI * 2); ctx.fill();
  // tronco + pernas, num contorno só
  ctx.beginPath();
  ctx.moveTo(64, 58);
  ctx.bezierCurveTo(104, 66, 108, 120, 100, 176);
  ctx.lineTo(86, 176);
  ctx.lineTo(80, 316); ctx.lineTo(56, 316);
  ctx.lineTo(60, 190);
  ctx.lineTo(52, 316); ctx.lineTo(28, 316);
  ctx.lineTo(28, 176);
  ctx.bezierCurveTo(20, 120, 24, 66, 64, 58);
  ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function montarSala() {
  const sala = new THREE.Group();
  // O produto fica na origem, no canto da sala: parede do fundo a 1,8 m e
  // parede da esquerda a 2,4 m. O piso é bem maior que isso (12 m) para as
  // quinas não aparecerem no enquadramento — sem isso a "sala" vira um
  // tapete flutuando no vazio.
  const FUNDO_Z = -1.8, ESQ_X = -2.4, PISO = 12, ALTURA_PAREDE = 2.7;
  const ALTURA_MESA = 0.75;
  const cxPiso = ESQ_X + PISO / 2, czPiso = FUNDO_Z + PISO / 2;

  const piso = new THREE.Mesh(
    new THREE.PlaneGeometry(PISO, PISO),
    new THREE.MeshStandardMaterial({ map: texturaPiso(), roughness: 0.85 })
  );
  piso.rotation.x = -Math.PI / 2;
  piso.position.set(cxPiso, 0, czPiso);
  sala.add(piso);

  const matParede = new THREE.MeshStandardMaterial({
    color: 0xe9e3d8, roughness: 0.95, side: THREE.FrontSide
  });
  sala.userData.matParede = matParede;

  const paredeFundo = new THREE.Mesh(new THREE.PlaneGeometry(PISO, ALTURA_PAREDE), matParede);
  paredeFundo.position.set(cxPiso, ALTURA_PAREDE / 2, FUNDO_Z);
  sala.add(paredeFundo);

  const paredeEsq = new THREE.Mesh(new THREE.PlaneGeometry(PISO, ALTURA_PAREDE), matParede);
  paredeEsq.rotation.y = Math.PI / 2;
  paredeEsq.position.set(ESQ_X, ALTURA_PAREDE / 2, czPiso);
  sala.add(paredeEsq);

  // Rodapé (7 cm) — detalhe barato que ancora a escala
  const matRodape = new THREE.MeshStandardMaterial({ color: 0xf6f2ea, roughness: 0.6 });
  const rodapeFundo = new THREE.Mesh(new THREE.BoxGeometry(PISO, 0.07, 0.02), matRodape);
  rodapeFundo.position.set(cxPiso, 0.035, FUNDO_Z + 0.01);
  sala.add(rodapeFundo);
  const rodapeEsq = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.07, PISO), matRodape);
  rodapeEsq.position.set(ESQ_X + 0.01, 0.035, czPiso);
  sala.add(rodapeEsq);

  // Porta de 2,10 m × 0,80 m na parede do fundo: referência de altura
  const batente = new THREE.Mesh(
    new THREE.PlaneGeometry(0.88, 2.16),
    new THREE.MeshStandardMaterial({ color: 0xf6f2ea, roughness: 0.7 })
  );
  batente.position.set(1.6, 1.08, FUNDO_Z + 0.008);
  sala.add(batente);
  const porta = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 2.1),
    new THREE.MeshStandardMaterial({ color: 0xd8cbb6, roughness: 0.8 })
  );
  porta.position.set(1.6, 1.05, FUNDO_Z + 0.012);
  sala.add(porta);

  // Mesa de 75 cm. Produto pequeno no meio do chão não diz nada sobre
  // tamanho — em cima de uma mesa, com o rodapé e a porta ao fundo, o
  // cliente entende na hora se aquilo cabe na mão dele.
  const mesa = new THREE.Group();
  const matMadeira = new THREE.MeshStandardMaterial({ color: 0x8a5f3c, roughness: 0.65 });
  const tampo = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.04, 0.7), matMadeira);
  tampo.position.y = ALTURA_MESA - 0.02;
  mesa.add(tampo);
  [[-0.6, -0.3], [0.6, -0.3], [-0.6, 0.3], [0.6, 0.3]].forEach(function (p) {
    const pe = new THREE.Mesh(new THREE.BoxGeometry(0.055, ALTURA_MESA - 0.04, 0.055), matMadeira);
    pe.position.set(p[0], (ALTURA_MESA - 0.04) / 2, p[1]);
    mesa.add(pe);
  });
  mesa.visible = false;
  sala.userData.mesa = mesa;
  sala.add(mesa);

  // Silhueta de 1,70 m, ligável pelo cliente
  const pessoa = new THREE.Mesh(
    new THREE.PlaneGeometry(0.68, 1.7),
    new THREE.MeshBasicMaterial({ map: texturaPessoa(), transparent: true, depthWrite: false })
  );
  pessoa.position.set(-1.1, 0.85, -0.3);
  pessoa.visible = false;
  sala.userData.pessoa = pessoa;
  sala.add(pessoa);

  return sala;
}

// ============================================================
//  CSS DO VISUALIZADOR
//  Usa as variáveis do site (--card, --text…), então acompanha o
//  modo claro do accessibility.js sem código extra.
// ============================================================

const CSS = `
.arv-back{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.72);backdrop-filter:blur(8px);padding:1.2rem;animation:arvIn .18s ease}
@keyframes arvIn{from{opacity:0}to{opacity:1}}
.arv-modal{display:flex;flex-direction:column;width:min(1080px,100%);height:min(760px,100%);
  background:var(--card,#161616);color:var(--text,#f0ece3);border:1px solid var(--border,#2a2a2a);
  border-radius:18px;overflow:hidden;font-family:var(--font-texto,'Inter',system-ui,sans-serif);box-shadow:0 24px 70px rgba(0,0,0,.5)}
.arv-head{display:flex;align-items:center;gap:.9rem;padding:.9rem 1.2rem;border-bottom:1px solid var(--border,#2a2a2a);flex-shrink:0}
.arv-title{font-weight:600;font-size:1rem;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arv-dims{font-size:.74rem;color:var(--muted,#888);margin-top:.15rem;white-space:nowrap}
.arv-dims b{color:var(--accent2,#f4c56a);font-weight:600}
.arv-x{margin-left:auto;flex-shrink:0;width:34px;height:34px;border-radius:9px;border:1px solid var(--border,#2a2a2a);
  background:transparent;color:var(--text,#f0ece3);cursor:pointer;font-size:1.1rem;line-height:1}
.arv-x:hover{border-color:var(--accent,#e8854a);color:var(--accent,#e8854a)}

/* O vídeo da câmera é o fundo e o canvas 3D vai por cima dele — sem os
   z-index explícitos o vídeo (posicionado) tapa o canvas e o produto some */
.arv-stage{position:relative;flex:1;min-height:0;background:#0a0a0a;overflow:hidden}
.arv-stage canvas{position:absolute;inset:0;display:block;width:100%;height:100%;touch-action:none;z-index:1}
.arv-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;display:none;z-index:0}
.arv-stage.cam .arv-video{display:block}

.arv-sem-foto{color:var(--accent2,#f4c56a)}
/* O botão flutuante de acessibilidade nasce com z-index 99999 e cobria
   os controles do visualizador. Enquanto ele está aberto, vai para trás. */
body.arv-aberto .a11y-root{z-index:100}
.arv-msg{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:.7rem;text-align:center;padding:2rem;color:var(--muted,#888);font-size:.9rem;background:rgba(10,10,10,.86)}
.arv-msg .ico{font-size:2rem}
.arv-msg b{color:var(--text,#f0ece3);display:block;margin-bottom:.15rem}
.arv-spin{width:34px;height:34px;border-radius:50%;border:3px solid var(--border,#2a2a2a);
  border-top-color:var(--accent,#e8854a);animation:arvSpin .8s linear infinite}
@keyframes arvSpin{to{transform:rotate(360deg)}}

.arv-hint{position:absolute;z-index:3;left:50%;bottom:.9rem;transform:translateX(-50%);pointer-events:none;
  background:rgba(0,0,0,.6);color:#fff;font-size:.76rem;padding:.42rem .85rem;border-radius:50px;
  white-space:nowrap;max-width:92%;overflow:hidden;text-overflow:ellipsis}

.arv-bar{display:flex;gap:.4rem;padding:.6rem 1.2rem;border-top:1px solid var(--border,#2a2a2a);
  overflow-x:auto;scrollbar-width:none;flex-shrink:0}
.arv-bar::-webkit-scrollbar{display:none}
.arv-tab{padding:.45rem 1rem;border-radius:8px;border:1px solid transparent;background:transparent;
  color:var(--muted,#888);font:inherit;font-size:.84rem;font-weight:500;cursor:pointer;white-space:nowrap;transition:all .18s}
.arv-tab:hover{color:var(--text,#f0ece3)}
.arv-tab.on{background:var(--card2,#1c1c1c);border-color:var(--accent,#e8854a);color:var(--accent,#e8854a)}
.arv-tab[disabled]{opacity:.38;cursor:not-allowed}

.arv-tools{display:flex;align-items:center;gap:.9rem;padding:.6rem 1.2rem;border-top:1px solid var(--border,#2a2a2a);
  flex-wrap:wrap;font-size:.78rem;color:var(--muted,#888);flex-shrink:0}
.arv-tools label{display:flex;align-items:center;gap:.4rem;cursor:pointer}
.arv-tools input[type=range]{width:120px;accent-color:var(--accent,#e8854a)}
.arv-tools input[type=checkbox]{accent-color:var(--accent,#e8854a);width:15px;height:15px}
.arv-swatches{display:flex;gap:.3rem}
/* Contorno sempre visível: sem ele a amostra branca some no modo claro */
.arv-sw{width:22px;height:22px;border-radius:50%;border:2px solid rgba(128,128,128,.4);cursor:pointer;padding:0}
.arv-sw.on{border-color:var(--accent,#e8854a)}
.arv-mini{padding:.35rem .8rem;border-radius:7px;border:1px solid var(--border,#2a2a2a);background:transparent;
  color:var(--text,#f0ece3);font:inherit;font-size:.78rem;cursor:pointer}
.arv-mini:hover{border-color:var(--accent,#e8854a);color:var(--accent,#e8854a)}
.arv-mini.pri{background:var(--accent,#e8854a);border-color:var(--accent,#e8854a);color:#fff}
.arv-mini.pri:hover{background:var(--accent-hover,#d9733c);color:#fff}
.arv-push{margin-left:auto}

/* Durante a sessão de realidade aumentada, só a barrinha de saída
   fica sobre a câmera do celular (dom-overlay) */
.arv-back.xr{background:transparent;backdrop-filter:none;padding:0;align-items:flex-end}
.arv-back.xr .arv-modal{background:transparent;border:none;box-shadow:none;height:auto;justify-content:flex-end}
.arv-back.xr .arv-head,.arv-back.xr .arv-stage,.arv-back.xr .arv-bar,.arv-back.xr .arv-tools{display:none}
.arv-xrbar{display:none;gap:.6rem;align-items:center;justify-content:center;padding:1rem;
  background:linear-gradient(to top,rgba(0,0,0,.75),transparent)}
.arv-back.xr .arv-xrbar{display:flex}
.arv-xrbar span{color:#fff;font-size:.82rem;text-shadow:0 1px 3px rgba(0,0,0,.8)}
.arv-xrbar>div{display:flex;gap:.4rem}

@media(max-width:640px){
  .arv-back{padding:0}
  .arv-modal{width:100%;height:100%;border-radius:0;border:none}
  .arv-tools{gap:.6rem;font-size:.74rem}
  .arv-tools input[type=range]{width:88px}
}
`;

function injetarCSS() {
  if (document.getElementById('arv-css')) return;
  const st = document.createElement('style');
  st.id = 'arv-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

// ============================================================
//  VISUALIZADOR
// ============================================================

let ativo = null;      // instância aberta no momento (só uma por vez)

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

function Viewer(produto) {
  this.giroExtra = 0;
  this.bussola = false;
  this.produto = produto;
  this.dims = medidasDoProduto(produto);
  this.modo = 'sala';
  this.destruido = false;
  this.stream = null;
  this.session = null;
  this.hitSource = null;
  this.colocado = false;
  this._construirUI();
}

Viewer.prototype._construirUI = function () {
  const self = this;
  const p = this.produto, d = this.dims;

  const back = el('div', 'arv-back');
  back.setAttribute('role', 'dialog');
  back.setAttribute('aria-modal', 'true');
  back.setAttribute('aria-label', 'Visualizar ' + (p.nome || 'produto') + ' em 3D');

  const modal = el('div', 'arv-modal');
  back.appendChild(modal);

  // --- cabeçalho ---
  const head = el('div', 'arv-head');
  const tit = el('div');
  tit.appendChild(el('div', 'arv-title', p.nome || 'Produto'));
  const dimsTxt = el('div', 'arv-dims');
  dimsTxt.innerHTML = (d.estimado ? 'Medidas aproximadas · ' : 'Tamanho real · ') +
    '<b>' + emCm(d.w) + ' L × ' + emCm(d.h) + ' A × ' + emCm(d.d) + ' P</b>' +
    // Sem foto o cliente vê uma caixa com o nome escrito; dizer isso evita
    // que ele ache que o produto é uma caixa de verdade
    (!p.imagem_url && !p.modelo_3d_url ? ' · <span class="arv-sem-foto">sem foto do produto</span>' : '');
  tit.appendChild(dimsTxt);
  head.appendChild(tit);

  const btnX = el('button', 'arv-x', '✕');
  btnX.setAttribute('aria-label', 'Fechar');
  btnX.onclick = function () { self.fechar(); };
  head.appendChild(btnX);
  modal.appendChild(head);

  // --- palco ---
  const stage = el('div', 'arv-stage');
  const video = document.createElement('video');
  video.className = 'arv-video';
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.autoplay = true;
  stage.appendChild(video);
  const hint = el('div', 'arv-hint');
  stage.appendChild(hint);
  const msg = el('div', 'arv-msg');
  stage.appendChild(msg);
  modal.appendChild(stage);

  // --- abas de modo ---
  const bar = el('div', 'arv-bar');
  const abas = {
    sala: el('button', 'arv-tab on', '🛋️ Na sala'),
    ar:   el('button', 'arv-tab', '📱 Realidade aumentada'),
    foto: el('button', 'arv-tab', '📷 Na minha câmera')
  };
  Object.keys(abas).forEach(function (k) {
    abas[k].onclick = function () { self.trocarModo(k); };
    bar.appendChild(abas[k]);
  });
  // A aba de AR só libera depois que o navegador confirmar o suporte —
  // habilitada por otimismo ela abriria um erro no primeiro clique
  abas.ar.disabled = true;
  abas.ar.title = 'Verificando se este aparelho tem realidade aumentada…';
  modal.appendChild(bar);

  // --- ferramentas (o conteúdo muda por modo) ---
  const tools = el('div', 'arv-tools');
  modal.appendChild(tools);

  // --- barra que sobra em cima da câmera durante o AR ---
  const xrbar = el('div', 'arv-xrbar');
  const xrTxt = el('span', null, 'Aponte para o chão e toque para posicionar');
  // Girar dentro do AR: sem isso o cliente teria que andar em volta do
  // produto pra ver o outro lado, e em sala pequena não dá
  const xrGirar = el('div', null, null);
  xrGirar.style.display = 'none';
  [['↺', -1], ['↻', 1]].forEach(function (par) {
    const b = el('button', 'arv-mini', par[0]);
    b.setAttribute('aria-label', par[1] < 0 ? 'Girar para a esquerda' : 'Girar para a direita');
    b.onclick = function () {
      self.giroExtra += par[1] * Math.PI / 8;
      self.objeto.rotation.y += par[1] * Math.PI / 8;
    };
    xrGirar.appendChild(b);
  });
  const xrSair = el('button', 'arv-mini pri', 'Sair do AR');
  xrSair.onclick = function () { if (self.session) self.session.end(); };
  xrbar.appendChild(xrTxt);
  xrbar.appendChild(xrGirar);
  xrbar.appendChild(xrSair);
  modal.appendChild(xrbar);

  this.dom = { back: back, modal: modal, stage: stage, video: video, hint: hint,
               msg: msg, tools: tools, abas: abas, xrTxt: xrTxt, xrGirar: xrGirar };

  // Fecha no ESC ou clicando fora
  this._onKey = function (e) { if (e.key === 'Escape' && !self.session) self.fechar(); };
  document.addEventListener('keydown', this._onKey);
  back.addEventListener('click', function (e) { if (e.target === back && !self.session) self.fechar(); });

  document.body.appendChild(back);
  document.body.classList.add('arv-aberto');
  btnX.focus();                                  // teclado entra dentro do diálogo
  this._msgCarregando('Preparando a visualização 3D…');
};

Viewer.prototype._msgCarregando = function (texto) {
  this.dom.msg.style.display = '';
  this.dom.msg.innerHTML = '';
  this.dom.msg.appendChild(el('div', 'arv-spin'));
  this.dom.msg.appendChild(el('div', null, texto));
};

Viewer.prototype._msgErro = function (titulo, detalhe) {
  this.dom.msg.style.display = '';
  this.dom.msg.innerHTML = '';
  this.dom.msg.appendChild(el('div', 'ico', '😕'));
  const t = el('div');
  t.appendChild(el('b', null, titulo));
  t.appendChild(document.createTextNode(detalhe || ''));
  this.dom.msg.appendChild(t);
};

Viewer.prototype._semMsg = function () { this.dom.msg.style.display = 'none'; };

// ------------------------------------------------------------
//  Cena
// ------------------------------------------------------------

Viewer.prototype.iniciar = async function () {
  const self = this;
  try {
    await carregarLib();
  } catch (e) {
    this._msgErro('Não foi possível carregar o 3D.',
      'Verifique sua conexão e tente de novo.');
    return;
  }
  if (this.destruido) return;

  const stage = this.dom.stage;

  const renderer = new THREE.WebGLRenderer({
    antialias: true, alpha: true, preserveDrawingBuffer: true
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.xr.enabled = true;
  if (!_v1) { _v1 = new THREE.Vector3(); _v2 = new THREE.Vector3(); }
  stage.insertBefore(renderer.domElement, this.dom.hint);
  this.renderer = renderer;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101014);
  this.scene = scene;

  const camera = new THREE.PerspectiveCamera(52, 1, 0.01, 60);
  this.camera = camera;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 2.1));
  const sol = new THREE.DirectionalLight(0xfff2e0, 1.7);
  sol.position.set(2.5, 4, 2.5);
  scene.add(sol);
  const preenche = new THREE.DirectionalLight(0xdfe8ff, 0.55);
  preenche.position.set(-3, 2, -1.5);
  scene.add(preenche);

  this.sala = montarSala();
  scene.add(this.sala);

  try {
    this.objeto = await montarObjeto(this.produto, this.dims);
  } catch (e) {
    console.error('[ARViewer]', e);
    this._msgErro('Não deu para montar o objeto.', 'Tente novamente mais tarde.');
    return;
  }
  if (this.destruido) return;
  scene.add(this.objeto);

  // Retículo do AR: o anel que marca onde o objeto vai encostar no chão
  const ret = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xe8854a, transparent: true, opacity: 0.95 })
  );
  ret.matrixAutoUpdate = false;
  ret.visible = false;
  scene.add(ret);
  this.reticulo = ret;

  this.controls = new OrbitControls(camera, renderer.domElement);
  this.controls.enableDamping = true;
  this.controls.dampingFactor = 0.08;
  this.controls.minDistance = 0.25;
  this.controls.maxDistance = 12;
  this.controls.maxPolarAngle = Math.PI / 2 - 0.03;   // não deixa passar pra baixo do piso
  this.controls.target.set(0, Math.min(this.objeto.userData.altura / 2, 0.7), 0);

  this._observarTamanho();
  this._semMsg();
  this.trocarModo('sala');

  renderer.setAnimationLoop(function (t, frame) { self._quadro(frame); });
  this._verificarSuporteAR();
};

Viewer.prototype._observarTamanho = function () {
  const self = this;
  const ajusta = function () {
    if (self.destruido || self.session) return;   // no XR quem manda é o headset/celular
    const r = self.dom.stage.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    self.renderer.setSize(w, h, false);
    self.camera.aspect = w / h;
    self.camera.updateProjectionMatrix();
  };
  if (window.ResizeObserver) {
    this._ro = new ResizeObserver(ajusta);
    this._ro.observe(this.dom.stage);
  }
  this._onResize = ajusta;
  window.addEventListener('resize', ajusta);
  ajusta();
};

Viewer.prototype._quadro = function (frame) {
  if (this.destruido) return;

  if (this.modo === 'sala' && this.controls) this.controls.update();

  // Realidade aumentada: enquanto não estiver fixado, o produto é desenhado
  // ao vivo onde a câmera aponta — o cliente varre a sala e vê a peça
  // andando pelo chão junto com a mira, sem precisar tocar em nada.
  if (this.session && frame && this.hitSource) {
    const space = this.renderer.xr.getReferenceSpace();
    const hits = frame.getHitTestResults(this.hitSource);
    if (hits.length) {
      const pose = hits[0].getPose(space);
      this._ultimoHit = pose.transform.matrix;
      this.reticulo.matrix.fromArray(pose.transform.matrix);
      this.reticulo.visible = !this.colocado;

      if (!this.colocado) {
        _v1.setFromMatrixPosition(this.reticulo.matrix);
        if (this.objeto.visible) {
          // Suaviza: o hit-test treme alguns milímetros por quadro e o
          // produto ficaria vibrando se seguisse a leitura crua
          this.objeto.position.lerp(_v1, 0.25);
        } else {
          this.objeto.position.copy(_v1);
          this.objeto.visible = true;
          // Só na primeira aparição vira de frente para quem olha; depois
          // fica parado, senão a peça giraria enquanto o cliente anda
          _v2.setFromMatrixPosition(this.camera.matrixWorld);
          this.objeto.rotation.y = Math.atan2(_v2.x - _v1.x, _v2.z - _v1.z) + this.giroExtra;
        }
      }
    } else {
      this.reticulo.visible = false;
      if (!this.colocado) this.objeto.visible = false;
    }
  }

  this.renderer.render(this.scene, this.camera);
};

// ------------------------------------------------------------
//  Modos
// ------------------------------------------------------------

Viewer.prototype.trocarModo = function (modo) {
  const self = this;
  if (!this.renderer) return;
  if (modo === this.modo && this._modoPronto) return;

  // Sai do modo anterior
  if (this.session) { try { this.session.end(); } catch (e) {} return; }  // o 'end' recoloca no modo sala
  this._pararCamera();
  this._desligarBussola();
  this.dom.stage.classList.remove('cam');
  this._removerArrasto();

  Object.keys(this.dom.abas).forEach(function (k) {
    self.dom.abas[k].classList.toggle('on', k === modo);
  });
  this.modo = modo;
  this._modoPronto = true;

  if (modo === 'sala') this._modoSala();
  else if (modo === 'ar') this._modoAR();
  else this._modoCamera();
};

// ---- 1) Na sala: cena montada, órbita livre ----
Viewer.prototype._modoSala = function () {
  const self = this;
  this._semMsg();
  this.scene.background = new THREE.Color(0x101014);
  this.sala.visible = true;
  this.objeto.visible = true;

  // Cabe na mesa? Então vai pra mesa. Senão, apoia no chão.
  const naMesa = this.dims.h <= 0.6 && this.dims.w <= 1.15 && this.dims.d <= 0.6;
  this.sala.userData.mesa.visible = naMesa;
  this.baseY = naMesa ? 0.75 : 0;

  this.objeto.position.set(0, this.baseY, 0);
  this.objeto.rotation.set(0, 0, 0);
  this.reticulo.visible = false;
  this.controls.enabled = true;
  this.resetarCamera();
  this.dom.hint.textContent = 'Arraste para girar · role para aproximar';

  // Ferramentas da sala
  const t = this.dom.tools;
  t.innerHTML = '';

  const lblParede = el('span', null, 'Parede:');
  t.appendChild(lblParede);
  const sw = el('div', 'arv-swatches');
  const cores = ['#e9e3d8', '#ffffff', '#c8d6d2', '#d9c3b0', '#b9c6da', '#3a3a3e'];
  cores.forEach(function (c, i) {
    const b = el('button', 'arv-sw' + (i === 0 ? ' on' : ''));
    b.style.background = c;
    b.title = 'Parede ' + c;
    b.setAttribute('aria-label', 'Cor de parede ' + c);
    b.onclick = function () {
      self.sala.userData.matParede.color.set(c);
      sw.querySelectorAll('.arv-sw').forEach(function (o) { o.classList.remove('on'); });
      b.classList.add('on');
    };
    sw.appendChild(b);
  });
  t.appendChild(sw);

  const lblPessoa = el('label');
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.checked = this.sala.userData.pessoa.visible;
  chk.onchange = function () { self.sala.userData.pessoa.visible = chk.checked; };
  lblPessoa.appendChild(chk);
  lblPessoa.appendChild(document.createTextNode('Pessoa de 1,70 m'));
  t.appendChild(lblPessoa);

  const lblGirar = el('label');
  lblGirar.appendChild(document.createTextNode('Girar'));
  const rng = document.createElement('input');
  rng.type = 'range'; rng.min = '0'; rng.max = '360'; rng.value = '0';
  rng.setAttribute('aria-label', 'Girar o produto');
  rng.oninput = function () { self.objeto.rotation.y = rng.value * Math.PI / 180; };
  lblGirar.appendChild(rng);
  t.appendChild(lblGirar);

  const reset = el('button', 'arv-mini arv-push', '↺ Centralizar');
  reset.onclick = function () { self.resetarCamera(); rng.value = '0'; self.objeto.rotation.y = 0; };
  t.appendChild(reset);
};

Viewer.prototype.resetarCamera = function () {
  const h = this.objeto.userData.altura || this.dims.h;
  const maior = Math.max(this.dims.w, h, this.dims.d);
  const base = this.baseY || 0;
  const alvoY = base + h * 0.5;

  // Enquadra o produto pelo campo de visão real da câmera, com uma folga
  // fixa. Assim uma caneca chega perto e um armário recua na mesma medida —
  // o produto ocupa sempre a mesma fatia da tela.
  const fov = this.camera.fov * Math.PI / 180;
  const dist = Math.max(0.75, (maior * 0.72) / Math.tan(fov / 2));

  // Ponto de vista de quem está em pé, um pouco acima do meio do produto
  this.camera.position.set(dist * 0.42, alvoY + Math.max(0.25, maior * 0.35), dist * 0.86);
  this.controls.target.set(0, alvoY, 0);
  this.controls.update();
};

// ---- 2) Realidade aumentada de verdade (WebXR) ----
Viewer.prototype._verificarSuporteAR = function () {
  const self = this;
  const aba = this.dom.abas.ar;
  if (!navigator.xr || !navigator.xr.isSessionSupported) {
    aba.disabled = true;
    aba.title = 'Seu navegador não tem realidade aumentada — use "Na minha câmera".';
    return;
  }
  navigator.xr.isSessionSupported('immersive-ar').then(function (ok) {
    self.arSuportado = !!ok;
    aba.disabled = !ok;
    aba.title = ok
      ? 'Ver o produto no tamanho real, na sua casa'
      : 'Este aparelho não tem realidade aumentada — use "Na minha câmera".';
  }).catch(function () { aba.disabled = true; });
};

Viewer.prototype._modoAR = async function () {
  const self = this;
  const t = this.dom.tools;
  t.innerHTML = '';

  if (!this.arSuportado) {
    this._msgErro('Realidade aumentada indisponível neste aparelho.',
      'Use a aba "Na minha câmera" — ela funciona em qualquer celular.');
    return;
  }

  this._msgCarregando('Abrindo a câmera em realidade aumentada…');

  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'local-floor'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: this.dom.back }
    });
    if (this.destruido || this.modo !== 'ar') { session.end(); return; }
    this.session = session;
    this.colocado = false;
    this.objeto.visible = false;
    this.baseY = 0;
    this.sala.visible = false;
    this.scene.background = null;
    this.controls.enabled = false;
    this.dom.back.classList.add('xr');
    this.giroExtra = 0;
    this.dom.xrGirar.style.display = '';
    this.dom.xrTxt.textContent = 'Aponte para o chão — toque para fixar';

    await this.renderer.xr.setSession(session);

    const viewerSpace = await session.requestReferenceSpace('viewer');
    this.hitSource = await session.requestHitTestSource({ space: viewerSpace });

    // O toque agora só alterna entre "seguir a mira" e "ficar parado aqui"
    session.addEventListener('select', function () {
      if (!self.colocado) {
        if (!self.objeto.visible) return;         // ainda não achou o chão
        self.colocado = true;
        self.reticulo.visible = false;
        self.dom.xrTxt.textContent = 'Fixado — toque para soltar de novo';
      } else {
        self.colocado = false;
        self.dom.xrTxt.textContent = 'Aponte para o chão — toque para fixar';
      }
    });

    session.addEventListener('end', function () { self._encerrarAR(); });
    this._semMsg();
  } catch (e) {
    console.warn('[ARViewer] AR não iniciou:', e);
    this.session = null;
    this._msgErro('Não consegui abrir a realidade aumentada.',
      'Autorize o uso da câmera ou use a aba "Na minha câmera".');
  }
};

Viewer.prototype._encerrarAR = function () {
  if (this.hitSource) { try { this.hitSource.cancel(); } catch (e) {} }
  this.hitSource = null;
  this._ultimoHit = null;
  this.session = null;
  this.dom.back.classList.remove('xr');
  if (this.dom.xrGirar) this.dom.xrGirar.style.display = 'none';
  if (this.destruido) return;
  this._modoPronto = false;
  this.trocarModo('sala');
  if (this._onResize) this._onResize();
};

// ---- 3) Na câmera do aparelho (funciona em iPhone e no notebook) ----
Viewer.prototype._modoCamera = async function () {
  const self = this;
  const t = this.dom.tools;
  t.innerHTML = '';
  this._msgCarregando('Ligando a câmera…');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    this._msgErro('Câmera indisponível.', 'Use a aba "Na sala" para ver o tamanho do produto.');
    return;
  }

  try {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
      audio: false
    });
  } catch (e) {
    this._msgErro('Não consegui acessar a câmera.',
      'Autorize a câmera no navegador (o site precisa estar em HTTPS).');
    return;
  }
  // A permissão pode demorar; se nesse meio-tempo o cliente fechou ou trocou
  // de aba, devolvemos a câmera em vez de deixar a luzinha acesa
  if (this.destruido || this.modo !== 'foto') { this._pararCamera(); return; }

  this.dom.video.srcObject = this.stream;
  // Não dá para esperar o play(): há navegador em que a promessa só resolve
  // depois que o vídeo aparece na tela, e o cliente ficaria preso no
  // "Ligando a câmera…" para sempre. Disparamos e seguimos.
  const tocando = this.dom.video.play();
  if (tocando && tocando.catch) tocando.catch(function () {});
  this.dom.stage.classList.add('cam');

  // Cena passa a ser transparente: só o objeto sobre o vídeo
  this.scene.background = null;
  this.sala.visible = false;
  this.reticulo.visible = false;
  this.objeto.visible = true;
  this.controls.enabled = false;
  this._semMsg();
  this.dom.hint.textContent = 'Arraste o produto para posicionar no seu ambiente';

  // Câmera na altura dos olhos, olhando um pouco para baixo — é o
  // enquadramento de quem segura o celular apontando para o chão
  this.baseY = 0;
  this.alturaCam = 1.35;
  this.objeto.position.set(0, 0, -2);
  this.objeto.rotation.set(0, 0, 0);
  this._recolocarCameraFoto();

  // ---- ferramentas do modo câmera ----
  const lblGirar = el('label');
  lblGirar.appendChild(document.createTextNode('Girar'));
  const rGirar = document.createElement('input');
  rGirar.type = 'range'; rGirar.min = '0'; rGirar.max = '360'; rGirar.value = '0';
  rGirar.setAttribute('aria-label', 'Girar o produto');
  rGirar.oninput = function () { self.objeto.rotation.y = rGirar.value * Math.PI / 180; };
  lblGirar.appendChild(rGirar);
  t.appendChild(lblGirar);

  const lblAlt = el('label');
  lblAlt.appendChild(document.createTextNode('Altura da câmera'));
  const rAlt = document.createElement('input');
  rAlt.type = 'range'; rAlt.min = '40'; rAlt.max = '180'; rAlt.value = '135';
  rAlt.setAttribute('aria-label', 'Altura da câmera em centímetros');
  const vAlt = el('span', null, '1,35 m');
  rAlt.oninput = function () {
    self.alturaCam = rAlt.value / 100;
    vAlt.textContent = (self.alturaCam).toFixed(2).replace('.', ',') + ' m';
    self._recolocarCameraFoto();
  };
  lblAlt.appendChild(rAlt);
  lblAlt.appendChild(vAlt);
  t.appendChild(lblAlt);

  // Ancorar no ambiente: só aparece se o aparelho tiver sensor de orientação
  if (window.DeviceOrientationEvent) {
    const btnBussola = el('button', 'arv-mini', '🧭 Ancorar no ambiente');
    btnBussola.title = 'O produto fica parado na sala e a imagem acompanha o giro do celular';
    btnBussola.onclick = async function () {
      if (self.bussola) {
        self._desligarBussola();
        btnBussola.classList.remove('pri');
        self.dom.hint.textContent = 'Arraste o produto para posicionar no seu ambiente';
        return;
      }
      btnBussola.disabled = true;
      const ok = await self._ligarBussola();
      btnBussola.disabled = false;
      if (ok) {
        btnBussola.classList.add('pri');
        self.dom.hint.textContent = 'Gire o celular — o produto fica parado no lugar';
      }
    };
    t.appendChild(btnBussola);
    this.dom.btnBussola = btnBussola;
  }

  const btnFoto = el('button', 'arv-mini pri arv-push', '📸 Salvar foto');
  btnFoto.onclick = function () { self.salvarFoto(); };
  t.appendChild(btnFoto);

  this._ligarArrasto();
};

// Mantém a câmera na altura escolhida, mirando a base do objeto.
// Com a bússola ligada quem manda na direção é o giroscópio: aqui só
// reposicionamos e guardamos a nova orientação de referência.
Viewer.prototype._recolocarCameraFoto = function () {
  this.camera.position.set(0, this.alturaCam, 0);
  this.camera.lookAt(this.objeto.position.x, this.objeto.userData.altura * 0.4, this.objeto.position.z);
  this.camera.updateMatrixWorld();
  if (this.bussola) {
    this.qBase.copy(this.camera.quaternion);
    this.qRef = null;                    // recalibra no próximo evento
  }
};

// ------------------------------------------------------------
//  BÚSSOLA — ancorar o produto no ambiente sem WebXR
//  O iPhone não tem WebXR, então aqui fazemos o possível: o produto
//  fica parado num ponto do mundo e a CÂMERA gira junto com o
//  aparelho. Não há rastreio de posição (andar não aproxima), mas
//  girar o celular já dá a sensação de que a peça está na sala.
// ------------------------------------------------------------

// Converte alpha/beta/gamma do navegador na orientação da câmera.
// Fórmula do antigo DeviceOrientationControls do three.js.
const _zee = { x: 0, y: 0, z: 1 };
function orientacaoParaQuaternion(q, alpha, beta, gamma, orient) {
  const euler = new THREE.Euler();
  const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° em X
  const q0 = new THREE.Quaternion();
  euler.set(beta, alpha, -gamma, 'YXZ');       // o navegador usa Z-X'-Y''
  q.setFromEuler(euler);
  q.multiply(q1);                              // olhar da tela → olhar do mundo
  q.multiply(q0.setFromAxisAngle(new THREE.Vector3(_zee.x, _zee.y, _zee.z), -orient));
}

Viewer.prototype._ligarBussola = async function () {
  const self = this;

  // iOS 13+ exige pedido explícito, e só dentro de um gesto do usuário
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) {
    this.dom.hint.textContent = 'Este aparelho não tem sensor de orientação.';
    return false;
  }
  if (typeof DOE.requestPermission === 'function') {
    let resp;
    try { resp = await DOE.requestPermission(); } catch (e) { resp = 'denied'; }
    if (resp !== 'granted') {
      this.dom.hint.textContent = 'Permissão de movimento negada — arraste o produto para posicionar.';
      return false;
    }
  }

  this.bussola = true;
  this.qBase = new THREE.Quaternion().copy(this.camera.quaternion);
  this.qRef = null;
  this.qDisp = new THREE.Quaternion();
  this.qDelta = new THREE.Quaternion();

  let vazio = true;
  this._onOrient = function (ev) {
    if (ev.alpha == null && ev.beta == null && ev.gamma == null) return;
    vazio = false;
    const orient = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    orientacaoParaQuaternion(
      self.qDisp,
      (ev.alpha || 0) * Math.PI / 180,
      (ev.beta || 0) * Math.PI / 180,
      (ev.gamma || 0) * Math.PI / 180,
      orient * Math.PI / 180
    );
    // A primeira leitura vira o zero: assim o produto continua exatamente
    // onde o cliente já estava vendo, sem pular ao ligar a bússola
    if (!self.qRef) { self.qRef = self.qDisp.clone().invert(); return; }
    self.qDelta.copy(self.qDisp).multiply(self.qRef);
    self.camera.quaternion.copy(self.qDelta).multiply(self.qBase);
  };
  window.addEventListener('deviceorientation', this._onOrient, true);

  // Sem sensor o evento nunca chega; avisa em vez de deixar o cliente
  // achando que travou. 3 s porque em celular fraco a primeira leitura
  // demora — cortar em 1,5 s dava alarme falso.
  this._tmBussola = setTimeout(function () {
    if (vazio && self.bussola) {
      self._desligarBussola();
      self.dom.hint.textContent = 'Não recebi dados do sensor — arraste o produto para posicionar.';
      if (self.dom.btnBussola) self.dom.btnBussola.classList.remove('pri');
    }
  }, 3000);

  return true;
};

Viewer.prototype._desligarBussola = function () {
  if (this._tmBussola) { clearTimeout(this._tmBussola); this._tmBussola = null; }
  if (this._onOrient) {
    window.removeEventListener('deviceorientation', this._onOrient, true);
    this._onOrient = null;
  }
  this.bussola = false;
  this.qRef = null;
  if (this.modo === 'foto' && !this.destruido) this._recolocarCameraFoto();
};

// Arrastar = mover o produto pelo chão (plano y = 0) sob o dedo
Viewer.prototype._ligarArrasto = function () {
  const self = this;
  const cv = this.renderer.domElement;
  const ray = new THREE.Raycaster();
  const plano = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ponto = new THREE.Vector3();
  let arrastando = false;

  function ndc(ev) {
    const r = cv.getBoundingClientRect();
    return new THREE.Vector2(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1
    );
  }
  function mover(ev) {
    ray.setFromCamera(ndc(ev), self.camera);
    if (!ray.ray.intersectPlane(plano, ponto)) return;
    // Trava a distância num intervalo plausível de sala
    const dist = Math.hypot(ponto.x, ponto.z);
    if (dist > 8) ponto.multiplyScalar(8 / dist);
    if (dist < 0.3) return;
    self.objeto.position.set(ponto.x, 0, ponto.z);
    self._recolocarCameraFoto();
  }

  this._dragHandlers = {
    down: function (ev) { arrastando = true; cv.setPointerCapture(ev.pointerId); mover(ev); },
    move: function (ev) { if (arrastando) mover(ev); },
    up:   function (ev) { arrastando = false; try { cv.releasePointerCapture(ev.pointerId); } catch (e) {} }
  };
  cv.addEventListener('pointerdown', this._dragHandlers.down);
  cv.addEventListener('pointermove', this._dragHandlers.move);
  cv.addEventListener('pointerup', this._dragHandlers.up);
  cv.addEventListener('pointercancel', this._dragHandlers.up);
};

Viewer.prototype._removerArrasto = function () {
  if (!this._dragHandlers || !this.renderer) return;
  const cv = this.renderer.domElement;
  cv.removeEventListener('pointerdown', this._dragHandlers.down);
  cv.removeEventListener('pointermove', this._dragHandlers.move);
  cv.removeEventListener('pointerup', this._dragHandlers.up);
  cv.removeEventListener('pointercancel', this._dragHandlers.up);
  this._dragHandlers = null;
};

// Junta o vídeo da câmera com o render e baixa um PNG
Viewer.prototype.salvarFoto = function () {
  const v = this.dom.video, gl = this.renderer.domElement;
  const w = gl.width, h = gl.height;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');

  // O vídeo entra em "cover", igual ao CSS do palco
  if (v.videoWidth) {
    const s = Math.max(w / v.videoWidth, h / v.videoHeight);
    const dw = v.videoWidth * s, dh = v.videoHeight * s;
    ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  }
  this.renderer.render(this.scene, this.camera);   // garante o buffer cheio
  ctx.drawImage(gl, 0, 0, w, h);

  const nome = (this.produto.nome || 'produto').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
  const a = document.createElement('a');
  a.download = nome.toLowerCase() + '-no-meu-espaco.png';
  a.href = cv.toDataURL('image/png');
  a.click();
  if (typeof window.toast === 'function') window.toast('Foto salva!');
};

Viewer.prototype._pararCamera = function () {
  if (this.stream) {
    this.stream.getTracks().forEach(function (t) { t.stop(); });
    this.stream = null;
  }
  if (this.dom && this.dom.video) this.dom.video.srcObject = null;
};

// ------------------------------------------------------------
//  Fechar e limpar
// ------------------------------------------------------------

Viewer.prototype.fechar = function () {
  if (this.destruido) return;
  this.destruido = true;

  if (this.session) { try { this.session.end(); } catch (e) {} }
  this._pararCamera();
  this._desligarBussola();
  this._removerArrasto();

  document.removeEventListener('keydown', this._onKey);
  if (this._onResize) window.removeEventListener('resize', this._onResize);
  if (this._ro) this._ro.disconnect();

  if (this.renderer) {
    this.renderer.setAnimationLoop(null);
    // Libera geometrias, materiais e texturas — sem isso a memória de
    // vídeo vaza a cada produto que o cliente abre
    if (this.scene) {
      this.scene.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        mats.forEach(function (m) {
          Object.keys(m).forEach(function (k) {
            const v = m[k];
            if (v && v.isTexture) v.dispose();
          });
          m.dispose();
        });
      });
    }
    this.renderer.dispose();
    if (this.renderer.forceContextLoss) this.renderer.forceContextLoss();
  }

  document.body.classList.remove('arv-aberto');
  if (this.dom && this.dom.back && this.dom.back.parentNode) {
    this.dom.back.parentNode.removeChild(this.dom.back);
  }
  if (ativo === this) ativo = null;
};

// ============================================================
//  API PÚBLICA
// ============================================================

const ARViewer = {
  // Abre o visualizador para um objeto de produto já carregado
  open: function (produto) {
    if (!produto) return null;
    injetarCSS();
    if (ativo) ativo.fechar();
    ativo = new Viewer(produto);
    ativo.iniciar();
    return ativo;
  },

  // Atalho para as telas que guardam os produtos em window._productsMap
  openById: function (id) {
    const mapa = window._productsMap || {};
    const p = mapa[id];
    if (!p) {
      if (typeof window.toast === 'function') window.toast('Produto não encontrado.', 'error');
      return null;
    }
    return this.open(p);
  },

  fechar: function () { if (ativo) ativo.fechar(); },

  // WebGL disponível? É o mínimo para mostrar o botão na vitrine
  suportado: function () {
    try {
      const cv = document.createElement('canvas');
      return !!(window.WebGLRenderingContext &&
        (cv.getContext('webgl2') || cv.getContext('webgl')));
    } catch (e) { return false; }
  }
};

window.ARViewer = ARViewer;
})();
