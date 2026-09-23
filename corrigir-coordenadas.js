/**
 * Recalcula a localização dos pedidos gravados com coordenada inválida.
 *
 * Por que existe: por um tempo o servidor gravou lat/lng = 0 quando o cliente não
 * autorizava o GPS no checkout (Number(null) é 0, e Number.isFinite(0) é true).
 * O ponto (0,0) é a "Ilha Nula", no Golfo da Guiné — por isso entregas em Taubaté
 * apareciam perto da Nigéria. O servidor já ignora essas coordenadas na leitura;
 * este script conserta os dados e busca a posição de verdade pelo endereço.
 *
 *   node corrigir-coordenadas.js           (simulação — não escreve nada)
 *   node corrigir-coordenadas.js --aplicar (grava de verdade)
 */
require('dotenv').config();
const admin = require('firebase-admin');

const APLICAR = process.argv.includes('--aplicar');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('FIREBASE_SERVICE_ACCOUNT não está definido no .env — mesma variável que o server.js usa.');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(require('./' + process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// Mesmas regras do server.js
function coordenada(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function plausivel(lat, lng) {
  if (lat === null || lng === null) return false;
  if (lat === 0 && lng === 0) return false;
  return lat >= -34.5 && lat <= 5.5 && lng >= -74.5 && lng <= -33.5;
}

async function nominatim(params) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&' +
              new URLSearchParams(params);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'MercadoLocal/1.0 (correcao de coordenadas)' },
      signal: AbortSignal.timeout(7000)
    });
    if (!r.ok) return null;
    const lista = await r.json();
    if (!Array.isArray(lista) || !lista.length) return null;
    const lat = parseFloat(lista[0].lat), lng = parseFloat(lista[0].lon);
    return plausivel(lat, lng) ? { lat, lng } : null;
  } catch { return null; }
}

async function geocodificar(e) {
  const cidadeUf = [e.cidade, e.uf].filter(Boolean).join(', ');
  const tentativas = [];
  if (e.logradouro && e.cidade) {
    if (e.numero) {
      tentativas.push({ precisao: 'exata', params: { street: `${e.numero} ${e.logradouro}`, city: e.cidade, state: e.uf || '' } });
      tentativas.push({ precisao: 'exata', params: { q: [e.logradouro, e.numero, e.bairro, cidadeUf, 'Brasil'].filter(Boolean).join(', ') } });
    }
    tentativas.push({ precisao: 'rua', params: { street: e.logradouro, city: e.cidade, state: e.uf || '' } });
    tentativas.push({ precisao: 'rua', params: { q: [e.logradouro, e.bairro, cidadeUf, 'Brasil'].filter(Boolean).join(', ') } });
  }
  if (e.bairro && e.cidade) {
    tentativas.push({ precisao: 'bairro', params: { q: [e.bairro, cidadeUf, 'Brasil'].filter(Boolean).join(', ') } });
  }
  const cep = String(e.cep || '').replace(/\D/g, '');
  if (cep.length === 8) tentativas.push({ precisao: 'cep', params: { postalcode: cep } });
  if (e.cidade)         tentativas.push({ precisao: 'cidade', params: { city: e.cidade, state: e.uf || '' } });

  for (let i = 0; i < tentativas.length; i++) {
    if (i > 0) await esperar(1100);
    const coords = await nominatim(tentativas[i].params);
    if (coords) return { ...coords, precisao: tentativas[i].precisao };
  }
  return null;
}

(async () => {
  const snap = await db.collection('pedidos').get();
  console.log(`${snap.size} pedido(s) na coleção.`);

  const quebrados = snap.docs.filter(d => {
    const e = d.data().entrega;
    if (!e) return false;
    // "cidade" é o centroide do município — manda o entregador para o Centro mesmo
    // quando o endereço é em outro bairro. Agora que a busca tenta o bairro antes
    // de desistir, vale reprocessar esses pedidos.
    if (e.precisao === 'cidade') return true;
    const lat = coordenada(e.lat), lng = coordenada(e.lng);
    if (lat === null && lng === null) return e.precisao === undefined;   // nunca teve tentativa
    return !plausivel(lat, lng);                                        // (0,0) e afins
  });

  if (!quebrados.length) {
    console.log('Nada a corrigir: nenhum pedido com coordenada inválida.');
    await admin.app().delete();
    return;
  }

  console.log(`\n${quebrados.length} pedido(s) com localização inválida. Buscando o ponto correto…\n`);

  const correcoes = [];
  for (const d of quebrados) {
    const e = d.data().entrega || {};
    const onde = [e.logradouro, e.numero, e.cidade, e.uf].filter(Boolean).join(', ') || `CEP ${e.cep || '?'}`;
    const coords = await geocodificar(e);
    if (coords) {
      console.log(`  ${d.id}  ${onde}\n      → ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}  (precisão: ${coords.precisao})`);
      correcoes.push({ ref: d.ref, coords });
    } else {
      console.log(`  ${d.id}  ${onde}\n      → não foi possível localizar; a coordenada será limpa (o entregador usa o endereço escrito)`);
      correcoes.push({ ref: d.ref, coords: null });
    }
    await esperar(1100);   // política do Nominatim: 1 consulta por segundo
  }

  if (!APLICAR) {
    console.log('\nSimulação — nada foi gravado. Rode com --aplicar para gravar.');
    await admin.app().delete();
    return;
  }

  let gravados = 0;
  for (let i = 0; i < correcoes.length; i += 400) {
    const lote = db.batch();
    correcoes.slice(i, i + 400).forEach(c => {
      lote.update(c.ref, {
        'entrega.lat':      c.coords ? c.coords.lat : null,
        'entrega.lng':      c.coords ? c.coords.lng : null,
        'entrega.precisao': c.coords ? c.coords.precisao : null
      });
    });
    await lote.commit();
    gravados += Math.min(400, correcoes.length - i);
    console.log(`  gravados ${gravados}/${correcoes.length}`);
  }
  console.log('\nConcluído.');
  await admin.app().delete();
})().catch(e => { console.error('Falhou:', e); process.exit(1); });
