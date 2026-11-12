// ============================================================
//  email-apps-script.gs — envio dos códigos de verificação pelo Gmail
//
//  Roda no Google Apps Script (script.google.com), DENTRO da conta do Gmail
//  que manda os e-mails (mercadolocaltaubate@gmail.com). O servidor chama este
//  script por HTTPS, porque o plano grátis do Render bloqueia o SMTP.
//
//  Instalação (uma vez):
//   1. script.google.com → Novo projeto → apague o conteúdo e cole este arquivo.
//   2. Troque COLE_AQUI_O_SEGREDO por um texto longo e aleatório; o mesmo texto
//      vai na variável EMAIL_SCRIPT_SEGREDO do Render.
//   3. Salve, escolha a função "autorizar" e clique em Executar → autorize.
//   4. Implantar → Nova implantação → tipo "App da Web" → Executar como: Eu;
//      Quem pode acessar: Qualquer pessoa → Implantar.
//   5. Copie o URL do app da Web (termina em /exec) para EMAIL_SCRIPT_URL.
//  Limite do Gmail comum: 100 destinatários por dia.
// ============================================================

const SEGREDO = 'COLE_AQUI_O_SEGREDO';

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (!d || SEGREDO === 'COLE_AQUI_O_SEGREDO' || d.segredo !== SEGREDO) {
      return resposta({ ok: false, erro: 'segredo inválido' });
    }
    const para = String(d.para || '').trim();
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(para)) return resposta({ ok: false, erro: 'destinatário inválido' });
    MailApp.sendEmail({
      to: para,
      subject: String(d.assunto || '').slice(0, 200),
      body: String(d.texto || ''),
      htmlBody: d.html ? String(d.html) : undefined,
      name: String(d.nome || 'Mercado Local').slice(0, 60)
    });
    return resposta({ ok: true, restantesHoje: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return resposta({ ok: false, erro: String((err && err.message) || err) });
  }
}

// Abrir o URL no navegador mostra se o script está no ar (não envia nada)
function doGet() {
  return resposta({ ok: true, servico: 'e-mail do Mercado Local' });
}

function resposta(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Execute esta função uma vez pelo editor: é ela que pede a permissão de envio
function autorizar() {
  Logger.log('Envios restantes hoje: ' + MailApp.getRemainingDailyQuota());
}
