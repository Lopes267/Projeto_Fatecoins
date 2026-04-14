// ============================================================
//  server.js – Backend com Express
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const app = express();
const PORT = 5800;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Arquivo de dados
const DATA_FILE = path.join(__dirname, 'data.json');

// ============================================================
//  FUNÇÕES DE ARQUIVO
// ============================================================

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initialData = {
      users: [],
      stores: [],
      products: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  const data = fs.readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(data);
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// ============================================================
//  AUTH - REGISTRO
// ============================================================

app.post('/api/auth/register', (req, res) => {
  const { nome, email, senha, tipo = 'cliente' } = req.body;

  if (!nome || !email || !senha) {
    return res.status(400).json({ ok: false, msg: 'Campos obrigatórios faltando.' });
  }

  const data = loadData();
  if (data.users.find(u => u.email === email)) {
    return res.status(400).json({ ok: false, msg: 'E-mail já cadastrado.' });
  }

  const user = {
    id: generateId(),
    nome,
    email,
    senha: Buffer.from(senha).toString('base64'),
    tipo,
    criadoEm: new Date().toISOString()
  };

  data.users.push(user);
  saveData(data);

  res.json({ ok: true, user: { id: user.id, nome: user.nome, email: user.email, tipo: user.tipo } });
});

// ============================================================
//  AUTH - LOGIN
// ============================================================

app.post('/api/auth/login', (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ ok: false, msg: 'E-mail e senha obrigatórios.' });
  }

  const data = loadData();
  const user = data.users.find(u => u.email === email && u.senha === Buffer.from(senha).toString('base64'));

  if (!user) {
    return res.status(401).json({ ok: false, msg: 'E-mail ou senha incorretos.' });
  }

  res.json({ 
    ok: true, 
    user: { 
      id: user.id, 
      nome: user.nome, 
      email: user.email, 
      tipo: user.tipo 
    } 
  });
});

// ============================================================
//  LOJAS
// ============================================================

app.post('/api/stores', (req, res) => {
  const { userId, nome, descricao, categoria, cidade, estado, telefone } = req.body;
  const data = loadData();

  if (data.stores.find(s => s.userId === userId)) {
    const idx = data.stores.findIndex(s => s.userId === userId);
    data.stores[idx] = {
      ...data.stores[idx],
      nome,
      descricao,
      categoria,
      cidade,
      estado,
      telefone,
      updatedAt: new Date().toISOString()
    };
    saveData(data);
    return res.json({ ok: true, store: data.stores[idx] });
  }

  const store = {
    id: generateId(),
    userId,
    nome,
    descricao,
    categoria,
    cidade,
    estado,
    telefone,
    ativa: true,
    criadoEm: new Date().toISOString()
  };

  data.stores.push(store);
  saveData(data);
  res.json({ ok: true, store });
});

app.get('/api/stores/:userId', (req, res) => {
  const data = loadData();
  const store = data.stores.find(s => s.userId === req.params.userId);
  res.json({ ok: true, store: store || null });
});

app.get('/api/stores-public', (req, res) => {
  const data = loadData();
  const stores = data.stores.filter(s => s.ativa).map(s => ({
    ...s,
    totalProdutos: data.products.filter(p => p.storeId === s.id && p.ativo).length
  }));
  res.json({ ok: true, stores });
});

// ============================================================
//  PRODUTOS
// ============================================================

app.post('/api/products', (req, res) => {
  const { storeId, nome, preco, descricao, categoria, estoque } = req.body;
  const data = loadData();

  const product = {
    id: generateId(),
    storeId,
    nome,
    preco,
    descricao,
    categoria,
    estoque,
    ativo: true,
    criadoEm: new Date().toISOString()
  };

  data.products.push(product);
  saveData(data);
  res.json({ ok: true, product });
});

app.get('/api/products/store/:storeId', (req, res) => {
  const data = loadData();
  const products = data.products.filter(p => p.storeId === req.params.storeId && p.ativo);
  res.json({ ok: true, products });
});

app.put('/api/products/:id', (req, res) => {
  const data = loadData();
  const idx = data.products.findIndex(p => p.id === req.params.id);

  if (idx < 0) {
    return res.status(404).json({ ok: false, msg: 'Produto não encontrado.' });
  }

  data.products[idx] = { ...data.products[idx], ...req.body, updatedAt: new Date().toISOString() };
  saveData(data);
  res.json({ ok: true, product: data.products[idx] });
});

app.delete('/api/products/:id', (req, res) => {
  const data = loadData();
  const idx = data.products.findIndex(p => p.id === req.params.id);

  if (idx < 0) {
    return res.status(404).json({ ok: false, msg: 'Produto não encontrado.' });
  }

  data.products[idx].ativo = false;
  saveData(data);
  res.json({ ok: true });
});

