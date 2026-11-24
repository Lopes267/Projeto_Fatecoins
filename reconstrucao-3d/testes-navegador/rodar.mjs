// Testes no navegador (Chrome headless, protocolo DevTools direto, sem Puppeteer).
//
//   node testes-navegador/rodar.mjs [pasta-para-fotos]      (de dentro de reconstrucao-3d)
//
// Sobe o servidor Python numa porta de teste com uma pasta de sessões
// temporária e confere:
//   1. /captura num celular SEM Depth API: a página diz isso claramente;
//   2. /captura com WebXR falso (parede a 1 m): o código real da página manda
//      os quadros, o servidor lê as matrizes certas e a parede sai em z = -1;
//   3. visualizador recebendo a caneca sintética ao vivo;
//   4. o .glb da caneca dentro do ar-viewer.js do site, no tamanho real.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(RAIZ, '.venv', 'Scripts', 'python.exe');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORTA = 8790, CDP = 9341;
const TEMP = mkdtempSync(path.join(tmpdir(), 'rec3d-'));
const FOTOS = path.resolve(process.argv[2] || path.join(TEMP, 'fotos'));
mkdirSync(FOTOS, { recursive: true });
const BASE = `http://localhost:${PORTA}`;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const resultados = [];
function conferir(nome, ok, detalhe) {
  resultados.push({ nome, ok: !!ok });
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}

// ---------- processos ----------
const servidor = spawn(PY, ['-m', 'backend.servidor'], {
  cwd: RAIZ, env: { ...process.env, PORTA: String(PORTA), RECONSTRUCAO_SESSOES: path.join(TEMP, 'sessoes') },
  stdio: ['ignore', 'ignore', 'pipe']
});
let logServidor = '';
servidor.stderr.on('data', (d) => { logServidor += d; });

async function aguardarHttp(url, ms = 30000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    try { const r = await fetch(url); if (r.ok) return; } catch (e) { /* ainda subindo */ }
    await esperar(200);
  }
  throw new Error('não respondeu: ' + url);
}

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${path.join(TEMP, 'chrome')}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

// ---------- DevTools ----------
class Aba {
  static async nova() {
    const r = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' });
    const alvo = await r.json();
    const a = new Aba(alvo);
    await a.abrir();
    return a;
  }
  constructor(alvo) { this.alvo = alvo; this.id = 0; this.pend = new Map(); this.console = []; }
  abrir() {
    return new Promise((ok) => {
      this.ws = new WebSocket(this.alvo.webSocketDebuggerUrl);
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pend.has(m.id)) { this.pend.get(m.id)(m); this.pend.delete(m.id); }
        else if (m.method === 'Runtime.exceptionThrown') this.console.push('EXCEÇÃO ' + m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
        else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.console.push('console.error ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
      };
      this.ws.onopen = async () => { await this.cmd('Runtime.enable'); await this.cmd('Page.enable'); ok(); };
    });
  }
  cmd(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok) => { this.pend.set(id, ok); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async avaliar(expr, gesto = false) {
    const r = await this.cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: gesto });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'erro ao avaliar');
    return r.result?.result?.value;
  }
  async ir(url) { await this.cmd('Page.navigate', { url }); await esperar(300); }
  async aguardar(expr, ms = 30000) {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
      try { if (await this.avaliar(`!!(${expr})`)) return true; } catch (e) { /* página carregando */ }
      await esperar(150);
    }
    return false;
  }
  async foto(nome, largura = 1280, altura = 800) {
    await this.cmd('Emulation.setDeviceMetricsOverride', { width: largura, height: altura, deviceScaleFactor: 1, mobile: false });
    await esperar(600);
    const r = await this.cmd('Page.captureScreenshot', { format: 'png' });
    const arq = path.join(FOTOS, nome);
    writeFileSync(arq, Buffer.from(r.result.data, 'base64'));
    return arq;
  }
}

// ---------- GLB mínimo (para conferir a parede) ----------
function lerGlb(buf) {
  const dv = new DataView(buf);
  const tamJs = dv.getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, tamJs)));
  const bin = 20 + tamJs + 8;
  const ac = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
  const bv = gltf.bufferViews[ac.bufferView];
  return { gltf, pos: new Float32Array(buf, bin + bv.byteOffset, ac.count * 3) };
}

