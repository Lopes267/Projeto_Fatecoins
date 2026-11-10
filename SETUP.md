# 🚀 Mercado Local - Setup rápido

Resumo para colocar o projeto no ar. Configuração detalhada do Firebase, segurança, lista de APIs e solução de problemas estão em [START-HERE.md](START-HERE.md).

## 📋 Requisitos
- **Node.js 18+** - [Baixar aqui](https://nodejs.org/) (exigido pelo `firebase-admin`)
- **npm** (já vem com o Node.js)
- Um projeto no **Firebase** (Firestore + Authentication com e-mail/senha)
- Uma conta no **Cloudinary** (imagens e modelos 3D)

---

## ⚙️ Instalação

### 1️⃣ Instalar dependências
Na pasta do projeto:

```powershell
npm install
```

Principais pacotes:
- `express` e `cors` - servidor web
- `firebase-admin` - Firestore e Firebase Auth
- `cloudinary` e `multer` - upload de imagens e modelos 3D
- `bcrypt` - hash de senha
- `dotenv` - lê o arquivo `.env`
- `nodemon` - reinicia o servidor ao editar (desenvolvimento)

### 2️⃣ Configurar o `.env`
1. Coloque o JSON da conta de serviço do Firebase na raiz do projeto (nunca suba esse arquivo).
2. Copie `.env.example` para `.env` e preencha:

```env
FIREBASE_WEB_API_KEY=chave-de-api-da-web
FIREBASE_SERVICE_ACCOUNT=nome-do-arquivo-adminsdk.json

CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

O passo a passo de onde pegar cada valor está na seção **1. Configuração** do [START-HERE.md](START-HERE.md).

---

## 🎯 Como rodar

### 3️⃣ Iniciar o servidor

```powershell
npm start
```

Ou dê um duplo clique em `iniciar.bat`.

Você verá:
```
🚀 Servidor rodando em http://localhost:4000
🔥 Conectado ao Firebase (Firestore + Auth) + Cloudinary (imagens)

💡 Para carregar dados de demo: POST /api/seed
💻 Abra no navegador: http://localhost:4000
```

Se a porta 4000 estiver ocupada, o servidor usa a próxima livre (4001, 4002…) e mostra qual no terminal.

### 4️⃣ Carregar dados de demo (opcional)
Só funciona com o banco vazio. É um `POST`, então não dá para abrir no navegador:

```powershell
Invoke-RestMethod -Method Post http://localhost:4000/api/seed
```

Resposta esperada:
```json
{
  "ok": true,
  "msg": "Dados de demo carregados com sucesso!"
}
```

### 5️⃣ Acessar o site
```
http://localhost:4000
```

---

## 🔑 Credenciais de Teste (criadas pelo seed)

**Lojistas:**
- Email: `loja@demo.com` | Senha: `123456`
- Email: `maria@demo.com` | Senha: `123456`

**Cliente:**
- Email: `cliente@demo.com` | Senha: `123456`

---

## 🛠️ Modo Desenvolvimento (com auto-reload)

```powershell
npm run dev
```

Usa o **nodemon** e reinicia o servidor sempre que você edita um arquivo.

---

## 💾 Onde ficam os dados?

- **Dados** (usuários, lojas, produtos, carrinho, pedidos, avaliações, entregas): no **Firestore**.
- **Contas e senhas**: no **Firebase Authentication**.
- **Imagens e modelos 3D**: no **Cloudinary**.

Nada fica salvo em arquivo local. Para limpar os dados, apague as coleções no Console do Firebase e os usuários em Authentication.
