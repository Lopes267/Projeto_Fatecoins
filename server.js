// ============================================================
//  server.js – Backend com Express
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');
const net = require('net');

const app = express();

// ============================================================
//  MIDDLEWARE
// ============================================================

// CORS
app.use(cors({
  origin: true, // Permite qualquer origem em desenvolvimento
  credentials: true
}));

// Parser JSON
app.use(express.json({ limit: '10mb' }));

// Parser URL-encoded
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos do frontend
app.use(express.static(path.join(__dirname)));

// Headers de segurança básicos
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ============================================================
//  CHROME DEVTOOLS ENDPOINT
// ============================================================

// Chrome DevTools tenta acessar este endpoint para configuração específica do app
app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  res.json({
    "app_name": "Site de Mercado Local",
    "app_version": "1.0.0",
    "description": "Sistema de marketplace local com autenticação Supabase"
  });
});

// Endpoint para configuração do cliente
app.get('/api/config', (req, res) => {
  res.json({
    api_url: `http://localhost:${req.socket.localPort}`,
    version: "1.0.0",
    environment: "development"
  });
});

// Função para encontrar uma porta livre automaticamente
function findAvailablePort(startPort = 3000, maxAttempts = 100) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let attempts = 0;

    function testPort() {
      if (attempts >= maxAttempts) {
        reject(new Error(`Não foi possível encontrar uma porta livre após ${maxAttempts} tentativas`));
        return;
      }

      const server = net.createServer();

      server.listen(port, '127.0.0.1', () => {
        server.close(() => {
          resolve(port);
        });
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          port++;
          attempts++;
          testPort();
        } else {
          reject(err);
        }
      });
    }

    testPort();
  });
}

// Porta inicial preferida
const PREFERRED_PORT = 4000;

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

// Middleware para verificar autenticação
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ ok: false, msg: 'Token de acesso necessário.' });
  }

  // Verificar se o token é válido criando um cliente com o token
  const supabaseWithToken = createClient(
    'https://foyepeemkkdadqgqrser.supabase.co',
    'sb_publishable_OIAlhhsg0SJw2O5i5aLsZg_rXSbbZyg',
    {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    }
  );

  req.supabase = supabaseWithToken;
  next();
}

// ============================================================
//  CONEXÃO COM SUPABASE
// ============================================================

const supabase = createClient(
  'https://foyepeemkkdadqgqrser.supabase.co',
  'sb_publishable_OIAlhhsg0SJw2O5i5aLsZg_rXSbbZyg'
);

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

async function pingSupabase() {
  const { error } = await supabase.from('usuarios').select('id').limit(1);
  if (error) {
    console.error('Erro ao conectar ao Supabase:', error.message);
  } else {
    console.log('Conectado ao Supabase.');
  }
}
pingSupabase();

// ============================================================
//  AUTH - REGISTRO
// ============================================================

