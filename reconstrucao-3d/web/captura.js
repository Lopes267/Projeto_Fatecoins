// Página do celular: faz o papel do aplicativo Android da especificação.
// O Chrome do Android expõe o ARCore pelo WebXR: pose da câmera (rastreamento),
// mapa de profundidade (Depth API, recurso 'depth-sensing') e, se o aparelho
// liberar, a imagem da câmera ('camera-access'). Cada quadro vai cru por
// WebSocket — formato descrito em backend/reconstrucao/quadro.py.
//
// Regras do WebXR: só abre em página segura (localhost ou HTTPS) e a sessão
// só começa com um toque do usuário.
(function () {
  'use strict';

  const CFG = {
    intervaloMs: 200,           // até 5 quadros/s para o computador
    limiteBuffer: 1.5e6,        // bytes na fila do WebSocket antes de pular quadro
    larguraCor: 180             // imagem da câmera reduzida (a altura segue a vista)
  };
  const SONDAS = [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]];
  const DICAS = {
    'sem alvo no centro': 'Aponte a mira para o objeto',
    'pouca profundidade': 'Sem medida: chegue a 30–60 cm',
    'objeto fora da tela': 'O objeto saiu da tela'
  };

  const el = (id) => document.getElementById(id);
  const E = {                   // estado (window.__captura, para os testes)
    fase: 'inicio', enviados: 0, pulados: 0, servidor: null, pronto: null, erro: null,
    formato: null, uso: null, cor: false
  };
  window.__captura = E;

  let ws = null, xr = null, espaco = null, gl = null, binding = null, copiador = null;
  let capturando = false, enviando = false, ultimoEnvio = -1e9, n = 0;

  // ---------- verificação do aparelho ----------
  function item(texto, ok) {
    const li = document.createElement('li');
    li.className = ok ? 'ok' : 'ruim';
    li.textContent = (ok ? '✓ ' : '✗ ') + texto;
    return li;
  }

  async function verificar() {
    const lista = el('verificacao');
    lista.innerHTML = '';
    const seguro = window.isSecureContext;
    lista.appendChild(item(seguro ? 'Página segura (localhost)' :
      'Página não segura: abra por http://localhost:8000/captura com o cabo (adb reverse)', seguro));
    const temXR = !!navigator.xr;
    lista.appendChild(item(temXR ? 'Navegador com WebXR' :
      'Sem WebXR: use o Chrome do Android', temXR));
    if (!seguro || !temXR) return;
    let ar = false;
    try { ar = await navigator.xr.isSessionSupported('immersive-ar'); } catch (e) { /* segue falso */ }
    lista.appendChild(item(ar ? 'Realidade aumentada (ARCore) disponível' :
      'Sem realidade aumentada: instale/atualize o "Google Play Services for AR"', ar));
    if (!ar) return;
    lista.appendChild(item('A profundidade (Depth API) é conferida ao tocar em Começar', true));
    el('comecar').disabled = false;
  }

  // ---------- WebSocket ----------
  function conectar() {
    return new Promise((ok, falha) => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/captura`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ok();
      ws.onerror = () => falha(new Error('não consegui falar com o computador'));
      ws.onclose = () => { if (E.fase === 'capturando') status('Conexão com o computador caiu'); };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        const m = JSON.parse(ev.data);
        if (m.tipo === 'estado') mostrarEstado(m);
        else if (m.tipo === 'pronto') concluir(m);
      };
    });
  }

  function mostrarEstado(m) {
    E.servidor = m;
    el('numeros').textContent =
      `${m.integrados} integrados · ${m.descartados} descartados · ${m.latencia_ms ?? '–'} ms`;
    const motivos = Object.entries(m.recusados || {}).sort((a, b) => b[1] - a[1]);
    if (m.sondas && m.sondas.batem === false) status('Aviso: leitura da profundidade não confere');
    else if (m.integrados === 0 && motivos.length) status(DICAS[motivos[0][0]] || motivos[0][0]);
    else if (capturando) status('Capturando — dê a volta devagar');
  }

  function status(t) { el('status').textContent = t; }

  // ---------- sessão WebXR ----------
  async function pedirSessao() {
    const base = {
      requiredFeatures: ['depth-sensing', 'local'],
      optionalFeatures: ['camera-access', 'dom-overlay'],
      domOverlay: { root: el('sobreposicao') }
    };
    // 'unsigned-short' é o nome novo de 'luminance-alpha'; Chrome antigo não
    // conhece e recusa a lista inteira com TypeError, então tenta sem ele.
    const tentativas = [['unsigned-short', 'luminance-alpha', 'float32'], ['luminance-alpha', 'float32']];
    let ultimo = null;
    for (const formatos of tentativas) {
      try {
        return await navigator.xr.requestSession('immersive-ar', Object.assign({}, base, {
          depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: formatos }
        }));
      } catch (e) {
        ultimo = e;
        if (e.name !== 'TypeError') break;
      }
    }
    throw ultimo;
  }

  async function comecar() {
    el('erro').style.display = 'none';
    el('resultado').style.display = 'none';
    el('comecar').disabled = true;
    try {
      await conectar();
    } catch (e) {
      return falhar('Não consegui falar com o computador. O servidor está rodando e o adb reverse foi feito?');
    }
    try {
      xr = await pedirSessao();
    } catch (e) {
      ws.close();
      return falhar(e && e.name === 'NotSupportedError'
        ? 'Este celular não oferece profundidade (Depth API) pelo navegador. Sem ela não dá para reconstruir.'
        : `O navegador não abriu a câmera em AR: ${e && e.message ? e.message : e}`);
    }
    E.uso = xr.depthUsage;
    E.formato = xr.depthDataFormat;
    if (E.uso && E.uso !== 'cpu-optimized') {
      xr.end();
      return falhar('O celular só entrega a profundidade na GPU; esta captura precisa dela na CPU.');
    }

    const canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl2', { xrCompatible: true });
    if (!gl) gl = canvas.getContext('webgl', { xrCompatible: true });
    if (gl && gl.makeXRCompatible) {
      try { await gl.makeXRCompatible(); } catch (e) { /* o contexto já foi pedido como xrCompatible */ }
    }
    xr.updateRenderState({ baseLayer: new XRWebGLLayer(xr, gl) });
    espaco = await xr.requestReferenceSpace('local');
    try {
      if (window.XRWebGLBinding && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
        binding = new XRWebGLBinding(xr, gl);
      }
    } catch (e) { binding = null; }

    xr.addEventListener('end', aoTerminarXR);
    if (!xr.domOverlayState) {
      // Sem sobreposição não há botões: um toque na tela finaliza
      xr.addEventListener('select', () => { if (capturando) finalizar(); });
    }
    el('sobreposicao').style.display = 'block';
    status('Aponte a mira para o objeto');
    ws.send(JSON.stringify({ tipo: 'iniciar', raio: Number(el('tamanho').value), modo: 'tempo-real' }));
    capturando = true;
    E.fase = 'capturando';
    xr.requestAnimationFrame(aoQuadro);
  }

  // ---------- cada quadro ----------
  function aoQuadro(t, frame) {
    if (!xr) return;
    xr.requestAnimationFrame(aoQuadro);
    const camada = xr.renderState.baseLayer;
    if (gl && camada) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, camada.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    const pose = frame.getViewerPose(espaco);
    if (!pose) { status('Procurando o ambiente… mova o celular devagar'); return; }
    if (pose.emulatedPosition) { status('Rastreamento perdido: volte a mirar devagar'); return; }
    if (!capturando || enviando || t - ultimoEnvio < CFG.intervaloMs) return;
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > CFG.limiteBuffer) {
      E.pulados++;
      return;
    }
    const vista = pose.views[0];
    let info = null;
    try { info = frame.getDepthInformation(vista); } catch (e) { info = null; }
    if (!info || !info.data) return;
    ultimoEnvio = t;

    // Tudo do quadro é copiado AGORA: os buffers do WebXR só valem dentro do callback
    const cab = {
      tipo: 'quadro', n: n++, t: Math.round(t * 10) / 10,
      vista: {
        projecao: Array.from(vista.projectionMatrix),
        transformacao: Array.from(vista.transform.matrix)
      },
      profundidade: {
        largura: info.width, altura: info.height,
        formato: (E.formato === 'float32') ? 'float32' : 'uint16',
        paraMetros: info.rawValueToMeters,
        normDepthBufferFromNormView: Array.from(info.normDepthBufferFromNormView.matrix),
        sondas: SONDAS.map(([x, y]) => {
          let m = 0;
          try { m = info.getDepthInMeters(x, y); } catch (e) { m = 0; }
          return [x, y, m];
        })
      }
    };
    const prof = new Uint8Array(info.data.slice(0));
    const pixels = lerCamera(vista);
    if (gl && camada) gl.bindFramebuffer(gl.FRAMEBUFFER, camada.framebuffer);
    enviando = true;
    enviar(cab, prof, pixels)
      .catch((e) => { E.erro = String(e); })
      .finally(() => { enviando = false; });
  }

  // ---------- imagem da câmera (opcional) ----------
  function prepararCopiador(larg, alt) {
    const vs = `#version 300 es
      out vec2 uv;
      void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
                   uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
    const fs = `#version 300 es
      precision mediump float; in vec2 uv; uniform sampler2D img; out vec4 cor;
      void main(){ cor = texture(img, uv); }`;
    const sh = (tipo, src) => { const s = gl.createShader(tipo); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, larg, alt, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { prog, fbo, larg, alt, vao: gl.createVertexArray(), buf: new Uint8Array(larg * alt * 4),
             uImg: gl.getUniformLocation(prog, 'img') };
  }

  function lerCamera(vista) {
    if (!binding || !vista.camera) return null;
    try {
      const P = vista.projectionMatrix;
      const larg = CFG.larguraCor;
      const alt = Math.max(8, Math.round(larg * P[0] / P[5]));   // aspecto = P11 / P00
      if (!copiador || copiador.larg !== larg || copiador.alt !== alt) copiador = prepararCopiador(larg, alt);
      if (!copiador) return null;
      const tex = binding.getCameraImage(vista.camera);
      gl.bindFramebuffer(gl.FRAMEBUFFER, copiador.fbo);
      gl.viewport(0, 0, larg, alt);
      gl.useProgram(copiador.prog);
      gl.bindVertexArray(copiador.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(copiador.uImg, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, larg, alt, gl.RGBA, gl.UNSIGNED_BYTE, copiador.buf);
      gl.bindVertexArray(null);
      E.cor = true;
      return { larg, alt, rgba: copiador.buf.slice(0) };
    } catch (e) {
      binding = null;             // sem imagem: segue só com a profundidade
      return null;
    }
  }

  function jpeg({ larg, alt, rgba }) {
    const c = document.createElement('canvas');
    c.width = larg; c.height = alt;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(larg, alt);
    const linha = larg * 4;
    for (let y = 0; y < alt; y++) {          // readPixels vem de baixo para cima
      img.data.set(rgba.subarray((alt - 1 - y) * linha, (alt - y) * linha), y * linha);
    }
    ctx.putImageData(img, 0, 0);
    return new Promise((ok) => c.toBlob((b) => ok(b), 'image/jpeg', 0.75));
  }

  async function enviar(cab, prof, pixels) {
    let cor = null;
    if (pixels) {
      const blob = await jpeg(pixels);
      if (blob) {
        cor = new Uint8Array(await blob.arrayBuffer());
        cab.cor = { largura: pixels.larg, altura: pixels.alt, bytes: cor.length };
      }
    }
    if (!cor) cab.cor = null;
    const texto = new TextEncoder().encode(JSON.stringify(cab));
    const tam = new Uint8Array(4);
    new DataView(tam.buffer).setUint32(0, texto.length, true);
    const partes = [tam, texto, prof];
    if (cor) partes.push(cor);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(new Blob(partes));
      E.enviados++;
    }
  }

  // ---------- fim ----------
  function finalizar() {
    if (!capturando) return;
    capturando = false;
    E.fase = 'gerando';
    status('Gerando o modelo no computador…');
    el('finalizar').disabled = true;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ tipo: 'finalizar' }));
  }

  function concluir(r) {
    E.pronto = r;
    E.fase = 'pronto';
    if (xr) xr.end();
    const box = el('resultado');
    box.style.display = 'block';
    if (r.ok) {
      const m = r.medidas_cm;
      box.innerHTML = `<b>Modelo pronto.</b><p style="margin:6px 0 12px">${m.largura} × ${m.altura} × ${m.profundidade} cm,
        ${r.estado.integrados} quadros.</p>
        <a class="baixar" href="${r.arquivos.glb}" download>Baixar o modelo (.glb)</a>
        <p style="margin:10px 0 0;font-size:14px">Depois, no cadastro do produto, toque em <b>Enviar .glb</b>
        e escolha o arquivo baixado.</p>`;
    } else {
      box.innerHTML = `<b>Não deu para montar o modelo.</b><p style="margin:6px 0 0">${r.motivo}</p>`;
    }
  }

  function aoTerminarXR() {
    if (capturando) finalizar();     // o sistema encerrou a sessão (ex.: botão voltar)
    xr = null;
    el('sobreposicao').style.display = 'none';
    el('finalizar').disabled = false;
    el('comecar').disabled = false;
    if (E.fase === 'capturando') E.fase = 'gerando';
  }

  function falhar(msg) {
    E.erro = msg;
    E.fase = 'erro';
    const box = el('erro');
    box.textContent = msg;
    box.style.display = 'block';
    el('comecar').disabled = false;
  }

  el('comecar').addEventListener('click', comecar);
  el('finalizar').addEventListener('click', finalizar);
  el('cancelar').addEventListener('click', () => {
    capturando = false;
    E.fase = 'inicio';
    if (ws) ws.close();
    if (xr) xr.end();
  });
  verificar();
})();
