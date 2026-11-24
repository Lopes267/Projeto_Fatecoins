// Visualizador do computador. A ideia (Three.js + OrbitControls + WebSocket,
// malha recebida do servidor e trocada a cada atualização) vem do
// static/app.js do repositório akshaybahadur21/Objectron (MIT). Aqui a malha
// chega em binário e com cor por vértice, e mostramos também o caminho da
// câmera e a região de interesse.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const el = (id) => document.getElementById(id);
const estadoPagina = { malhas: 0, ultimaMalha: null, pronto: null, erros: [] };
window.__visualizador = estadoPagina;           // para os testes no navegador
window.addEventListener('error', (e) => estadoPagina.erros.push(String(e.message)));

// ---------- cena ----------
const palco = el('palco');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
palco.appendChild(renderer.domElement);

const cena = new THREE.Scene();
cena.background = new THREE.Color(0x111111);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 20);
camera.position.set(0.5, 0.45, 0.6);
const controles = new OrbitControls(camera, renderer.domElement);
controles.enableDamping = true;
controles.target.set(0, 0, 0);

cena.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.2));
const sol = new THREE.DirectionalLight(0xffffff, 1.4);
sol.position.set(1, 2, 1.5);
cena.add(sol);

const grade = new THREE.GridHelper(1, 20, 0x3a3a3a, 0x262626);
cena.add(grade);

let malha = null, trilha = null, esfera = null, alvoAjustado = false;
const material = new THREE.MeshStandardMaterial({
  vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
renderer.setAnimationLoop(() => { controles.update(); renderer.render(cena, camera); });

// ---------- malha binária (ver pacote_malha() em sessao.py) ----------
function lerMalha(buf) {
  const dv = new DataView(buf);
  const tam = dv.getUint32(0, true);
  const cab = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, tam)));
  let pos = 4 + tam;
  const V = new Float32Array(buf, pos, cab.nv * 3); pos += cab.nv * 12;
  const F = new Uint32Array(buf, pos, cab.nf * 3); pos += cab.nf * 12;
  const C = new Uint8Array(buf, pos, cab.nv * 3);
  return { cab, V, F, C };
}

function trocarMalha({ cab, V, F, C }) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(V, 3));
  // cor sRGB da câmera -> linear (o renderizador devolve para sRGB na tela)
  const lin = new Float32Array(C.length);
  for (let i = 0; i < C.length; i++) {
    const c = C[i] / 255;
    lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(lin, 3));
  geo.setIndex(new THREE.BufferAttribute(F, 1));
  geo.computeVertexNormals();
  if (malha) { cena.remove(malha); malha.geometry.dispose(); }
  malha = new THREE.Mesh(geo, material);
  cena.add(malha);

  if (cab.cameras && cab.cameras.length > 1) {
    const g = new THREE.BufferGeometry().setFromPoints(cab.cameras.map((p) => new THREE.Vector3(...p)));
    if (trilha) { cena.remove(trilha); trilha.geometry.dispose(); }
    trilha = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xe8854a }));
    cena.add(trilha);
  }
  if (cab.alvo) {
    if (!esfera) {
      esfera = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12),
        new THREE.MeshBasicMaterial({ color: 0x5b8bd8, wireframe: true, transparent: true, opacity: 0.12 }));
      cena.add(esfera);
    }
    esfera.position.set(...cab.alvo);
    esfera.scale.setScalar(cab.raio || 0.25);
    if (!alvoAjustado) {             // enquadra o objeto só na primeira vez
      controles.target.set(...cab.alvo);
      camera.position.set(cab.alvo[0] + 0.45, cab.alvo[1] + 0.35, cab.alvo[2] + 0.45);
      grade.position.y = cab.alvo[1] - 0.06;
      alvoAjustado = true;
    }
  }
  estadoPagina.malhas++;
  estadoPagina.ultimaMalha = { nv: cab.nv, nf: cab.nf };
}

// ---------- estado ----------
function marcar(id, ligado, texto) {
  el(id).innerHTML = `<i class="ponto${ligado ? ' on' : ''}"></i>${texto}`;
}

const DICAS = {
  'sem alvo no centro': 'Aponte o centro da tela do celular para o objeto.',
  'pouca profundidade': 'O sensor não está medindo: chegue mais perto (30–60 cm) e evite superfícies brilhantes.',
  'objeto fora da tela': 'O objeto saiu da tela: volte a enquadrá-lo.'
};

function mostrarEstado(e) {
  el('v-integrados').textContent = `${e.integrados} de ${e.recebidos}`;
  el('v-descartados').textContent = e.descartados + (e.invalidos ? ` · ${e.invalidos} inválidos` : '');
  el('v-latencia').textContent = e.latencia_ms == null ? '—' : `${e.latencia_ms} ms / ${e.integracao_ms} ms`;
  el('v-triangulos').textContent = e.triangulos ? e.triangulos.toLocaleString('pt-BR') : '—';
  const s = e.sondas || {};
  el('v-sondas').textContent = s.batem == null ? '—' : s.batem ? (s.inverter_y ? 'ok (y invertido)' : 'ok') : 'NÃO CONFERE';
  const aviso = el('aviso');
  const motivos = Object.entries(e.recusados || {}).sort((a, b) => b[1] - a[1]);
  const dica = s.batem === false
    ? 'A profundidade lida não bate com a do navegador: o modelo pode sair torto. Anote o modelo do celular.'
    : motivos.length && motivos[0][1] > e.integrados ? DICAS[motivos[0][0]] : (e.ultimo_erro || '');
  aviso.textContent = dica;
  aviso.style.display = dica ? 'block' : 'none';
}

function mostrarPronto(r) {
  estadoPagina.pronto = r;
  el('resultado').style.display = 'block';
  if (!r.ok) {
    el('v-medidas').textContent = r.motivo;
    el('downloads').innerHTML = '';
    return;
  }
  const m = r.medidas_cm;
  el('v-medidas').textContent = `${m.largura} × ${m.altura} × ${m.profundidade} cm`;
  const d = r.arquivos;
  el('downloads').innerHTML =
    `<a class="btn pri" href="${d.glb}" download>Baixar .glb</a>` +
    `<a class="btn" href="${d.obj}" download>.obj</a>` +
    `<a class="btn" href="${d.ply}" download>.ply</a>` +
    `<a class="btn" href="/teste/ar-viewer?glb=${encodeURIComponent(d.glb)}" target="_blank">Ver como o cliente</a>`;
}

// Online (HTTPS) o celular abre a página direto, sem cabo
if (!['localhost', '127.0.0.1'].includes(location.hostname)) {
  el('ajuda-local').hidden = true;
  el('ajuda-online').hidden = false;
  el('end-captura').textContent = `${location.origin}/captura`;
}

// ---------- WebSocket ----------
function conectar() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/visualizador`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => marcar('v-servidor', true, 'conectado');
  ws.onclose = () => { marcar('v-servidor', false, 'desconectado'); setTimeout(conectar, 2000); };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) { trocarMalha(lerMalha(ev.data)); return; }
    const m = JSON.parse(ev.data);
    if (m.tipo === 'ola' || m.tipo === 'celular') marcar('v-celular', m.celular ?? m.conectado,
      (m.celular ?? m.conectado) ? 'conectado' : 'aguardando');
    else if (m.tipo === 'estado') mostrarEstado(m);
    else if (m.tipo === 'pronto') mostrarPronto(m);
    else if (m.tipo === 'nova-sessao') { el('resultado').style.display = 'none'; alvoAjustado = false; estadoPagina.pronto = null; }
  };
}
conectar();