app.post('/api/auth/register', async (req, res) => {
  const { nome, email, senha, tipo = 'cliente' } = req.body;

  if (!nome || !email || !senha) {
    return res.status(400).json({ ok: false, msg: 'Campos obrigatórios faltando.' });
  }

  try {
    // Validação básica de email no servidor
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ ok: false, msg: 'Formato de e-mail inválido.' });
    }

    // Primeiro, registrar no auth do Supabase
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password: senha,
    });

    if (authError) {
      console.error('Erro no registro auth:', authError);

      // Melhorar mensagens de erro específicas
      let errorMessage = 'Erro no registro. ';
      if (authError.message.includes('email_address_invalid')) {
        errorMessage += 'O e-mail fornecido não é válido. Use um e-mail real como exemplo@gmail.com';
      } else if (authError.message.includes('password')) {
        errorMessage += 'A senha deve ter pelo menos 6 caracteres.';
      } else if (authError.message.includes('already_registered')) {
        errorMessage += 'Este e-mail já está cadastrado.';
      } else {
        errorMessage += authError.message;
      }

      return res.status(400).json({ ok: false, msg: errorMessage });
    }

    // Se o registro foi bem-sucedido, criar o perfil do usuário
    if (authData.user) {
      const { data, error } = await supabase
        .from('usuarios')
        .insert([
          {
            id: authData.user.id, // Usar o mesmo ID do auth
            nome,
            email,
            senha_hash: hashPassword(senha), // Manter hash local também
            tipo
          }
        ])
        .select('id, nome, email, tipo')
        .single();

      if (error) {
        console.error('Erro ao criar perfil:', error);
        // Se der erro, tentar deletar o usuário do auth
        await supabase.auth.admin.deleteUser(authData.user.id);
        return res.status(500).json({ ok: false, msg: 'Erro ao criar perfil.' });
      }

      res.json({
        ok: true,
        user: data,
        session: {
          access_token: authData.session?.access_token,
          refresh_token: authData.session?.refresh_token
        }
      });
    } else {
      res.json({ ok: true, msg: 'Verifique seu e-mail para confirmar a conta.' });
    }
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
    // Fazer login no auth do Supabase
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password: senha,
    });

    if (authError) {
      console.error('Erro no login auth:', authError);
      return res.status(401).json({ ok: false, msg: 'E-mail ou senha incorretos.' });
    }

    // Buscar dados do perfil do usuário
    const { data: user, error: userError } = await supabase
      .from('usuarios')
      .select('id, nome, email, tipo, profile_image')
      .eq('id', authData.user.id)
      .single();

    if (userError || !user) {
      console.error('Erro ao buscar perfil:', userError);
      return res.status(500).json({ ok: false, msg: 'Erro ao carregar perfil.' });
    }

    res.json({
      ok: true,
      user,
      session: {
        access_token: authData.session.access_token,
        refresh_token: authData.session.refresh_token
      }
    });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error('Erro no logout:', error);
      return res.status(500).json({ ok: false, msg: 'Erro ao fazer logout.' });
    }
    res.json({ ok: true, msg: 'Logout realizado com sucesso.' });
  } catch (err) {
    console.error('Erro no logout:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  AUTH - VERIFICAR SESSÃO
// ============================================================

app.get('/api/auth/session', authenticateToken, async (req, res) => {
  try {
    const { data: { user }, error } = await req.supabase.auth.getUser();

    if (error || !user) {
      return res.status(401).json({ ok: false, msg: 'Sessão inválida.' });
    }

    // Buscar dados do perfil
    const { data: profile, error: profileError } = await req.supabase
      .from('usuarios')
      .select('id, nome, email, tipo, profile_image')
      .eq('id', user.id)
      .single();

    if (profileError) {
      console.error('Erro ao buscar perfil:', profileError);
      return res.status(500).json({ ok: false, msg: 'Erro ao carregar perfil.' });
    }

    res.json({ ok: true, user: profile });
  } catch (err) {
    console.error('Erro ao verificar sessão:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  PERFIL DO USUÁRIO
// ============================================================

// Atualizar perfil do usuário
app.put('/api/users/:id', authenticateToken, async (req, res) => {
  const { nome, telefone, data_nasc, endereco, cidade, estado, cep } = req.body;

  try {
    // Verificar se o usuário está atualizando seu próprio perfil
    const { data: { user }, error: authError } = await req.supabase.auth.getUser();
    if (authError || !user || user.id !== req.params.id) {
      return res.status(403).json({ ok: false, msg: 'Acesso negado.' });
    }

    const updates = {};

    if (nome !== undefined) updates.nome = nome;
    if (telefone !== undefined) updates.telefone = telefone;
    if (data_nasc !== undefined) updates.data_nasc = data_nasc;
    if (endereco !== undefined) updates.endereco = endereco;
    if (cidade !== undefined) updates.cidade = cidade;
    if (estado !== undefined) updates.estado = estado;
    if (cep !== undefined) updates.cep = cep;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, msg: 'Nenhum campo para atualizar.' });
    }

    const { data: updatedUser, error: updateError } = await req.supabase
      .from('usuarios')
      .update(updates)
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (updateError) {
      console.error('Erro ao atualizar perfil:', updateError);
      return res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
    }

    if (!updatedUser) {
      return res.status(404).json({ ok: false, msg: 'Usuário não encontrado.' });
    }

    res.json({ ok: true, user: updatedUser });
  } catch (err) {
    console.error('Erro ao atualizar perfil:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// Alterar senha
app.post('/api/users/:id/change-password', authenticateToken, async (req, res) => {
  const { senhaAtual, senhaNova } = req.body;

  if (!senhaAtual || !senhaNova) {
    return res.status(400).json({ ok: false, msg: 'Campos obrigatórios faltando.' });
  }

  if (senhaNova.length < 6) {
    return res.status(400).json({ ok: false, msg: 'A nova senha deve ter pelo menos 6 caracteres.' });
  }

  try {
    // Verificar se o usuário está alterando sua própria senha
    const { data: { user }, error: authError } = await req.supabase.auth.getUser();
    if (authError || !user || user.id !== req.params.id) {
      return res.status(403).json({ ok: false, msg: 'Acesso negado.' });
    }

    const { data: userData, error: userError } = await req.supabase
      .from('usuarios')
      .select('senha_hash')
      .eq('id', req.params.id)
      .single();

    if (userError || !userData) {
      return res.status(404).json({ ok: false, msg: 'Usuário não encontrado.' });
    }

    const isValidCurrentPassword = await comparePassword(senhaAtual, userData.senha_hash);
    if (!isValidCurrentPassword) {
      return res.status(401).json({ ok: false, msg: 'Senha atual incorreta.' });
    }

    const { error: updateError } = await req.supabase
      .from('usuarios')
      .update({ senha_hash: hashPassword(senhaNova) })
      .eq('id', req.params.id);

    if (updateError) {
      console.error('Erro ao alterar senha:', updateError);
      return res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
    }

    res.json({ ok: true, msg: 'Senha alterada com sucesso.' });
  } catch (err) {
    console.error('Erro ao alterar senha:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// Deletar conta
app.delete('/api/users/:id', authenticateToken, async (req, res) => {
  const { senha } = req.body;

  if (!senha) {
    return res.status(400).json({ ok: false, msg: 'Senha obrigatória para deletar a conta.' });
  }

  try {
    // Verificar se o usuário está deletando sua própria conta
    const { data: { user }, error: authError } = await req.supabase.auth.getUser();
    if (authError || !user || user.id !== req.params.id) {
      return res.status(403).json({ ok: false, msg: 'Acesso negado.' });
    }

    const { data: userData, error: userError } = await req.supabase
      .from('usuarios')
      .select('id, senha_hash')
      .eq('id', req.params.id)
      .single();

    if (userError || !userData) {
      return res.status(404).json({ ok: false, msg: 'Usuário não encontrado.' });
    }

    const isValidPassword = await comparePassword(senha, userData.senha_hash);
    if (!isValidPassword) {
      return res.status(401).json({ ok: false, msg: 'Senha incorreta. Não foi possível deletar a conta.' });
    }

    // Deletar do auth do Supabase primeiro
    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(user.id);
    if (authDeleteError) {
      console.error('Erro ao deletar usuário do auth:', authDeleteError);
      // Continuar mesmo com erro no auth, pois os dados serão deletados
    }

    const { data: stores, error: storesError } = await req.supabase
      .from('lojas')
      .select('id')
      .eq('usuario_id', req.params.id);

    if (storesError) {
      throw storesError;
    }

    const storeIds = (stores || []).map(store => store.id);

    if (storeIds.length > 0) {
      const { error: deleteProductsError } = await req.supabase
        .from('produtos')
        .delete()
        .in('loja_id', storeIds);

      if (deleteProductsError) throw deleteProductsError;

      const { error: deleteStoresError } = await req.supabase
        .from('lojas')
        .delete()
        .in('id', storeIds);

      if (deleteStoresError) throw deleteStoresError;
    }

    const { error: deleteUserError } = await req.supabase
      .from('usuarios')
      .delete()
      .eq('id', req.params.id);

    if (deleteUserError) {
      throw deleteUserError;
    }

    res.json({ ok: true, msg: 'Conta deletada permanentemente.' });
  } catch (err) {
    console.error('Erro ao deletar conta:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
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
    const { data: user, error: userError } = await supabase
      .from('usuarios')
      .select('profile_image')
      .eq('id', req.params.id)
      .single();

    if (userError || !user) {
      return res.status(404).json({ ok: false, msg: 'Usuário não encontrado.' });
    }

    if (user.profile_image) {
      const oldImagePath = path.join(__dirname, user.profile_image);
      if (fs.existsSync(oldImagePath)) {
        try {
          fs.unlinkSync(oldImagePath);
        } catch (err) {
          console.error('Erro ao deletar imagem antiga:', err);
        }
      }
    }

    const { error: updateError } = await supabase
      .from('usuarios')
      .update({ profile_image: imagePath })
      .eq('id', req.params.id);

    if (updateError) {
      throw updateError;
    }

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

app.post('/api/stores', authenticateToken, async (req, res) => {
  const { nome, descricao, categoria, cidade, estado, telefone } = req.body;

  if (!nome) {
    return res.status(400).json({ ok: false, msg: 'Nome da loja é obrigatório.' });
  }

  try {
    // Usar o ID do usuário autenticado
    const { data: { user }, error: authError } = await req.supabase.auth.getUser();
    if (authError || !user) {
      return res.status(401).json({ ok: false, msg: 'Não autorizado.' });
    }

    const userId = user.id;

    const { data: existing, error: existingError } = await req.supabase
      .from('lojas')
      .select('*')
      .eq('usuario_id', userId)
      .limit(1);

    if (existingError) throw existingError;

    if (existing.length > 0) {
      const { data: store, error: updateError } = await req.supabase
        .from('lojas')
        .update({ nome, descricao, categoria, cidade, estado, telefone })
        .eq('usuario_id', userId)
        .select('*')
        .single();

      if (updateError) throw updateError;
      return res.json({ ok: true, store });
    }

    const { data: store, error } = await req.supabase
      .from('lojas')
      .insert([
        { usuario_id: userId, nome, descricao, categoria, cidade, estado, telefone }
      ])
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ ok: true, store });
  } catch (err) {
    console.error('Erro ao salvar loja:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.get('/api/stores/:userId', authenticateToken, async (req, res) => {
  try {
    // Verificar se o usuário está buscando sua própria loja
    const { data: { user }, error: authError } = await req.supabase.auth.getUser();
    if (authError || !user || user.id !== req.params.userId) {
      return res.status(403).json({ ok: false, msg: 'Acesso negado.' });
    }

    const { data: store, error } = await req.supabase
      .from('lojas')
      .select('*')
      .eq('usuario_id', req.params.userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    res.json({ ok: true, store: store || null });
  } catch (err) {
    console.error('Erro ao buscar loja:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.get('/api/stores-public', async (req, res) => {
  try {
    const { data: stores, error } = await supabase
      .from('v_lojas_publicas')
      .select('*');

    if (error) throw error;
    res.json({ ok: true, stores });
  } catch (err) {
    console.error('Erro ao buscar lojas públicas:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  PRODUTOS
// ============================================================

app.post('/api/products', authenticateToken, async (req, res) => {
  const { storeId, nome, preco, descricao, categoria, estoque } = req.body;

  if (!storeId || !nome || !preco) {
    return res.status(400).json({ ok: false, msg: 'Campos obrigatórios faltando.' });
  }

  try {
    // Verificar se o usuário é dono da loja
    const { data: { user }, error: authError } = await req.supabase.auth.getUser();
    if (authError || !user) {
      return res.status(401).json({ ok: false, msg: 'Não autorizado.' });
    }

    const { data: store, error: storeError } = await req.supabase
      .from('lojas')
      .select('usuario_id')
      .eq('id', storeId)
      .single();

    if (storeError || !store || store.usuario_id !== user.id) {
      return res.status(403).json({ ok: false, msg: 'Acesso negado. Você não é dono desta loja.' });
    }

    let categoriaId = null;
    if (categoria) {
      const { data: cats, error: catError } = await req.supabase
        .from('categorias')
        .select('id')
        .eq('nome', categoria)
        .limit(1);
      if (catError) throw catError;
      if (cats.length > 0) categoriaId = cats[0].id;
    }

    const { data: product, error } = await req.supabase
      .from('produtos')
      .insert([
        {
          loja_id: storeId,
          nome,
          preco,
          descricao,
          categoria_id: categoriaId,
          estoque: estoque || 0,
          ativo: true
        }
      ])
      .select('*')
      .single();

    if (error) throw error;
    res.json({ ok: true, product });
  } catch (err) {
    console.error('Erro ao criar produto:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.get('/api/products/store/:storeId', async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from('produtos')
      .select('*')
      .eq('loja_id', req.params.storeId)
      .eq('ativo', true);

    if (error) throw error;
    res.json({ ok: true, products });
  } catch (err) {
    console.error('Erro ao buscar produtos:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.put('/api/products/:id', authenticateToken, async (req, res) => {
  const { nome, preco, descricao, categoria, estoque, ativo } = req.body;

  try {
    // Verificar se o usuário é dono do produto (através da loja)
    const { data: { user }, error: authError } = await req.supabase.auth.getUser();
    if (authError || !user) {
      return res.status(401).json({ ok: false, msg: 'Não autorizado.' });
    }

    // Verificar se o produto existe e pertence ao usuário
    const { data: productCheck, error: checkError } = await req.supabase
      .from('produtos')
      .select('loja_id')
      .eq('id', req.params.id)
      .single();

    if (checkError || !productCheck) {
      return res.status(404).json({ ok: false, msg: 'Produto não encontrado.' });
    }

    const { data: store, error: storeError } = await req.supabase
      .from('lojas')
      .select('usuario_id')
      .eq('id', productCheck.loja_id)
      .single();

    if (storeError || !store || store.usuario_id !== user.id) {
      return res.status(403).json({ ok: false, msg: 'Acesso negado. Você não é dono deste produto.' });
    }

    const updates = {};

    if (nome !== undefined) updates.nome = nome;
    if (preco !== undefined) updates.preco = preco;
    if (descricao !== undefined) updates.descricao = descricao;
    if (estoque !== undefined) updates.estoque = estoque;
    if (ativo !== undefined) updates.ativo = ativo;

    if (categoria !== undefined) {
      if (categoria) {
        const { data: cats, error: catError } = await req.supabase
          .from('categorias')
          .select('id')
          .eq('nome', categoria)
          .limit(1);
        if (catError) throw catError;
        updates.categoria_id = cats.length > 0 ? cats[0].id : null;
      } else {
        updates.categoria_id = null;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, msg: 'Nenhum campo para atualizar.' });
    }

    const { data: product, error } = await req.supabase
      .from('produtos')
      .update(updates)
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ ok: false, msg: 'Produto não encontrado.' });
      }
      throw error;
    }

    res.json({ ok: true, product });
  } catch (err) {
    console.error('Erro ao atualizar produto:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.delete('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    // Verificar se o usuário é dono do produto
    const { data: { user }, error: authError } = await req.supabase.auth.getUser();
    if (authError || !user) {
      return res.status(401).json({ ok: false, msg: 'Não autorizado.' });
    }

    // Verificar se o produto existe e pertence ao usuário
    const { data: productCheck, error: checkError } = await req.supabase
      .from('produtos')
      .select('loja_id')
      .eq('id', req.params.id)
      .single();

    if (checkError || !productCheck) {
      return res.status(404).json({ ok: false, msg: 'Produto não encontrado.' });
    }

    const { data: store, error: storeError } = await req.supabase
      .from('lojas')
      .select('usuario_id')
      .eq('id', productCheck.loja_id)
      .single();

    if (storeError || !store || store.usuario_id !== user.id) {
      return res.status(403).json({ ok: false, msg: 'Acesso negado. Você não é dono deste produto.' });
    }

    const { error } = await req.supabase
      .from('produtos')
      .update({ ativo: false })
      .eq('id', req.params.id);

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ ok: false, msg: 'Produto não encontrado.' });
      }
      throw error;
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

app.get('/api/products', async (req, res) => {
  const { query, categoria } = req.query;

  try {
    let builder = supabase.from('v_produtos_publicos').select('*');

    if (query) {
      const q = `%${query}%`;
      builder = builder.or(`produto_nome.ilike.${q},descricao.ilike.${q}`);
    }

    if (categoria && categoria !== 'todas') {
      builder = builder.eq('categoria_nome', categoria);
    }

    const { data: products, error } = await builder;
    if (error) throw error;

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
    const { count, error: countError } = await supabase
      .from('usuarios')
      .select('id', { count: 'exact', head: true });

    if (countError) throw countError;
    if (count > 0) {
      return res.json({ ok: false, msg: 'Dados já existem no banco.' });
    }

    if (!fs.existsSync('./data.json')) {
      return res.json({ ok: false, msg: 'Arquivo data.json não encontrado.' });
    }

    const data = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
    const userIdMap = {};
    const storeIdMap = {};

    for (const user of data.users) {
      const { data: insertedUser, error: userError } = await supabase
        .from('usuarios')
        .insert([
          {
            nome: user.nome,
            email: user.email,
            senha_hash: hashPassword(user.senha),
            tipo: user.tipo,
            profile_image: user.profileImage || null,
            telefone: user.telefone || null,
            data_nasc: user.data_nasc || null,
            endereco: user.endereco || null,
            cidade: user.cidade || null,
            estado: user.estado || null,
            cep: user.cep || null
          }
        ])
        .select('id')
        .single();

      if (userError) throw userError;
      userIdMap[user.id] = insertedUser.id;
    }

    for (const store of data.stores) {
      const { data: insertedStore, error: storeError } = await supabase
        .from('lojas')
        .insert([
          {
            usuario_id: userIdMap[store.userId],
            nome: store.nome,
            descricao: store.descricao,
            categoria: store.categoria,
            cidade: store.cidade,
            estado: store.estado,
            telefone: store.telefone,
            ativa: store.ativa ? true : false
          }
        ])
        .select('id')
        .single();

      if (storeError) throw storeError;
      storeIdMap[store.id] = insertedStore.id;
    }

    for (const product of data.products) {
      let categoriaId = null;
      if (product.categoria) {
        const { data: cats, error: catError } = await supabase
          .from('categorias')
          .select('id')
          .eq('nome', product.categoria)
          .limit(1);

        if (catError) throw catError;
        if (cats.length > 0) categoriaId = cats[0].id;
      }

      const { error: productError } = await supabase
        .from('produtos')
        .insert([
          {
            loja_id: storeIdMap[product.storeId],
            nome: product.nome,
            preco: product.preco,
            descricao: product.descricao,
            categoria_id: categoriaId,
            estoque: product.estoque,
            ativo: product.ativo ? true : false
          }
        ]);

      if (productError) throw productError;
    }

    res.json({ ok: true, msg: 'Migração concluída com sucesso!' });
  } catch (err) {
    console.error('Erro na migração:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.post('/api/seed', async (req, res) => {
  try {
    const { count, error: countError } = await supabase
      .from('usuarios')
      .select('id', { count: 'exact', head: true });

    if (countError) throw countError;
    if (count > 0) {
      return res.json({ ok: false, msg: 'Dados de demo já existem.' });
    }

    const { data: joaoUser, error: joaoError } = await supabase
      .from('usuarios')
      .insert([
        { nome: 'João Silva', email: 'loja@demo.com', senha_hash: hashPassword('123456'), tipo: 'lojista' }
      ])
      .select('id')
      .single();
    if (joaoError) throw joaoError;

    const { data: mariaUser, error: mariaError } = await supabase
      .from('usuarios')
      .insert([
        { nome: 'Maria Santos', email: 'maria@demo.com', senha_hash: hashPassword('123456'), tipo: 'lojista' }
      ])
      .select('id')
      .single();
    if (mariaError) throw mariaError;

    const { data: clienteUser, error: clienteError } = await supabase
      .from('usuarios')
      .insert([
        { nome: 'Cliente Demo', email: 'cliente@demo.com', senha_hash: hashPassword('123456'), tipo: 'cliente' }
      ])
      .select('id')
      .single();
    if (clienteError) throw clienteError;

    const { error: lojasError } = await supabase.from('lojas').insert([
      {
        usuario_id: joaoUser.id,
        nome: 'Tech & Cia',
        descricao: 'Os melhores eletrônicos da cidade.',
        categoria: 'Eletrônicos',
        cidade: 'São Paulo',
        estado: 'SP',
        telefone: '(11) 99999-0001'
      },
      {
        usuario_id: mariaUser.id,
        nome: 'Moda Chic',
        descricao: 'Roupas e acessórios para todos os estilos.',
        categoria: 'Moda',
        cidade: 'Rio de Janeiro',
        estado: 'RJ',
        telefone: '(21) 99999-0002'
      }
    ]);
    if (lojasError) throw lojasError;

    const produtos = [
      ['Fone Bluetooth Pro', 299.9, 'Eletrônicos', 15, 'Fone sem fio com cancelamento de ruído.'],
      ['Smartwatch X500', 599.0, 'Eletrônicos', 8, 'Monitora saúde e notificações.'],
      ['Carregador Turbo 65W', 89.9, 'Eletrônicos', 30, 'Carrega qualquer dispositivo em minutos.'],
      ['Blusa Floral Verão', 79.9, 'Moda', 20, 'Tecido leve e estampado.'],
      ['Calça Jeans Slim', 149.9, 'Moda', 12, 'Corte moderno e confortável.'],
      ['Bolsa de Couro', 249.0, 'Moda', 5, 'Elegante para o dia a dia.']
    ];

    for (let i = 0; i < produtos.length; i++) {
      const lojaId = i < 3 ? joaoUser.id : mariaUser.id;
      const { data: cats, error: catError } = await supabase
        .from('categorias')
        .select('id')
        .eq('nome', produtos[i][2])
        .limit(1);

      if (catError) throw catError;
      const categoriaId = cats.length > 0 ? cats[0].id : null;

      const { error: productError } = await supabase.from('produtos').insert([
        {
          loja_id: lojaId,
          nome: produtos[i][0],
          preco: produtos[i][1],
          categoria_id: categoriaId,
          estoque: produtos[i][3],
          descricao: produtos[i][4],
          ativo: true
        }
      ]);

      if (productError) throw productError;
    }

    res.json({ ok: true, msg: 'Dados de demo carregados com sucesso!' });
  } catch (err) {
    console.error('Erro no seed:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  CLIENT-SIDE ROUTING
// ============================================================

// Catch-all handler: serve index.html para rotas do frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
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

// Função para iniciar o servidor com porta automática
async function startServer() {
  try {
    console.log('🔍 Procurando uma porta livre...');

    // Tenta usar a porta preferida primeiro
    let port;
    try {
      await findAvailablePort(PREFERRED_PORT, 1);
      port = PREFERRED_PORT;
      console.log(`✅ Porta ${port} está livre!`);
    } catch {
      console.log(`⚠️ Porta ${PREFERRED_PORT} ocupada, procurando outra...`);
      port = await findAvailablePort(PREFERRED_PORT + 1);
      console.log(`✅ Porta ${port} encontrada e livre!`);
    }

    app.listen(port, () => {
      console.log(`\n🚀 Servidor rodando em http://localhost:${port}`);
      console.log('📁 Conectado ao Supabase');
      console.log('\n💡 Para migrar dados do JSON: POST /api/migrate');
      console.log('💡 Para carregar dados de demo: POST /api/seed');
      console.log('\n💻 Abra no navegador: http://localhost:' + port);
    });
  } catch (error) {
    console.error('❌ Erro ao iniciar servidor:', error.message);
    process.exit(1);
  }
}

// Iniciar servidor automaticamente após todas as rotas serem definidas
process.nextTick(() => {
  startServer();
});
