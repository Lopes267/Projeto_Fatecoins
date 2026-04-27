# Mercado Local - Setup de Backend com Node.js

## ⚠️ IMPORTANTE: Habilitar Row Level Security (RLS)

**Antes de usar o sistema, você deve habilitar o RLS no Supabase:**

1. Acesse seu projeto no [Supabase Dashboard](https://supabase.com/dashboard)
2. Vá para **SQL Editor**
3. Execute o conteúdo do arquivo `enable-rls.sql`
4. Isso vai habilitar a segurança de dados baseada em usuário

---

## 📧 Problemas com Validação de E-mail

Se aparecer erro "Email address is invalid":

### E-mails de Teste Recomendados:
- `teste@gmail.com`
- `usuario@outlook.com`
- `demo@icloud.com`
- `exemplo@yahoo.com`

### E-mails que podem não funcionar:
- E-mails muito curtos (`a@b.c`)
- E-mails com domínios suspeitos
- E-mails temporários/disposable

### Verificar Configurações do Supabase:
1. Acesse [Supabase Dashboard](https://supabase.com/dashboard)
2. Vá para **Authentication > Settings**
3. Verifique se "Enable email confirmations" está desabilitado para desenvolvimento
4. Verifique "Site URL" e "Redirect URLs"

## 🚀 Sistema de Porta Automática

O servidor agora encontra **automaticamente** uma porta livre para usar! Não há mais conflitos de porta.

- ✅ **Porta preferida:** 4000 (se estiver livre)
- ✅ **Porta automática:** Testa portas sequencialmente até encontrar uma livre
- ✅ **Sem conflitos:** Nunca falha por porta ocupada

---

## 🔐 Sistema de Autenticação com RLS

O sistema agora usa autenticação JWT do Supabase com Row Level Security:

- **Registro/Login**: Usa `supabase.auth.signUp/signInWithPassword`
- **Segurança**: Cada usuário só vê/edita seus próprios dados
- **Produtos/Lojas**: Lojistas gerenciam apenas seus itens
- **Público**: Qualquer um pode ver produtos e lojas ativas

### APIs que requerem autenticação:
- `PUT /api/users/:id` - Atualizar perfil
- `POST /api/users/:id/change-password` - Alterar senha
- `DELETE /api/users/:id` - Deletar conta
- `POST /api/stores` - Criar loja
- `GET /api/stores/:userId` - Ver loja própria
- `POST /api/products` - Criar produto
- `PUT /api/products/:id` - Atualizar produto
- `DELETE /api/products/:id` - Deletar produto

### APIs públicas:
- `POST /api/auth/register` - Registro
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/session` - Verificar sessão
- `GET /api/products` - Listar produtos
- `GET /api/stores-public` - Listar lojas públicas

---

## Opção 1: Clique Duplo (Recomendado no Windows)
1. Abra o explorador de arquivos
2. Vá para: `c:\Users\Enzo\Desktop\SIte de Mercado Local\`
3. **Dê um duplo clique em `run-server.bat`**
4. O painel de comando vai abrir e instalar + iniciar o servidor
5. Abra no navegador: `http://localhost:4000`

**💡 Dica:** Se a porta estiver ocupada, use `restart-server.bat` para resetar.

---

## Opção 2: Terminal Windows (CMD)
```cmd
cd c:\Users\Enzo\Desktop\SIte de Mercado Local
npm install
npm start
```

---

## Opção 3: PowerShell (se Opção 1/2 não funcionar)
Se houver erro de política, execute primeiro:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Depois:
```powershell
cd 'c:\Users\Enzo\Desktop\SIte de Mercado Local'
npm install
npm start
```

---

## ✅ Quando funcionar, você verá:

```
✅ Servidor rodando em http://localhost:4000

📁 Conectado ao Supabase

💡 Para migrar dados do JSON: POST /api/migrate
💡 Para carregar dados de demo: POST /api/seed
```

**Depois abra no navegador:** `http://localhost:4000`

E acesse com as credenciais de demo:
- Email: `loja@demo.com` | Senha: `123456`
- Email: `cliente@demo.com` | Senha: `123456`

## 🔧 Solução de Problemas

### Sistema de Porta Automática
O servidor agora encontra portas livres automaticamente. Se ainda houver problemas:

1. Use `restart-server.bat` (mata processos antigos e reinicia)
2. Verifique se há outros programas usando portas (ex: Skype usa 3000)

### Porta Específica Ocupada
```cmd
# Ver processos em uma porta específica
netstat -ano | findstr :4000

# Matar processo específico (substitua PID)
taskkill /PID 1234 /F
```

### Reset Completo
```cmd
# Mata todos os processos Node
taskkill /IM node.exe /F

# Reinicia o servidor
node server.js
```

### Erro "Email address is invalid"
- Use e-mails reais como `teste@gmail.com`
- Evite e-mails muito curtos ou suspeitos
- Verifique configurações do Supabase Authentication

---

## 📂 Arquivos Criados:

| Arquivo | Descrição |
|---------|-----------|
| `server.js` | 🖥️ Backend Node.js com Express |
| `package.json` | 📦 Dependências do projeto |
| `run-server.bat` | 🚀 Atalho Windows para rodar |
| `app.js` | ✏️ Front-end atualizado (conectado ao servidor) |
| `data.json` | 💾 Banco de dados (criado automaticamente) |
| `SETUP.md` | 📖 Documentação completa |

---

## 🎯 Arquitetura Agora:

```
NAVEGADOR (Frontend)
    ↓ (HTTP Requests)
Express Server (Node.js)
    ↓
data.json (Persistência)
```

Antes era tudo localStorage. Agora você tem um backend de verdade! 🎉
