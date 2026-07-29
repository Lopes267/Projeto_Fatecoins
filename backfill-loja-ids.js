/**
 * Preenche loja_ids e produto_ids em pedidos antigos.
 *
 * Por que existe: /api/sales passou a consultar os pedidos por
 * where('loja_ids','array-contains-any', ...) em vez de varrer a coleção inteira.
 * Pedidos gravados antes desses campos existirem não seriam encontrados e
 * sumiriam do painel de Vendas. Este script deriva os campos de itens[] e grava.
 *
 * Rode uma vez, antes de publicar a nova versão do servidor:
 *   node backfill-loja-ids.js           (simulação — não escreve nada)
 *   node backfill-loja-ids.js --aplicar (grava de verdade)
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

  const pendentes = [];
  snap.docs.forEach(d => {
    const p = d.data();
    const itens = p.itens || [];
    const lojaIds = [...new Set(itens.map(i => i.loja_id).filter(Boolean))];
    const produtoIds = [...new Set(itens.map(i => i.produto_id).filter(Boolean))];

    const faltaLoja = !Array.isArray(p.loja_ids) || p.loja_ids.length !== lojaIds.length;
    const faltaProd = !Array.isArray(p.produto_ids) || p.produto_ids.length !== produtoIds.length;
    if (!faltaLoja && !faltaProd) return;

    if (!lojaIds.length && !produtoIds.length) {
      console.log(`  ! ${d.id}: sem loja_id/produto_id nos itens — não dá para derivar, revise à mão`);
      return;
    }
    pendentes.push({ id: d.id, ref: d.ref, lojaIds, produtoIds, faltaLoja, faltaProd });
  });

  if (!pendentes.length) {
    console.log('Nada a corrigir: todos os pedidos já têm loja_ids e produto_ids.');
    await admin.app().delete();
    return;
  }

  console.log(`\n${pendentes.length} pedido(s) a corrigir:`);
  pendentes.forEach(p => console.log(
    `  ${p.id}  loja_ids=[${p.lojaIds.join(', ')}]  produto_ids=${p.produtoIds.length} item(ns)`));

  if (!APLICAR) {
    console.log('\nSimulação — nada foi gravado. Rode com --aplicar para gravar.');
    await admin.app().delete();
    return;
  }

  // Lotes de 400: o limite do batch do Firestore é 500 operações
  let gravados = 0;
  for (let i = 0; i < pendentes.length; i += 400) {
    const lote = db.batch();
    pendentes.slice(i, i + 400).forEach(p => {
      const campos = {};
      if (p.faltaLoja) campos.loja_ids = p.lojaIds;
      if (p.faltaProd) campos.produto_ids = p.produtoIds;
      lote.update(p.ref, campos);
    });
    await lote.commit();
    gravados += Math.min(400, pendentes.length - i);
    console.log(`  gravados ${gravados}/${pendentes.length}`);
  }
  console.log('\nConcluído.');
  await admin.app().delete();
})().catch(e => { console.error('Falhou:', e); process.exit(1); });