// ============================================================
//  SEARCH PRODUTOS
// ============================================================

app.get('/api/products', (req, res) => {
  const { query, categoria } = req.query;
  const data = loadData();

  let products = data.products.filter(p => p.ativo);
  const activeStores = new Set(data.stores.filter(s => s.ativa).map(s => s.id));
  products = products.filter(p => activeStores.has(p.storeId));

  if (query) {
    const q = query.toLowerCase();
    products = products.filter(p =>
      p.nome.toLowerCase().includes(q) ||
      (p.descricao || '').toLowerCase().includes(q)
    );
  }

  if (categoria && categoria !== 'todas') {
    products = products.filter(p => p.categoria === categoria);
  }

  products = products.map(p => {
    const store = data.stores.find(s => s.id === p.storeId);
    return { ...p, loja: store || {} };
  });

  res.json({ ok: true, products });
});

// ============================================================
//  SEED DE DEMO
// ============================================================

app.post('/api/seed', (req, res) => {
  const data = loadData();

  if (data.users.length > 0) {
    return res.json({ ok: false, msg: 'Dados de demo já existem.' });
  }

  // Usuários
  const joao = {
    id: generateId(),
    nome: 'João Silva',
    email: 'loja@demo.com',
    senha: Buffer.from('123456').toString('base64'),
    tipo: 'lojista',
    criadoEm: new Date().toISOString()
  };

  const maria = {
    id: generateId(),
    nome: 'Maria Santos',
    email: 'maria@demo.com',
    senha: Buffer.from('123456').toString('base64'),
    tipo: 'lojista',
    criadoEm: new Date().toISOString()
  };

  const cliente = {
    id: generateId(),
    nome: 'Cliente Demo',
    email: 'cliente@demo.com',
    senha: Buffer.from('123456').toString('base64'),
    tipo: 'cliente',
    criadoEm: new Date().toISOString()
  };

  data.users = [joao, maria, cliente];

  // Lojas
  const lojaJoao = {
    id: generateId(),
    userId: joao.id,
    nome: 'Tech & Cia',
    descricao: 'Os melhores eletrônicos da cidade.',
    categoria: 'Eletrônicos',
    cidade: 'São Paulo',
    estado: 'SP',
    telefone: '(11) 99999-0001',
    ativa: true,
    criadoEm: new Date().toISOString()
  };

  const lojaMaria = {
    id: generateId(),
    userId: maria.id,
    nome: 'Moda Chic',
    descricao: 'Roupas e acessórios para todos os estilos.',
    categoria: 'Moda',
    cidade: 'Rio de Janeiro',
    estado: 'RJ',
    telefone: '(21) 99999-0002',
    ativa: true,
    criadoEm: new Date().toISOString()
  };

  data.stores = [lojaJoao, lojaMaria];

  // Produtos
  const produtos = [
    { nome: 'Fone Bluetooth Pro', preco: 299.90, categoria: 'Eletrônicos', estoque: 15, descricao: 'Fone sem fio com cancelamento de ruído.', storeId: lojaJoao.id },
    { nome: 'Smartwatch X500', preco: 599.00, categoria: 'Eletrônicos', estoque: 8, descricao: 'Monitora saúde e notificações.', storeId: lojaJoao.id },
    { nome: 'Carregador Turbo 65W', preco: 89.90, categoria: 'Eletrônicos', estoque: 30, descricao: 'Carrega qualquer dispositivo em minutos.', storeId: lojaJoao.id },
    { nome: 'Blusa Floral Verão', preco: 79.90, categoria: 'Moda', estoque: 20, descricao: 'Tecido leve e estampado.', storeId: lojaMaria.id },
    { nome: 'Calça Jeans Slim', preco: 149.90, categoria: 'Moda', estoque: 12, descricao: 'Corte moderno e confortável.', storeId: lojaMaria.id },
    { nome: 'Bolsa de Couro', preco: 249.00, categoria: 'Moda', estoque: 5, descricao: 'Elegante para o dia a dia.', storeId: lojaMaria.id }
  ];

  data.products = produtos.map(p => ({ ...p, id: generateId(), ativo: true, criadoEm: new Date().toISOString() }));

  saveData(data);
  res.json({ ok: true, msg: 'Dados de demo carregados com sucesso!' });
});

// ============================================================
//  INICIAR SERVIDOR
// ============================================================

app.listen(PORT, () => {
  console.log(`\n✅ Servidor rodando em http://localhost:${PORT}\n`);
  console.log('📁 Dados salvos em:', DATA_FILE);
  console.log('\n💡 Para carregar dados de demo, acesse: http://localhost:5800/api/seed\n');
});
