/**
 * Coloca os pedidos antigos na fila de entrega.
 *
 * Por que existe: /api/deliveries/available consulta
 * where('entrega_status','==','aguardando'). Pedidos gravados antes do módulo
 * de entregas não têm esse campo — e o Firestore não encontra documentos por
 * campo ausente, então eles nunca apareceriam para o entregador escolher.
 * Este script cria entrega_status/entrega/entregador_* a partir do que já
 * existe (o cadastro do comprador vira o endereço de entrega).
 *
 * Rode uma vez, depois de subir o novo servidor:
 *   node backfill-entregas.js           (simulação — não escreve nada)
 *   node backfill-entregas.js --aplicar (grava de verdade)
 */
require('dotenv').config();
const admin = require('firebase-admin');

const APLICAR = process.argv.includes('--aplicar');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('FIREBASE_SERVICE_ACCOUNT não está definido no .env — mesma variável que o server.js usa.');
  process.exit(1);
}
const serviceAccount = require('./' + process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

(async () => {
  const snap = await db.collection('pedidos').get();
  console.log(`${snap.size} pedido(s) na coleção.`);

  const pendentes = snap.docs.filter(d => !d.data().entrega_status);
  if (!pendentes.length) {
    console.log('Nada a corrigir: todos os pedidos já estão no fluxo de entrega.');
    await admin.app().delete();
    return;
  }

  // Endereço de entrega derivado do cadastro de quem comprou
  const perfis = new Map();
  async function perfilDe(uid) {
    if (!uid) return {};
    if (perfis.has(uid)) return perfis.get(uid);
    const doc = await db.collection('usuarios').doc(uid).get();
    const dados = doc.exists ? doc.data() : {};
    perfis.set(uid, dados);
    return dados;
  }

  const preparados = [];
  for (const d of pendentes) {
    const p = d.data();
    const perfil = await perfilDe(p.usuario_id);
    preparados.push({
      id: d.id,
      ref: d.ref,
      semEndereco: !perfil.endereco && !perfil.cep,
      campos: {
        entrega_status: 'aguardando',
        entrega: {
          cep: perfil.cep || null,
          logradouro: perfil.endereco || null,
          numero: null, complemento: null, bairro: null,
          cidade: perfil.cidade || null,
          uf: perfil.estado || null,
          referencia: null, lat: null, lng: null
        },
        usuario_telefone: p.usuario_telefone || perfil.telefone || null,
        entregador_id: null, entregador_nome: null,
        entregador_telefone: null, entregador_local: null,
        entrega_historico: [{ status: 'aguardando', em: new Date().toISOString() }]
      }
    });
  }

  console.log(`\n${preparados.length} pedido(s) a colocar na fila:`);
  preparados.forEach(p => console.log(
    `  ${p.id}${p.semEndereco ? '  ! comprador sem endereço no cadastro — o entregador verá o endereço incompleto' : ''}`));

  if (!APLICAR) {
    console.log('\nSimulação — nada foi gravado. Rode com --aplicar para gravar.');
    await admin.app().delete();
    return;
  }

  // Lotes de 400: o limite do batch do Firestore é 500 operações
  let gravados = 0;
  for (let i = 0; i < preparados.length; i += 400) {
    const lote = db.batch();
    preparados.slice(i, i + 400).forEach(p => lote.update(p.ref, p.campos));
    await lote.commit();
    gravados += Math.min(400, preparados.length - i);
    console.log(`  gravados ${gravados}/${preparados.length}`);
  }
  console.log('\nConcluído.');
  await admin.app().delete();
})().catch(e => { console.error('Falhou:', e); process.exit(1); });
