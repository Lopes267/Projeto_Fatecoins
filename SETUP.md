# 🚀 Mercado Local - Setup com Node.js

## 📋 Requisitos
- **Node.js** (v14+) - [Baixar aqui](https://nodejs.org/)
- **npm** (já vem com Node.js)

---

## ⚙️ Instalação

### 1️⃣ Instalar dependências
Abra o terminal na pasta do projeto e execute:

```powershell
npm install
```

Isso vai instalar:
- `express` - Framework web
- `cors` - Permitir requisições do navegador
- `nodemon` - Recarregar o servidor automaticamente

---

## 🎯 Como Rodar

### 2️⃣ Iniciar o servidor

```powershell
npm start
```

Você verá:
```
✅ Servidor rodando em http://localhost:5000

📁 Dados salvos em: c:\Users\Enzo\Desktop\SIte de Mercado Local\data.json

💡 Para carregar dados de demo, acesse: http://localhost:5000/api/seed
```

### 3️⃣ Carregar dados de demo
Abra o navegador e acesse:
```
http://localhost:5000/api/seed
```

Você deve ver:
```json
{
  "ok": true,
  "msg": "Dados de demo carregados com sucesso!"
}
```

### 4️⃣ Acessar o site
Abra em uma nova aba do navegador:
```
http://localhost:5000
```

---

## 🔑 Credenciais de Teste

**Lojistas:**
- Email: `loja@demo.com` | Senha: `123456`
- Email: `maria@demo.com` | Senha: `123456`

**Cliente:**
- Email: `cliente@demo.com` | Senha: `123456`

---

## 📂 Estrutura de Arquivos

```
c:\Users\Enzo\Desktop\SIte de Mercado Local\
├── server.js           ← Backend Node.js (Express)
├── app.js              ← Front-end (conectado ao servidor)
├── package.json        ← Dependências npm
├── data.json           ← Banco de dados (criado automaticamente)
├── index.html          ← Home
├── login.html          ← Login
├── marketplace.html    ← Marketplace
├── dashboard.html      ← Dashboard (lojista)
└── schema.sql          ← Referência do banco de dados
```

---

## 🌐 APIs Disponíveis

### Auth
- `POST /api/auth/register` - Registrar usuário
- `POST /api/auth/login` - Fazer login

### Lojas
- `POST /api/stores` - Criar/atualizar loja
- `GET /api/stores/:userId` - Buscar loja do usuário
- `GET /api/stores-public` - Listar lojas ativas

### Produtos
- `POST /api/products` - Criar produto
- `GET /api/products` - Buscar produtos (com filtro)
- `GET /api/products/store/:storeId` - Produtos de uma loja
- `PUT /api/products/:id` - Atualizar produto
- `DELETE /api/products/:id` - Desativar produto

### Seed
- `POST /api/seed` - Carregar dados de demo

---

## 🛠️ Modo Desenvolvimento (com auto-reload)

```powershell
npm run dev
```

Isso usa **nodemon** e recarrega o servidor automaticamente quando você edita `server.js`.

---

## 💾 Dados Persistem?

✅ **SIM!** Os dados são salvos em `data.json` e persistem mesmo após fechar o servidor.

Para **limpar os dados**, delete `data.json`:
```powershell
Remove-Item data.json
```

---

## ⚠️ Erros Comuns

### ❌ "Cannot GET /api/customers" ou erro 404
→ Certifique-se de que o servidor está rodando em `http://localhost:5000`

### ❌ "CORS error" no navegador
→ Já está configurado no `server.js` com `cors()`

### ❌ Porta 5000 já está em uso
→ Troque a porta em `server.js`:
```javascript
const PORT = 3000; // ou outra porta
```

---

## 📚 Próximos Passos

- ✨ Adicionar banco de dados real (SQLite/PostgreSQL)
- 🔐 Melhorar segurança (JWT tokens, passwords com hash)
- 📧 Enviar e-mails de confirmação
- 💳 Integrar pagamento (Stripe, PayPal)
- 📱 Criar app mobile (React Native)

---

**Pronto! Seu backend Node.js está funcionando!** 🎉
