// ============================================================
//  server.js – Backend com Express
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const PORT = 5800;

// Configurar multer para upload de imagens
const uploadsDir = path.join(__dirname, 'images');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `profile-${Date.now()}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Apenas imagens são permitidas (JPEG, PNG, GIF)'));
    }
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ============================================================
//  BANCO DE DADOS SQLITE
// ============================================================

const db = new sqlite3.Database('./marketplace.db', (err) => {
  if (err) {
    console.error('Erro ao conectar ao banco de dados:', err.message);
  } else {
    console.log('Conectado ao banco de dados SQLite.');
  }
});

// Executar schema
const schemaSQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schemaSQL, (err) => {
  if (err) {
    console.error('Erro ao executar schema:', err.message);
  } else {
    console.log('Schema do banco de dados executado com sucesso.');
  }
});

// Função utilitária para queries
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function runCommand(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

// ============================================================
//  AUTH - REGISTRO
// ============================================================

app.post('/api/auth/register', async (req, res) => {
  const { nome, email, senha, tipo = 'cliente' } = req.body;

  if (!nome || !email || !senha) {
    return res.status(400).json({ ok: false, msg: 'Campos obrigatórios faltando.' });
  }

  try {
    // Verificar se email já existe
    const existing = await runQuery('SELECT id FROM usuarios WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ ok: false, msg: 'E-mail já cadastrado.' });
    }

    // Inserir usuário
    const result = await runCommand(
      'INSERT INTO usuarios (nome, email, senha_hash, tipo) VALUES (?, ?, ?, ?)',
      [nome, email, Buffer.from(senha).toString('base64'), tipo]
    );

    res.json({ ok: true, user: { id: result.id, nome, email, tipo } });
  } catch (err) {
    console.error('Erro no registro:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  AUTH - LOGIN
// ============================================================

app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ ok: false, msg: 'E-mail e senha obrigatórios.' });
  }

  try {
    const users = await runQuery(
      'SELECT id, nome, email, tipo, profile_image FROM usuarios WHERE email = ? AND senha_hash = ?',
      [email, Buffer.from(senha).toString('base64')]
    );

    if (users.length === 0) {
      return res.status(401).json({ ok: false, msg: 'E-mail ou senha incorretos.' });
    }

    const user = users[0];
    res.json({ ok: true, user });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  PERFIL DO USUÁRIO
// ============================================================

// Atualizar perfil do usuário
app.put('/api/users/:id', async (req, res) => {
  const { nome, telefone, data_nasc, endereco, cidade, estado, cep } = req.body;

  try {
    const updates = [];
    const params = [];

    if (nome !== undefined) {
      updates.push('nome = ?');
      params.push(nome);
    }
    if (telefone !== undefined) {
      updates.push('telefone = ?');
      params.push(telefone);
    }
    if (data_nasc !== undefined) {
      updates.push('data_nasc = ?');
      params.push(data_nasc);
    }
    if (endereco !== undefined) {
      updates.push('endereco = ?');
      params.push(endereco);
    }
    if (cidade !== undefined) {
      updates.push('cidade = ?');
      params.push(cidade);
    }
    if (estado !== undefined) {
      updates.push('estado = ?');
      params.push(estado);
    }
    if (cep !== undefined) {
      updates.push('cep = ?');
      params.push(cep);
    }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, msg: 'Nenhum campo para atualizar.' });
    }

    params.push(req.params.id);
    const result = await runCommand(
      `UPDATE usuarios SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, msg: 'Usuário não encontrado.' });
    }

    // Buscar usuário atualizado
    const users = await runQuery('SELECT * FROM usuarios WHERE id = ?', [req.params.id]);
    res.json({ ok: true, user: users[0] });
  } catch (err) {
    console.error('Erro ao atualizar perfil:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// Alterar senha
app.post('/api/users/:id/change-password', async (req, res) => {
  const { senhaAtual, senhaNova } = req.body;

  if (!senhaAtual || !senhaNova) {
    return res.status(400).json({ ok: false, msg: 'Campos obrigatórios faltando.' });
  }

  if (senhaNova.length < 6) {
    return res.status(400).json({ ok: false, msg: 'A nova senha deve ter pelo menos 6 caracteres.' });
  }

  try {
    const users = await runQuery('SELECT senha_hash FROM usuarios WHERE id = ?', [req.params.id]);
    if (users.length === 0) {
      return res.status(404).json({ ok: false, msg: 'Usuário não encontrado.' });
    }

    const senhaAtualEncoded = Buffer.from(senhaAtual).toString('base64');
    if (users[0].senha_hash !== senhaAtualEncoded) {
      return res.status(401).json({ ok: false, msg: 'Senha atual incorreta.' });
    }

    await runCommand(
      'UPDATE usuarios SET senha_hash = ? WHERE id = ?',
      [Buffer.from(senhaNova).toString('base64'), req.params.id]
    );

    res.json({ ok: true, msg: 'Senha alterada com sucesso.' });
  } catch (err) {
    console.error('Erro ao alterar senha:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// Deletar conta
app.delete('/api/users/:id', (req, res) => {
  const { senha } = req.body;
  const data = loadData();
  
  const idx = data.users.findIndex(u => u.id === req.params.id);
  if (idx < 0) {
    return res.status(404).json({ ok: false, msg: 'Usuário não encontrado.' });
  }
  
  const senhaEncoded = Buffer.from(senha).toString('base64');
  if (data.users[idx].senha !== senhaEncoded) {
    return res.status(401).json({ ok: false, msg: 'Senha incorreta. Não foi possível deletar a conta.' });
  }
  
  const userId = data.users[idx].id;
  
  // Remover usuário
  data.users.splice(idx, 1);
  
  // Remover lojas e produtos associados
  data.stores = data.stores.filter(s => s.userId !== userId);
  data.products = data.products.filter(p => !data.stores.find(s => s.id === p.storeId && s.userId === userId));
  
  saveData(data);
  res.json({ ok: true, msg: 'Conta deletada permanentemente.' });
});

// ============================================================
//  UPLOAD DE IMAGENS
// ============================================================

app.post('/api/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, msg: 'Nenhuma imagem foi enviada.' });
  }
  
  const imagePath = `/images/${req.file.filename}`;
  res.json({ ok: true, imagePath: imagePath, filename: req.file.filename });
});

// Atualizar imagem de perfil do usuário
app.put('/api/users/:id/profile-image', async (req, res) => {
  const { imagePath } = req.body;

  if (!imagePath) {
    return res.status(400).json({ ok: false, msg: 'Caminho da imagem obrigatório.' });
  }

  try {
    // Buscar imagem antiga
    const users = await runQuery('SELECT profile_image FROM usuarios WHERE id = ?', [req.params.id]);
    if (users.length === 0) {
      return res.status(404).json({ ok: false, msg: 'Usuário não encontrado.' });
    }

    // Deletar imagem antiga se existir
    if (users[0].profile_image) {
      const oldImagePath = path.join(__dirname, users[0].profile_image);
      if (fs.existsSync(oldImagePath)) {
        try {
          fs.unlinkSync(oldImagePath);
        } catch (err) {
          console.error('Erro ao deletar imagem antiga:', err);
        }
      }
    }

    // Atualizar no DB
    await runCommand('UPDATE usuarios SET profile_image = ? WHERE id = ?', [imagePath, req.params.id]);

    res.json({ ok: true, imagePath });
  } catch (err) {
    console.error('Erro ao atualizar imagem de perfil:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  LOJAS
// ============================================================

//  LOJAS
// ============================================================

app.post('/api/stores', async (req, res) => {
  const { userId, nome, descricao, categoria, cidade, estado, telefone } = req.body;

  if (!userId || !nome) {
    return res.status(400).json({ ok: false, msg: 'Campos obrigatórios faltando.' });
  }

  try {
    // Verificar se já existe loja para o usuário
    const existing = await runQuery('SELECT id FROM lojas WHERE usuario_id = ?', [userId]);

    if (existing.length > 0) {
      // Atualizar
      await runCommand(
        'UPDATE lojas SET nome = ?, descricao = ?, categoria = ?, cidade = ?, estado = ?, telefone = ? WHERE usuario_id = ?',
        [nome, descricao, categoria, cidade, estado, telefone, userId]
      );
      const stores = await runQuery('SELECT * FROM lojas WHERE usuario_id = ?', [userId]);
      return res.json({ ok: true, store: stores[0] });
    } else {
      // Criar nova
      const result = await runCommand(
        'INSERT INTO lojas (usuario_id, nome, descricao, categoria, cidade, estado, telefone) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, nome, descricao, categoria, cidade, estado, telefone]
      );
      const stores = await runQuery('SELECT * FROM lojas WHERE id = ?', [result.id]);
      return res.json({ ok: true, store: stores[0] });
    }
  } catch (err) {
    console.error('Erro ao salvar loja:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.get('/api/stores/:userId', async (req, res) => {
  try {
    const stores = await runQuery('SELECT * FROM lojas WHERE usuario_id = ?', [req.params.userId]);
    res.json({ ok: true, store: stores[0] || null });
  } catch (err) {
    console.error('Erro ao buscar loja:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.get('/api/stores-public', async (req, res) => {
  try {
    const stores = await runQuery('SELECT * FROM v_lojas_publicas');
    res.json({ ok: true, stores });
  } catch (err) {
    console.error('Erro ao buscar lojas públicas:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  PRODUTOS
// ============================================================

app.post('/api/products', async (req, res) => {
  const { storeId, nome, preco, descricao, categoria, estoque } = req.body;

  if (!storeId || !nome || !preco) {
    return res.status(400).json({ ok: false, msg: 'Campos obrigatórios faltando.' });
  }

  try {
    // Verificar categoria
    let categoriaId = null;
    if (categoria) {
      const cats = await runQuery('SELECT id FROM categorias WHERE nome = ?', [categoria]);
      if (cats.length > 0) {
        categoriaId = cats[0].id;
      }
    }

    const result = await runCommand(
      'INSERT INTO produtos (loja_id, nome, preco, descricao, categoria_id, estoque) VALUES (?, ?, ?, ?, ?, ?)',
      [storeId, nome, preco, descricao, categoriaId, estoque || 0]
    );

    const products = await runQuery('SELECT * FROM produtos WHERE id = ?', [result.id]);
    res.json({ ok: true, product: products[0] });
  } catch (err) {
    console.error('Erro ao criar produto:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.get('/api/products/store/:storeId', async (req, res) => {
  try {
    const products = await runQuery('SELECT * FROM produtos WHERE loja_id = ? AND ativo = 1', [req.params.storeId]);
    res.json({ ok: true, products });
  } catch (err) {
    console.error('Erro ao buscar produtos:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.put('/api/products/:id', async (req, res) => {
  const { nome, preco, descricao, categoria, estoque, ativo } = req.body;

  try {
    const updates = [];
    const params = [];

    if (nome !== undefined) {
      updates.push('nome = ?');
      params.push(nome);
    }
    if (preco !== undefined) {
      updates.push('preco = ?');
      params.push(preco);
    }
    if (descricao !== undefined) {
      updates.push('descricao = ?');
      params.push(descricao);
    }
    if (categoria !== undefined) {
      let categoriaId = null;
      if (categoria) {
        const cats = await runQuery('SELECT id FROM categorias WHERE nome = ?', [categoria]);
        if (cats.length > 0) {
          categoriaId = cats[0].id;
        }
      }
      updates.push('categoria_id = ?');
      params.push(categoriaId);
    }
    if (estoque !== undefined) {
      updates.push('estoque = ?');
      params.push(estoque);
    }
    if (ativo !== undefined) {
      updates.push('ativo = ?');
      params.push(ativo ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, msg: 'Nenhum campo para atualizar.' });
    }

    params.push(req.params.id);
    const result = await runCommand(
      `UPDATE produtos SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, msg: 'Produto não encontrado.' });
    }

    const products = await runQuery('SELECT * FROM produtos WHERE id = ?', [req.params.id]);
    res.json({ ok: true, product: products[0] });
  } catch (err) {
    console.error('Erro ao atualizar produto:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const result = await runCommand('UPDATE produtos SET ativo = 0 WHERE id = ?', [req.params.id]);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, msg: 'Produto não encontrado.' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao deletar produto:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  SEARCH PRODUTOS
// ============================================================

// ============================================================
//  SEARCH PRODUTOS
// ============================================================

app.get('/api/products', async (req, res) => {
  const { query, categoria } = req.query;

  try {
    let sql = 'SELECT * FROM v_produtos_publicos WHERE 1=1';
    const params = [];

    if (query) {
      sql += ' AND (lower(produto_nome) LIKE ? OR lower(descricao) LIKE ?)';
      const q = `%${query.toLowerCase()}%`;
      params.push(q, q);
    }

    if (categoria && categoria !== 'todas') {
      sql += ' AND categoria_nome = ?';
      params.push(categoria);
    }

    const products = await runQuery(sql, params);
    res.json({ ok: true, products });
  } catch (err) {
    console.error('Erro ao buscar produtos:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  SEED DE DEMO
// ============================================================

// ============================================================
//  SEED DE DEMO
// ============================================================

app.post('/api/migrate', async (req, res) => {
  try {
    // Verificar se já existem dados
    const users = await runQuery('SELECT COUNT(*) as count FROM usuarios');
    if (users[0].count > 0) {
      return res.json({ ok: false, msg: 'Dados já existem no banco.' });
    }

    // Carregar dados do JSON
    if (!fs.existsSync('./data.json')) {
      return res.json({ ok: false, msg: 'Arquivo data.json não encontrado.' });
    }

    const data = JSON.parse(fs.readFileSync('./data.json', 'utf8'));

    // Mapa de IDs antigos para novos
    const userIdMap = {};
    const storeIdMap = {};

    // Migrar usuários
    for (const user of data.users) {
      const result = await runCommand(
        'INSERT INTO usuarios (nome, email, senha_hash, tipo, profile_image, telefone, data_nasc, endereco, cidade, estado, cep) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          user.nome,
          user.email,
          user.senha,
          user.tipo,
          user.profileImage || null,
          user.telefone || null,
          user.data_nasc || null,
          user.endereco || null,
          user.cidade || null,
          user.estado || null,
          user.cep || null
        ]
      );
      userIdMap[user.id] = result.id;
    }

    // Migrar lojas
    for (const store of data.stores) {
      const result = await runCommand(
        'INSERT INTO lojas (usuario_id, nome, descricao, categoria, cidade, estado, telefone, ativa) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          userIdMap[store.userId],
          store.nome,
          store.descricao,
          store.categoria,
          store.cidade,
          store.estado,
          store.telefone,
          store.ativa ? 1 : 0
        ]
      );
      storeIdMap[store.id] = result.id;
    }

    // Migrar produtos
    for (const product of data.products) {
      const cat = await runQuery('SELECT id FROM categorias WHERE nome = ?', [product.categoria]);
      const categoriaId = cat.length > 0 ? cat[0].id : null;

      await runCommand(
        'INSERT INTO produtos (loja_id, nome, preco, descricao, categoria_id, estoque, ativo) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          storeIdMap[product.storeId],
          product.nome,
          product.preco,
          product.descricao,
          categoriaId,
          product.estoque,
          product.ativo ? 1 : 0
        ]
      );
    }

    res.json({ ok: true, msg: 'Migração concluída com sucesso!' });
  } catch (err) {
    console.error('Erro na migração:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.post('/api/seed', async (req, res) => {
  try {
    // Verificar se já existem dados
    const users = await runQuery('SELECT COUNT(*) as count FROM usuarios');
    if (users[0].count > 0) {
      return res.json({ ok: false, msg: 'Dados de demo já existem.' });
    }

    // Inserir usuários
    const joaoResult = await runCommand(
      'INSERT INTO usuarios (nome, email, senha_hash, tipo) VALUES (?, ?, ?, ?)',
      ['João Silva', 'loja@demo.com', Buffer.from('123456').toString('base64'), 'lojista']
    );
    const mariaResult = await runCommand(
      'INSERT INTO usuarios (nome, email, senha_hash, tipo) VALUES (?, ?, ?, ?)',
      ['Maria Santos', 'maria@demo.com', Buffer.from('123456').toString('base64'), 'lojista']
    );
    const clienteResult = await runCommand(
      'INSERT INTO usuarios (nome, email, senha_hash, tipo) VALUES (?, ?, ?, ?)',
      ['Cliente Demo', 'cliente@demo.com', Buffer.from('123456').toString('base64'), 'cliente']
    );

    // Inserir lojas
    await runCommand(
      'INSERT INTO lojas (usuario_id, nome, descricao, categoria, cidade, estado, telefone) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [joaoResult.id, 'Tech & Cia', 'Os melhores eletrônicos da cidade.', 'Eletrônicos', 'São Paulo', 'SP', '(11) 99999-0001']
    );
    await runCommand(
      'INSERT INTO lojas (usuario_id, nome, descricao, categoria, cidade, estado, telefone) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [mariaResult.id, 'Moda Chic', 'Roupas e acessórios para todos os estilos.', 'Moda', 'Rio de Janeiro', 'RJ', '(21) 99999-0002']
    );

    // Inserir produtos
    const produtos = [
      ['Fone Bluetooth Pro', 299.90, 'Eletrônicos', 15, 'Fone sem fio com cancelamento de ruído.'],
      ['Smartwatch X500', 599.00, 'Eletrônicos', 8, 'Monitora saúde e notificações.'],
      ['Carregador Turbo 65W', 89.90, 'Eletrônicos', 30, 'Carrega qualquer dispositivo em minutos.'],
      ['Blusa Floral Verão', 79.90, 'Moda', 20, 'Tecido leve e estampado.'],
      ['Calça Jeans Slim', 149.90, 'Moda', 12, 'Corte moderno e confortável.'],
      ['Bolsa de Couro', 249.00, 'Moda', 5, 'Elegante para o dia a dia.']
    ];

    for (let i = 0; i < produtos.length; i++) {
      const lojaId = i < 3 ? joaoResult.id : mariaResult.id;
      const cat = await runQuery('SELECT id FROM categorias WHERE nome = ?', [produtos[i][2]]);
      const categoriaId = cat.length > 0 ? cat[0].id : null;
      await runCommand(
        'INSERT INTO produtos (loja_id, nome, preco, categoria_id, estoque, descricao) VALUES (?, ?, ?, ?, ?, ?)',
        [lojaId, produtos[i][0], produtos[i][1], categoriaId, produtos[i][3], produtos[i][4]]
      );
    }

    res.json({ ok: true, msg: 'Dados de demo carregados com sucesso!' });
  } catch (err) {
    console.error('Erro no seed:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  INICIAR SERVIDOR
// ============================================================

// Middleware de erro para multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ ok: false, msg: 'Erro no upload: ' + err.message });
  } else if (err) {
    return res.status(400).json({ ok: false, msg: err.message });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`\n✅ Servidor rodando em http://localhost:${PORT}\n`);
  console.log('📁 Banco de dados SQLite: marketplace.db');
  console.log('\n💡 Para migrar dados do JSON: POST /api/migrate');
  console.log('💡 Para carregar dados de demo: POST /api/seed\n');
});
