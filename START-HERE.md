# Mercado Local - Comece por aqui

Backend em Node.js (Express) usando **Firebase** (Firestore para os dados, Firebase Auth para login) e **Cloudinary** para imagens e modelos 3D.

```
NAVEGADOR (HTML + app.js)
    ↓ fetch /api/...  (Authorization: Bearer <idToken>)
Express — server.js
    ├── Firebase Admin SDK → Firestore (dados) + Auth (contas)
    ├── Cloudinary          → logo, banner, fotos e modelos 3D
    └── ViaCEP / Nominatim  → CEP e coordenadas para o frete
```

O navegador **não acessa o Firebase diretamente**: tudo passa pelo `server.js`.

### Vitrine em memória
Cada consulta ao Firestore leva de meio a um segundo. Por isso o `server.js` mantém os produtos e as lojas ativos numa cópia em memória, atualizada pelo próprio Firestore a cada mudança (`onSnapshot`), inclusive mudanças feitas pelo console ou pelos scripts de manutenção. As rotas públicas da vitrine (`/api/products`, `/api/stores-public`, `/api/stores-public/:id`, a loja do lojista e o frete) respondem dessa cópia, em milissegundos. A lista de produtos do painel do lojista (`/api/products/store/:id`) continua lendo direto do banco, para mostrar na hora o que acabou de ser salvo.

---

## ⚙️ 1. Configuração (uma vez só)

