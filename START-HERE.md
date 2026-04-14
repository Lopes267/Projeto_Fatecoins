# Mercado Local - Setup de Backend com Node.js

## Opção 1: Clique Duplo (Recomendado no Windows)
1. Abra o explorador de arquivos
2. Vá para: `c:\Users\Enzo\Desktop\SIte de Mercado Local\`
3. **Dê um duplo clique em `run-server.bat`**
4. O painel de comando vai abrir e instalar + iniciar o servidor
5. Abra no navegador: `http://localhost:5000`

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
✅ Servidor rodando em http://localhost:5000

📁 Dados salvos em: c:\Users\Enzo\Desktop\SIte de Mercado Local\data.json

💡 Para carregar dados de demo, acesse: http://localhost:5000/api/seed
```

**Depois abra no navegador:** `http://localhost:5000`

E acesse com as credenciais de demo:
- Email: `loja@demo.com` | Senha: `123456`
- Email: `cliente@demo.com` | Senha: `123456`

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