async function principal() {
  await aguardarHttp(`${BASE}/`);
  await aguardarHttp(`http://127.0.0.1:${CDP}/json/version`);
  const falso = readFileSync(path.join(RAIZ, 'testes-navegador', 'xr-falso.js'), 'utf8');

  // 1. celular sem Depth API
  {
    const a = await Aba.nova();
    await a.cmd('Page.addScriptToEvaluateOnNewDocument', { source: falso });
    await a.ir(`${BASE}/captura?falso=sem-profundidade`);
    await a.aguardar(`!document.getElementById('comecar').disabled`, 10000);
    await a.avaliar(`document.getElementById('comecar').click()`, true);
    await a.aguardar(`window.__captura.fase === 'erro'`, 10000);
    const erro = await a.avaliar(`document.getElementById('erro').textContent`);
    conferir('sem Depth API: a página avisa', /profundidade \(Depth API\)/.test(erro || ''), erro);
    await a.cmd('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
    await a.foto('captura-sem-profundidade.png', 412, 915);
  }

  // 2. WebXR falso com parede a 1 m
  let quadrosParede = 0;
  {
    const a = await Aba.nova();
    await a.cmd('Page.addScriptToEvaluateOnNewDocument', { source: falso });
    await a.ir(`${BASE}/captura`);
    const pronto = await a.aguardar(`!document.getElementById('comecar').disabled`, 10000);
    conferir('verificação do aparelho libera o botão', pronto);
    await a.avaliar(`document.getElementById('comecar').click()`, true);
    await a.aguardar(`window.__captura.enviados >= 25`, 30000);
    await a.avaliar(`document.getElementById('finalizar').click()`, true);
    const ok = await a.aguardar(`window.__captura.fase === 'pronto'`, 60000);
    const E = await a.avaliar(`window.__captura`);
    const pedidos = await a.avaliar(`window.__xrPedidos`);
    quadrosParede = E.enviados;
    conferir('captura termina com modelo', ok && E.pronto && E.pronto.ok, JSON.stringify(E.pronto && E.pronto.medidas_cm));
    conferir('pede depth-sensing na CPU', pedidos[0]?.opcoes?.requiredFeatures?.includes('depth-sensing') &&
      pedidos[0]?.opcoes?.depthSensing?.usagePreference?.[0] === 'cpu-optimized');
    conferir('Chrome antigo: refaz o pedido sem unsigned-short', pedidos.length === 2 &&
      !pedidos[1].opcoes.depthSensing.dataFormatPreference.includes('unsigned-short'), `${pedidos.length} pedidos`);
    const est = E.pronto?.estado || {};
    conferir('servidor leu tudo o que a página mandou', est.recebidos === E.enviados && est.invalidos === 0,
      `${E.enviados} enviados, ${est.recebidos} recebidos, ${est.invalidos} inválidos, ${est.integrados} integrados, ` +
      `${est.descartados} descartados, recusados ${JSON.stringify(est.recusados)}, fusão ${est.integracao_ms} ms`);
    conferir('fusão acompanha o ritmo do celular (5 quadros/s)', est.integrados >= 0.8 * est.recebidos,
      `${est.integrados} de ${est.recebidos}`);
    conferir('sondas do navegador batem com a leitura do servidor', est.sondas?.batem === true && est.sondas?.inverter_y === false,
      JSON.stringify(est.sondas));
    if (E.pronto?.ok) {
      const buf = await (await fetch(BASE + E.pronto.arquivos.glb)).arrayBuffer();
      const { gltf, pos } = lerGlb(buf);
      const Mm = gltf.nodes[0].extras.mundoDoModelo;   // ordem de coluna
      let fora = 0, xmin = 1e9, xmax = -1e9, ymin = 1e9, ymax = -1e9;
      const n = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
        const wx = Mm[0] * x + Mm[4] * y + Mm[8] * z + Mm[12];
        const wy = Mm[1] * x + Mm[5] * y + Mm[9] * z + Mm[13];
        const wz = Mm[2] * x + Mm[6] * y + Mm[10] * z + Mm[14];
        if (Math.abs(wz + 1) > 0.003) fora++;
        xmin = Math.min(xmin, wx); xmax = Math.max(xmax, wx); ymin = Math.min(ymin, wy); ymax = Math.max(ymax, wy);
      }
      conferir('parede reconstruída em z = -1 m (±3 mm)', fora / n < 0.01,
        `${n} vértices, ${(100 * fora / n).toFixed(2)}% fora; ${((xmax - xmin) * 100).toFixed(0)} x ${((ymax - ymin) * 100).toFixed(0)} cm`);
      conferir('região de interesse recorta a parede (disco ~50 cm)', xmax - xmin > 0.4 && xmax - xmin < 0.52,
        `${((xmax - xmin) * 100).toFixed(1)} cm`);
    }
    conferir('página de captura sem erros de JS', a.console.length === 0, a.console.join(' | '));
  }

  // 3 e 4. caneca sintética: visualizador ao vivo e ar-viewer do site
  {
    const v = await Aba.nova();
    await v.ir(`${BASE}/`);
    await v.aguardar(`window.__visualizador`, 15000);
    const envio = spawn(PY, ['-m', 'backend.sintetico.enviar', `ws://127.0.0.1:${PORTA}`], { cwd: RAIZ });
    let saida = '', erroEnvio = '';
    envio.stdout.on('data', (d) => { saida += d; });
    envio.stderr.on('data', (d) => { erroEnvio += d; });
    // 'close' (e não 'exit'): só dispara depois de a saída inteira ter sido lida
    const terminou = new Promise((ok) => envio.on('close', ok));
    await v.aguardar(`window.__visualizador.malhas >= 2`, 60000);
    const meio = await v.foto('visualizador-durante.png');
    await terminou;
    if (!saida.trim()) throw new Error('o envio da caneca não devolveu resultado: ' + erroEnvio.slice(-1500));
    const pronto = JSON.parse(saida.trim().split('\n').pop());
    await v.aguardar(`window.__visualizador.pronto`, 30000);
    const est = await v.avaliar(`window.__visualizador`);
    conferir('visualizador recebe a malha ao vivo', est.malhas >= 3, `${est.malhas} atualizações, última ${JSON.stringify(est.ultimaMalha)}`);
    conferir('visualizador mostra o resultado e os downloads', est.pronto?.ok &&
      await v.avaliar(`document.querySelectorAll('#downloads a').length === 4`));
    conferir('visualizador sem erros de JS', est.erros.length === 0 && v.console.length === 0,
      [...est.erros, ...v.console].join(' | '));
    const fim = await v.foto('visualizador-fim.png');

    const a = await Aba.nova();
    await a.ir(`${BASE}/teste/ar-viewer?glb=${encodeURIComponent(pronto.arquivos.glb)}`);
    await a.aguardar(`window.__arv && window.__arv.pronto`, 30000);
    const arv = await a.avaliar(`window.__arv`);
    const m = pronto.medidas_cm;
    const d = arv.dimsModelo || {};
    const perto = (x, cm) => Math.abs(x * 100 - cm) <= 0.2;
    conferir('ar-viewer do site carrega o .glb (tipo glb)', arv.tipo === 'glb', arv.tipo);
    conferir('ar-viewer usa o tamanho real, não as medidas da embalagem (30 cm)',
      perto(d.w, m.largura) && perto(d.h, m.altura) && perto(d.d, m.profundidade),
      `viewer ${(d.w * 100).toFixed(1)} x ${(d.h * 100).toFixed(1)} x ${(d.d * 100).toFixed(1)} cm; modelo ${m.largura} x ${m.altura} x ${m.profundidade}`);
    conferir('ar-viewer sem erros de JS', a.console.length === 0, a.console.join(' | '));
    const foto = await a.foto('ar-viewer.png');
    console.log('\nFotos:', [meio, fim, foto].join('\n       '));
  }
  console.log(`\nquadros da parede: ${quadrosParede}`);
}

let codigo = 0;
try {
  await principal();
} catch (e) {
  console.log('ERRO', e.stack || e);
  console.log('log do servidor:\n' + logServidor.slice(-3000));
  codigo = 2;
} finally {
  try {
    const v = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((ok) => { ws.onopen = ok; setTimeout(ok, 1000); });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await esperar(500);
  } catch (e) { /* já fechou */ }
  chrome.kill();
  servidor.kill();
  await esperar(500);
  try { rmSync(path.join(TEMP, 'chrome'), { recursive: true, force: true }); } catch (e) { /* arquivo preso */ }
  const falhas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - falhas} de ${resultados.length} conferências passaram`);
  process.exit(codigo || (falhas ? 1 : 0));
}