### Firebase
1. No [Console do Firebase](https://console.firebase.google.com/), abra o projeto (ou crie um).
2. **Authentication › Sign-in method**: ative o provedor **E-mail/senha**.
3. **Firestore Database**: crie o banco, se ainda não existir.
4. **Configurações do projeto › Contas de serviço › Gerar nova chave privada**: baixe o JSON e coloque na raiz do projeto.
   - Esse arquivo dá acesso total ao banco. O `.gitignore` já ignora `*firebase-adminsdk*.json`: **nunca suba esse arquivo**.
5. **Configurações do projeto › Geral**: copie a **Chave de API da Web**.

### Cloudinary
No [painel do Cloudinary](https://console.cloudinary.com/), copie *Cloud name*, *API Key* e *API Secret*.

### E-mail (códigos de verificação)
O cadastro e o "Esqueceu sua senha?" mandam um código de 6 dígitos por e-mail, por SMTP (qualquer provedor serve). Com Gmail:
1. Na conta Google que vai enviar, ligue a **verificação em duas etapas**.
2. Em [Senhas de app](https://myaccount.google.com/apppasswords), crie uma senha de app.
3. Preencha no `.env`: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=` o Gmail e `SMTP_PASS=` a senha de app (sem espaços).

Sem SMTP configurado, o servidor avisa ao iniciar e o código aparece **só no terminal** (`[e-mail] SMTP não configurado. Código de cadastro para ...`). Serve para testar, mas ninguém recebe e-mail.

### Arquivo `.env`
Copie `.env.example` para `.env` e preencha:

```env
FIREBASE_WEB_API_KEY=chave-de-api-da-web
FIREBASE_SERVICE_ACCOUNT=nome-do-arquivo-adminsdk.json

CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=seu@gmail.com
SMTP_PASS=senha-de-app
EMAIL_REMETENTE=Mercado Local <seu@gmail.com>
```

`FIREBASE_SERVICE_ACCOUNT` é só o **nome do arquivo** JSON (ele precisa estar na raiz do projeto).

---

## 🚀 2. Rodar o servidor

**Opção 1 — clique duplo (Windows):** abra `iniciar.bat` na pasta do projeto.

**Opção 2 — terminal**, na pasta do projeto:
```powershell
npm install
npm start        # ou: npm run dev  (reinicia sozinho ao editar, via nodemon)
```

Se o PowerShell bloquear o `npm`, rode uma vez:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Quando funcionar, você verá:
```
🚀 Servidor rodando em http://localhost:4000
🔥 Conectado ao Firebase (Firestore + Auth) + Cloudinary (imagens)

💡 Para carregar dados de demo: POST /api/seed
💻 Abra no navegador: http://localhost:4000
```

### Porta automática
O servidor tenta a porta **4000**. Se estiver ocupada, usa a próxima livre a partir de 4001 e mostra qual no terminal.

---

## 🧪 3. Dados de demo

Com o banco vazio, faça um `POST /api/seed` (por exemplo, no PowerShell):
```powershell
Invoke-RestMethod -Method Post http://localhost:4000/api/seed
```

Ele cria duas lojas com produtos e estas contas:

| Tipo | E-mail | Senha |
|------|--------|-------|
| Lojista | `loja@demo.com` | `123456` |
| Lojista | `maria@demo.com` | `123456` |
| Cliente | `cliente@demo.com` | `123456` |

Se já existir algum usuário no Firestore, o seed não faz nada (`"Dados de demo já existem."`).

---

## 🔐 Autenticação e segurança

- **Cadastro com confirmação de e-mail**: primeiro `POST /api/auth/register/code` confere se o domínio recebe e-mail, se o e-mail ainda não tem conta, e manda um código de 6 dígitos. Depois `POST /api/auth/register` (com o `codigo`) cria a conta no Firebase Auth, já com o e-mail marcado como verificado, e o perfil em `usuarios/{uid}`. Tipos de conta: `cliente`, `lojista` ou `entregador`.
- **Esqueceu sua senha?** (no login e nos perfis): `POST /api/auth/password/code` manda o código; `POST /api/auth/password/verify` troca o código certo por um token de uso único; `POST /api/auth/password/reset` grava a senha nova. A troca **encerra a sessão em todos os aparelhos**: os logins anteriores passam a ser recusados (coleção `sessoes_encerradas`) e as páginas abertas voltam para o login em até 1 minuto.
- **Códigos**: valem 10 minutos e aceitam 5 tentativas erradas; no banco fica só o hash (coleção `codigos_email`). Um novo código para o mesmo e-mail só sai depois de 60 s, e cada IP pode pedir até 10 por hora.
- **Login** (`POST /api/auth/login`): o servidor valida e-mail e senha no Firebase Auth e devolve um **ID token**. O `app.js` guarda o token em `localStorage` (`mp_session`) e o envia como `Authorization: Bearer <token>`.
- **Rotas protegidas**: o middleware `authenticateToken` valida o token com `admin.auth().verifyIdToken()`. Cada rota confere se o recurso pertence ao usuário (por exemplo, só o dono da loja edita os produtos dela).
- **Ninguém compra o que vende**: o lojista não compra produtos da própria loja. A loja de cada produto é lida do banco, não do que o navegador manda: `GET`/`PUT /api/cart` tiram esses produtos do carrinho (e respondem `removidos`), e `POST /api/orders` recusa com 403 (`proprio_produto`). Na vitrine, o lojista vê os próprios produtos como "Produto da sua loja", sem botão de compra.
- **Validade da sessão**: o ID token do Firebase dura 1 hora. O front descarta a sessão aos 55 minutos, e aí é preciso entrar de novo; não há renovação automática.
- **Regras do Firestore**: o Admin SDK ignora as Security Rules, e o navegador não fala com o Firestore. Por isso a proteção dos dados está nas rotas do `server.js`. Recomendado: deixar as regras do Firestore bloqueando todo acesso direto (`allow read, write: if false;`), para que ninguém leia o banco pela API pública do Firebase.

### Coleções no Firestore
`usuarios`, `lojas`, `produtos`, `carrinho/{uid}/produtos`, `pedidos`, `avaliacoes`, `carteira_movimentos`, `geocache`, `codigos_email`, `sessoes_encerradas`.

---

## 🌐 APIs

### Públicas
- `POST /api/auth/register/code`, `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`
- `POST /api/auth/password/code`, `POST /api/auth/password/verify`, `POST /api/auth/password/reset`
- `GET /api/products`, `GET /api/products/store/:storeId`, `GET /api/products/:id/reviews`
- `GET /api/stores-public`, `GET /api/stores-public/:id`, `GET /api/stats`
- `GET /api/cep/:cep`, `POST /api/shipping/quote`
- `POST /api/seed`

### Exigem login (`Authorization: Bearer <token>`)
- **Conta:** `GET /api/auth/session`, `GET /api/auth/session/check`, `PUT /api/users/:id`, `POST /api/users/:id/change-password`, `DELETE /api/users/:id`, `PUT /api/users/:id/profile-image`, `GET /api/users/:id/reviews`
- **Loja:** `POST /api/stores`, `GET /api/stores/:userId`, `PUT /api/stores/:id/logo`, `PUT /api/stores/:id/banner`, `GET /api/sales`
- **Produtos:** `POST /api/products`, `PUT /api/products/:id`, `DELETE /api/products/:id` (desativa), `PUT /api/products/:id/image`, `PUT` e `DELETE /api/products/:id/model`, `POST /api/upload-image`
- **Carrinho e pedidos:** `GET`, `PUT` e `DELETE /api/cart`; `POST` e `GET /api/orders`
- **Avaliações:** `POST` e `DELETE /api/products/:id/reviews`
- **Entregas:** `GET` e `PUT /api/couriers/capacity`, `GET /api/deliveries/available`, `GET /api/deliveries/mine`, `POST /api/deliveries/:id/accept`, `.../release`, `.../location`, `.../status`, `GET /api/deliveries/tracking`, `GET /api/deliveries/:id/tracking`
- **Carteira do entregador:** `GET /api/wallet`, `POST /api/wallet/withdraw`

---

## 🛠️ Scripts de manutenção

Corrigem dados antigos no Firestore. Sem argumento só simulam e mostram o que mudaria; com `--aplicar` gravam de verdade.

| Script | O que faz |
|--------|-----------|
| `node backfill-entregas.js [--aplicar]` | Coloca pedidos antigos na fila de entrega |
| `node backfill-loja-ids.js [--aplicar]` | Preenche `loja_ids` e `produto_ids` em pedidos antigos |
| `node corrigir-coordenadas.js [--aplicar]` | Recalcula a localização de pedidos gravados com coordenada inválida |

---

## 🔧 Solução de problemas

### O servidor não inicia: `Cannot find module './...json'`
O `FIREBASE_SERVICE_ACCOUNT` no `.env` está vazio ou com nome errado, ou o JSON não está na raiz do projeto.

### Login sempre dá "E-mail ou senha incorretos."
- Confira o `FIREBASE_WEB_API_KEY` no `.env`.
- Confira se o provedor **E-mail/senha** está ativo no Firebase Authentication.

### Erros no cadastro
- `Este e-mail já está cadastrado.`: a conta já existe no Firebase Auth.
- `A senha deve ter pelo menos 6 caracteres.`: exigência do Firebase.

### O código de verificação não chega
- Confira a pasta de spam.
- Se o terminal do servidor mostrou `SMTP não configurado`, preencha as variáveis `SMTP_*` do `.env` e reinicie. Enquanto isso, o código aparece no próprio terminal.
- Com Gmail, `SMTP_PASS` precisa ser uma **senha de app**, não a senha normal da conta.

### Upload de imagem falha
Confira as três variáveis `CLOUDINARY_*` no `.env`.

### Porta ocupada
```cmd
netstat -ano | findstr :4000
taskkill /PID 1234 /F
```
Para encerrar todos os processos Node: `taskkill /IM node.exe /F`.

---

## 📂 Arquivos principais

| Arquivo | Descrição |
|---------|-----------|
| `server.js` | Backend Express: rotas, Firebase e Cloudinary |
| `app.js` | Cliente da API usado pelas páginas (`DB.*`) |
| `index.html`, `login.html`, `marketplace.html`, `checkout.html` | Páginas públicas e do cliente |
| `dashboard.html` | Painel do lojista |
| `entregas.html` | Painel do entregador |
| `profile.html`, `client-profile.html` | Perfis |
| `.env.example` | Modelo das variáveis de ambiente |
| `iniciar.bat` | Atalho do Windows para `npm start` |

### Arquivos legados (não usados pelo código atual)
`enable-rls.sql` e `schema_hard_reset.sql` (da época do Supabase), `schema.sql` (SQLite), `data.json` e `marketplace.db`. O servidor não lê nenhum deles.
