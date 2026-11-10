// ============================================================
//  recuperar-senha.js — pop-up "Esqueceu sua senha?"
//  Usado no login e nos perfis. Passos: (pergunta) → e-mail → código → nova senha.
//  Trocar a senha encerra a sessão em todos os aparelhos, inclusive neste:
//  aoConcluir(email) leva a pessoa para entrar de novo.
//  Estilo em site.css (.rs-*), com as cores do tema da página. Depende do app.js.
// ============================================================
const RecuperarSenha = (() => {
  let dlg, corpo, estado, timerReenvio;

  const ETAPAS = {
    pergunta: () => `
      <h2 id="rs-titulo">Quer redefinir sua senha?</h2>
      <p class="rs-texto">Vamos mandar um código para <strong data-email></strong>. Com ele você cria uma senha nova.</p>
      <p class="rs-erro" role="alert" hidden></p>
      <div class="rs-acoes">
        <button type="button" class="rs-btn rs-btn-sec" data-acao="fechar">Não</button>
        <button type="button" class="rs-btn" data-acao="enviar">Sim</button>
      </div>`,
    email: () => `
      <h2 id="rs-titulo">Esqueceu sua senha?</h2>
      <p class="rs-texto">Digite o e-mail da sua conta. Vamos mandar um código para você criar uma senha nova.</p>
      <label for="rs-email">E-mail</label>
      <input id="rs-email" type="email" autocomplete="email" placeholder="seu@email.com" data-enter="enviar"/>
      <p class="rs-erro" role="alert" hidden></p>
      <div class="rs-acoes">
        <button type="button" class="rs-btn rs-btn-sec" data-acao="fechar">Cancelar</button>
        <button type="button" class="rs-btn" data-acao="enviar">Enviar código</button>
      </div>`,
    codigo: () => `
      <h2 id="rs-titulo">Digite o código</h2>
      <p class="rs-texto">${estado.contaConhecida ? 'Enviamos' : 'Se houver uma conta com este e-mail, enviamos'}
        um código de 6 dígitos para <strong data-email></strong>. Confira a caixa de entrada e a pasta de spam.</p>
      <label for="rs-codigo">Código</label>
      <input id="rs-codigo" class="rs-codigo" type="text" inputmode="numeric" autocomplete="one-time-code"
        maxlength="6" placeholder="000000" data-enter="verificar"/>
      <p class="rs-erro" role="alert" hidden></p>
      <div class="rs-acoes">
        <button type="button" class="rs-link" data-acao="reenviar" id="rs-reenviar">Reenviar código</button>
        <button type="button" class="rs-btn" data-acao="verificar">Continuar</button>
      </div>`,
    nova: () => `
      <h2 id="rs-titulo">Crie uma senha nova</h2>
      <p class="rs-texto">Ao salvar, você sai da conta em todos os aparelhos e entra de novo com a senha nova.</p>
      <label for="rs-senha">Nova senha</label>
      <input id="rs-senha" type="password" autocomplete="new-password" placeholder="Mínimo 6 caracteres"/>
      <label for="rs-senha2">Confirmar nova senha</label>
      <input id="rs-senha2" type="password" autocomplete="new-password" placeholder="Digite a senha de novo" data-enter="salvar"/>
      <p class="rs-erro" role="alert" hidden></p>
      <div class="rs-acoes">
        <button type="button" class="rs-btn" data-acao="salvar">Salvar nova senha</button>
      </div>`,
    pronto: () => `
      <h2 id="rs-titulo">Senha alterada</h2>
      <p class="rs-texto">Por segurança, você saiu da conta em todos os aparelhos. Entre de novo com a senha nova.</p>
      <div class="rs-acoes">
        <button type="button" class="rs-btn" data-acao="fechar">Entrar com a senha nova</button>
      </div>`
  };

  function montar() {
    if (dlg) return;
    dlg = document.createElement('dialog');
    dlg.className = 'rs-dialog';
    dlg.setAttribute('aria-labelledby', 'rs-titulo');
    dlg.innerHTML = '<button type="button" class="rs-fechar" aria-label="Fechar" data-acao="fechar">×</button><div class="rs-corpo"></div>';
    document.body.appendChild(dlg);
    corpo = dlg.querySelector('.rs-corpo');
    dlg.addEventListener('click', e => {
      const btn = e.target.closest('[data-acao]');
      if (btn && !btn.disabled) ACOES[btn.dataset.acao]();
    });
    dlg.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.dataset.enter) { e.preventDefault(); ACOES[e.target.dataset.enter](); }
    });
    dlg.addEventListener('input', e => {
      if (e.target.id === 'rs-codigo') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    });
    // Fechar depois de trocar a senha também leva para o login: a sessão já acabou
    dlg.addEventListener('close', () => {
      clearInterval(timerReenvio);
      if (estado && estado.etapa === 'pronto') estado.aoConcluir(estado.email);
    });
  }

  function mostrar(etapa) {
    estado.etapa = etapa;
    clearInterval(timerReenvio);
    corpo.innerHTML = ETAPAS[etapa]();
    corpo.querySelectorAll('[data-email]').forEach(el => { el.textContent = estado.email; });
    const campo = corpo.querySelector('input');
    if (etapa === 'email') campo.value = estado.email;
    (campo || corpo.querySelector('.rs-acoes .rs-btn:last-child')).focus();
  }

  function erro(msg) {
    const el = corpo.querySelector('.rs-erro');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  // Botão ocupado enquanto o servidor responde. Devolve a resposta (null sem conexão)
  // já com o botão de volta ao normal, para quem chamou mexer nele depois.
  async function chamar(acao, rotulo, pedido) {
    const btn = corpo.querySelector(`[data-acao="${acao}"]`);
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = rotulo;
    erro('');
    try { return await pedido(); }
    catch { erro('Sem conexão com o servidor. Tente de novo.'); return null; }
    finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = original; } }
  }

  function contarReenvio(segundos) {
    const btn = corpo.querySelector('#rs-reenviar');
    if (!btn) return;
    let resta = Math.max(0, Math.round(segundos || 0));
    const pintar = () => {
      btn.disabled = resta > 0;
      btn.textContent = resta > 0 ? `Reenviar em ${resta} s` : 'Reenviar código';
    };
    pintar();
    clearInterval(timerReenvio);
    timerReenvio = setInterval(() => { resta--; pintar(); if (resta <= 0) clearInterval(timerReenvio); }, 1000);
  }

  const ACOES = {
    fechar: () => dlg.close(),

    enviar: async () => {
      if (estado.etapa === 'email') {
        const email = corpo.querySelector('#rs-email').value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { erro('Digite um e-mail válido.'); return; }
        estado.email = email;
      }
      const res = await chamar('enviar', 'Enviando…', () => DB.enviarCodigoSenha(estado.email));
      if (!res) return;
      if (!res.ok) { erro(res.msg); return; }
      mostrar('codigo');
      contarReenvio(res.reenviar_em_s);
    },

    reenviar: async () => {
      const res = await chamar('reenviar', 'Enviando…', () => DB.enviarCodigoSenha(estado.email));
      if (!res) return;
      if (!res.ok) { erro(res.msg); contarReenvio(res.aguarde_s); return; }
      toast('Enviamos um novo código.');
      contarReenvio(res.reenviar_em_s);
    },

    verificar: async () => {
      const codigo = corpo.querySelector('#rs-codigo').value;
      if (codigo.length !== 6) { erro('Digite os 6 números do código.'); return; }
      const res = await chamar('verificar', 'Conferindo…', () => DB.verificarCodigoSenha(estado.email, codigo));
      if (!res) return;
      if (!res.ok) { erro(res.msg); return; }
      estado.token = res.token;
      mostrar('nova');
    },

    salvar: async () => {
      const senha = corpo.querySelector('#rs-senha').value;
      const confirma = corpo.querySelector('#rs-senha2').value;
      if (senha.length < 6) { erro('A senha deve ter pelo menos 6 caracteres.'); return; }
      if (senha !== confirma) { erro('As duas senhas não são iguais.'); return; }
      const res = await chamar('salvar', 'Salvando…', () => DB.redefinirSenha(estado.email, estado.token, senha));
      if (!res) return;
      if (!res.ok) { erro(res.msg); return; }
      DB.logout();                        // esta sessão também foi encerrada no servidor
      mostrar('pronto');
    }
  };

  // perguntar: mostra antes "Quer redefinir sua senha? Sim / Não" (perfil, e-mail já conhecido).
  // Sem perguntar, começa pedindo o e-mail (login).
  function abrir({ email = '', perguntar = false, aoConcluir = () => {} } = {}) {
    montar();
    estado = { email: String(email).trim(), contaConhecida: perguntar, aoConcluir, etapa: null, token: null };
    if (!dlg.open) dlg.showModal();
    mostrar(perguntar ? 'pergunta' : 'email');
  }

  return { abrir };
})();
