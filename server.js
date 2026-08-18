// ============================================================
//  server.js – Backend com Express + Firebase
// ============================================================

require('dotenv').config();

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');
const multer  = require('multer');
const bcrypt  = require('bcrypt');
const net     = require('net');
const https   = require('https');
const crypto  = require('crypto');   // códigos de confirmação de entrega
const admin   = require('firebase-admin');

// ============================================================
//  FIREBASE – CONFIGURAÇÃO
// ============================================================

const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;

const serviceAccount = require('./' + process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
// Permite gravar objetos de produto que tenham campos undefined (ex.: peso/imagem)
db.settings({ ignoreUndefinedProperties: true });

// ============================================================
//  CLOUDINARY – CONFIGURAÇÃO (imagens)
// ============================================================

const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ============================================================
//  EXPRESS – MIDDLEWARE
// ============================================================

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname), {
  // Evita que o navegador rode HTML/JS antigos em cache (correções passam a valer na hora)
  setHeaders: (res, filePath) => {
    if (/\.(html|js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  }
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ============================================================
//  MULTER – UPLOAD DE IMAGENS
// ============================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    if (allowed.test(file.mimetype) && allowed.test(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Apenas imagens são permitidas (JPEG, PNG, GIF, WebP)'));
    }
  }
});

// ============================================================
//  HELPERS
// ============================================================

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Login via Firebase Identity Toolkit REST API → retorna idToken
function firebaseSignIn(email, password) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ email, password, returnSecureToken: true });
    const options = {
      hostname: 'identitytoolkit.googleapis.com',
      path: `/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Upload para Cloudinary
function uploadToCloudinary(file, folder, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, resource_type: 'image' },
      (error, result) => {
        if (error) { console.error('Erro no upload Cloudinary:', error); resolve({ success: false, error: error.message }); }
        else resolve({ success: true, url: result.secure_url, public_id: result.public_id });
      }
    );
    stream.end(file.buffer);
  });
}

// Deletar imagem do Cloudinary
async function deleteFromCloudinary(publicId) {
  try {
    if (publicId) await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error('Erro ao deletar imagem:', error.message);
  }
}

// Extrair public_id de uma URL do Cloudinary
function extractCloudinaryPublicId(url) {
  if (!url || !url.includes('cloudinary.com')) return null;
  try {
    const parts = url.split('/upload/');
    if (parts.length < 2) return null;
    const withoutVersion = parts[1].replace(/^v\d+\//, '');
    return withoutVersion.replace(/\.[^.]+$/, '');
  } catch {
    return null;
  }
}

// ============================================================
//  MIDDLEWARE – AUTENTICAÇÃO
// ============================================================

async function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ ok: false, msg: 'Token de acesso necessário.' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ ok: false, msg: 'Token inválido ou expirado.' });
  }
}

// ============================================================
//  ENDPOINTS UTILITÁRIOS
// ============================================================

app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  res.json({ app_name: 'Site de Mercado Local', app_version: '1.0.0', description: 'Marketplace local com Firebase' });
});

app.get('/api/config', (req, res) => {
  res.json({ api_url: `http://localhost:${req.socket.localPort}`, version: '1.0.0', environment: 'development' });
});

app.get('/api/stats', async (req, res) => {
  try {
    const [usersSnap, productsSnap] = await Promise.all([
      db.collection('usuarios').where('tipo', '==', 'cliente').get(),
      db.collection('produtos').get()
    ]);
    res.json({ ok: true, clientes: usersSnap.size, produtos: productsSnap.size });
  } catch (err) {
    console.error('Erro ao buscar stats:', err);
    res.status(500).json({ ok: false, clientes: 0, produtos: 0 });
  }
});

// ============================================================
//  AUTH – REGISTRO
// ============================================================

app.post('/api/auth/register', async (req, res) => {
  const { nome, email, senha, tipo = 'cliente' } = req.body;

  if (!nome || !email || !senha) {
    return res.status(400).json({ ok: false, msg: 'Campos obrigatórios faltando.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, msg: 'Formato de e-mail inválido.' });
  }
  if (!['lojista', 'cliente', 'entregador'].includes(tipo)) {
    return res.status(400).json({ ok: false, msg: 'Tipo de conta inválido.' });
  }

  try {
    let firebaseUser;
    try {
      firebaseUser = await admin.auth().createUser({ email, password: senha, displayName: nome });
    } catch (authError) {
      let msg = 'Erro no registro. ';
      if (authError.code === 'auth/email-already-exists') msg += 'Este e-mail já está cadastrado.';
      else if (authError.code === 'auth/weak-password')   msg += 'A senha deve ter pelo menos 6 caracteres.';
      else if (authError.code === 'auth/invalid-email')   msg += 'E-mail inválido.';
      else msg += authError.message;
      return res.status(400).json({ ok: false, msg });
    }

    await db.collection('usuarios').doc(firebaseUser.uid).set({
      nome, email, senha_hash: hashPassword(senha), tipo,
      profile_image: null, telefone: null, data_nasc: null,
      endereco: null, cidade: null, estado: null, cep: null,
      criado_em: admin.firestore.FieldValue.serverTimestamp()
    });

    const loginData = await firebaseSignIn(email, senha);
    if (loginData.error) {
      return res.json({ ok: true, msg: 'Conta criada. Faça login para continuar.' });
    }

    res.json({
      ok: true,
      user: { id: firebaseUser.uid, nome, email, tipo },
      session: { access_token: loginData.idToken, refresh_token: loginData.refreshToken }
    });
  } catch (err) {
    console.error('Erro no registro:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  AUTH – LOGIN
// ============================================================

app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ ok: false, msg: 'E-mail e senha obrigatórios.' });

  try {
    const loginData = await firebaseSignIn(email, senha);
    if (loginData.error) {
      return res.status(401).json({ ok: false, msg: 'E-mail ou senha incorretos.' });
    }

    const userDoc = await db.collection('usuarios').doc(loginData.localId).get();
    if (!userDoc.exists) return res.status(404).json({ ok: false, msg: 'Perfil não encontrado.' });

    const userData = userDoc.data();
    res.json({
      ok: true,
      user: { id: loginData.localId, nome: userData.nome, email: userData.email, tipo: userData.tipo, profile_image: userData.profile_image },
      session: { access_token: loginData.idToken, refresh_token: loginData.refreshToken }
    });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  AUTH – LOGOUT
// ============================================================

app.post('/api/auth/logout', (req, res) => {
  // Com Firebase o logout é feito no cliente; o token expira automaticamente (1 hora)
  res.json({ ok: true, msg: 'Logout realizado com sucesso.' });
});

// ============================================================
//  AUTH – VERIFICAR SESSÃO
// ============================================================

app.get('/api/auth/session', authenticateToken, async (req, res) => {
  try {
    const userDoc = await db.collection('usuarios').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ ok: false, msg: 'Usuário não encontrado.' });
    const data = userDoc.data();
    res.json({ ok: true, user: { id: req.user.uid, nome: data.nome, email: data.email, tipo: data.tipo, profile_image: data.profile_image } });
  } catch (err) {
    console.error('Erro ao verificar sessão:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  PERFIL DO USUÁRIO – ATUALIZAR
// ============================================================

app.put('/api/users/:id', authenticateToken, async (req, res) => {
  if (req.user.uid !== req.params.id) return res.status(403).json({ ok: false, msg: 'Acesso negado.' });

  const campos = ['nome', 'telefone', 'data_nasc', 'endereco', 'cidade', 'estado', 'cep'];
  const updates = {};
  for (const campo of campos) {
    if (req.body[campo] !== undefined) updates[campo] = req.body[campo];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ ok: false, msg: 'Nenhum campo para atualizar.' });

  try {
    await db.collection('usuarios').doc(req.params.id).update(updates);
    const userDoc = await db.collection('usuarios').doc(req.params.id).get();
    res.json({ ok: true, user: { id: req.params.id, ...userDoc.data() } });
  } catch (err) {
    console.error('Erro ao atualizar perfil:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  PERFIL DO USUÁRIO – ALTERAR SENHA
// ============================================================

app.post('/api/users/:id/change-password', authenticateToken, async (req, res) => {
  if (req.user.uid !== req.params.id) return res.status(403).json({ ok: false, msg: 'Acesso negado.' });

  const { senhaAtual, senhaNova } = req.body;
  if (!senhaAtual || !senhaNova) return res.status(400).json({ ok: false, msg: 'Campos obrigatórios faltando.' });
  if (senhaNova.length < 6) return res.status(400).json({ ok: false, msg: 'A nova senha deve ter pelo menos 6 caracteres.' });

  try {
    const userDoc = await db.collection('usuarios').doc(req.params.id).get();
    if (!userDoc.exists) return res.status(404).json({ ok: false, msg: 'Usuário não encontrado.' });

    const isValid = await comparePassword(senhaAtual, userDoc.data().senha_hash);
    if (!isValid) return res.status(401).json({ ok: false, msg: 'Senha atual incorreta.' });

    await admin.auth().updateUser(req.params.id, { password: senhaNova });
    await db.collection('usuarios').doc(req.params.id).update({ senha_hash: hashPassword(senhaNova) });

    res.json({ ok: true, msg: 'Senha alterada com sucesso.' });
  } catch (err) {
    console.error('Erro ao alterar senha:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  PERFIL DO USUÁRIO – DELETAR CONTA
// ============================================================

app.delete('/api/users/:id', authenticateToken, async (req, res) => {
  if (req.user.uid !== req.params.id) return res.status(403).json({ ok: false, msg: 'Acesso negado.' });

  const { senha } = req.body;
  if (!senha) return res.status(400).json({ ok: false, msg: 'Senha obrigatória para deletar a conta.' });

  try {
    const userDoc = await db.collection('usuarios').doc(req.params.id).get();
    if (!userDoc.exists) return res.status(404).json({ ok: false, msg: 'Usuário não encontrado.' });

    const isValid = await comparePassword(senha, userDoc.data().senha_hash);
    if (!isValid) return res.status(401).json({ ok: false, msg: 'Senha incorreta.' });

    // Deletar produtos e lojas do usuário
    const storesSnap = await db.collection('lojas').where('usuario_id', '==', req.params.id).get();
    for (const storeDoc of storesSnap.docs) {
      const productsSnap = await db.collection('produtos').where('loja_id', '==', storeDoc.id).get();
      const batch = db.batch();
      productsSnap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      await storeDoc.ref.delete();
    }

    await db.collection('usuarios').doc(req.params.id).delete();
    await admin.auth().deleteUser(req.params.id);

    res.json({ ok: true, msg: 'Conta deletada permanentemente.' });
  } catch (err) {
    console.error('Erro ao deletar conta:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  IMAGENS – UPLOAD GENÉRICO
// ============================================================

app.post('/api/upload-image', authenticateToken, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: 'Nenhuma imagem foi enviada.' });
  try {
    const { folder = 'general' } = req.body;
    const publicId = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const result = await uploadToCloudinary(req.file, folder, publicId);
    if (!result.success) return res.status(500).json({ ok: false, msg: result.error });
    res.json({ ok: true, imageUrl: result.url, public_id: result.public_id });
  } catch (err) {
    console.error('Erro no upload:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  IMAGENS – FOTO DE PERFIL
// ============================================================

app.put('/api/users/:id/profile-image', authenticateToken, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: 'Nenhuma imagem foi enviada.' });
  if (req.user.uid !== req.params.id) return res.status(403).json({ ok: false, msg: 'Acesso negado.' });

  try {
    const userDoc = await db.collection('usuarios').doc(req.params.id).get();
    if (!userDoc.exists) return res.status(404).json({ ok: false, msg: 'Usuário não encontrado.' });

    const oldPublicId = extractCloudinaryPublicId(userDoc.data().profile_image);
    const publicId = `profile-${req.params.id}-${Date.now()}`;
    const result = await uploadToCloudinary(req.file, 'profiles', publicId);
    if (!result.success) return res.status(500).json({ ok: false, msg: result.error });

    if (oldPublicId) await deleteFromCloudinary(oldPublicId);
    await db.collection('usuarios').doc(req.params.id).update({ profile_image: result.url });
    res.json({ ok: true, imageUrl: result.url });
  } catch (err) {
    console.error('Erro ao atualizar imagem de perfil:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  IMAGENS – LOGO DA LOJA
// ============================================================

app.put('/api/stores/:id/logo', authenticateToken, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: 'Nenhuma imagem foi enviada.' });
  try {
    const storeDoc = await db.collection('lojas').doc(req.params.id).get();
    if (!storeDoc.exists) return res.status(404).json({ ok: false, msg: 'Loja não encontrada.' });
    if (storeDoc.data().usuario_id !== req.user.uid) return res.status(403).json({ ok: false, msg: 'Acesso negado.' });

    const oldPublicId = extractCloudinaryPublicId(storeDoc.data().logo_url);
    const publicId = `logo-${req.params.id}-${Date.now()}`;
    const result = await uploadToCloudinary(req.file, 'stores', publicId);
    if (!result.success) return res.status(500).json({ ok: false, msg: result.error });

    if (oldPublicId) await deleteFromCloudinary(oldPublicId);
    await db.collection('lojas').doc(req.params.id).update({ logo_url: result.url });
    res.json({ ok: true, logoUrl: result.url });
  } catch (err) {
    console.error('Erro ao atualizar logo:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  IMAGENS – BANNER DA LOJA
// ============================================================

app.put('/api/stores/:id/banner', authenticateToken, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: 'Nenhuma imagem foi enviada.' });
  try {
    const storeDoc = await db.collection('lojas').doc(req.params.id).get();
    if (!storeDoc.exists) return res.status(404).json({ ok: false, msg: 'Loja não encontrada.' });
    if (storeDoc.data().usuario_id !== req.user.uid) return res.status(403).json({ ok: false, msg: 'Acesso negado.' });

    const oldPublicId = extractCloudinaryPublicId(storeDoc.data().banner_url);
    const publicId = `banner-${req.params.id}-${Date.now()}`;
    const result = await uploadToCloudinary(req.file, 'stores', publicId);
    if (!result.success) return res.status(500).json({ ok: false, msg: result.error });

    if (oldPublicId) await deleteFromCloudinary(oldPublicId);
    await db.collection('lojas').doc(req.params.id).update({ banner_url: result.url });
    res.json({ ok: true, bannerUrl: result.url });
  } catch (err) {
    console.error('Erro ao atualizar banner:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  IMAGENS – IMAGEM DO PRODUTO
// ============================================================

app.put('/api/products/:id/image', authenticateToken, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: 'Nenhuma imagem foi enviada.' });
  try {
    const productDoc = await db.collection('produtos').doc(req.params.id).get();
    if (!productDoc.exists) return res.status(404).json({ ok: false, msg: 'Produto não encontrado.' });

    const storeDoc = await db.collection('lojas').doc(productDoc.data().loja_id).get();
    if (!storeDoc.exists || storeDoc.data().usuario_id !== req.user.uid) {
      return res.status(403).json({ ok: false, msg: 'Acesso negado.' });
    }

    const oldPublicId = extractCloudinaryPublicId(productDoc.data().imagem_url);
    const publicId = `product-${req.params.id}-${Date.now()}`;
    const result = await uploadToCloudinary(req.file, 'products', publicId);
    if (!result.success) return res.status(500).json({ ok: false, msg: result.error });

    if (oldPublicId) await deleteFromCloudinary(oldPublicId);
    await db.collection('produtos').doc(req.params.id).update({ imagem_url: result.url });
    res.json({ ok: true, imageUrl: result.url });
  } catch (err) {
    console.error('Erro ao atualizar imagem do produto:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  LOJAS – CRIAR / ATUALIZAR
// ============================================================

app.post('/api/stores', authenticateToken, async (req, res) => {
  const { nome, descricao, categoria, cidade, estado, telefone, cep } = req.body;
  if (!nome) return res.status(400).json({ ok: false, msg: 'Nome da loja é obrigatório.' });

  const cepLimpo = cep ? String(cep).replace(/\D/g, '') : null;

  try {
    const existing = await db.collection('lojas').where('usuario_id', '==', req.user.uid).limit(1).get();

    if (!existing.empty) {
      const ref = existing.docs[0].ref;
      await ref.update({ nome, descricao, categoria, cidade, estado, telefone, cep: cepLimpo });
      const updated = await ref.get();
      return res.json({ ok: true, store: { id: ref.id, ...updated.data() } });
    }

    const ref = await db.collection('lojas').add({
      usuario_id: req.user.uid, nome, descricao, categoria, cidade, estado, telefone, cep: cepLimpo,
      logo_url: null, banner_url: null, ativa: true,
      criado_em: admin.firestore.FieldValue.serverTimestamp()
    });
    const storeDoc = await ref.get();
    res.json({ ok: true, store: { id: ref.id, ...storeDoc.data() } });
  } catch (err) {
    console.error('Erro ao salvar loja:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  LOJAS – BUSCAR LOJA DO USUÁRIO
// ============================================================

app.get('/api/stores/:userId', authenticateToken, async (req, res) => {
  if (req.user.uid !== req.params.userId) return res.status(403).json({ ok: false, msg: 'Acesso negado.' });
  try {
    const snap = await db.collection('lojas').where('usuario_id', '==', req.params.userId).limit(1).get();
    if (snap.empty) return res.json({ ok: true, store: null });
    const doc = snap.docs[0];
    res.json({ ok: true, store: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.error('Erro ao buscar loja:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  LOJAS – LOJAS PÚBLICAS
// ============================================================

app.get('/api/stores-public', async (req, res) => {
  try {
    const snap = await db.collection('lojas').where('ativa', '==', true).get();
    const stores = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      const [userDoc, prodsSnap] = await Promise.all([
        db.collection('usuarios').doc(data.usuario_id).get(),
        db.collection('produtos').where('loja_id', '==', doc.id).where('ativo', '==', true).get()
      ]);
      stores.push({
        id: doc.id, ...data,
        usuario_nome:  userDoc.exists ? userDoc.data().nome  : null,
        usuario_email: userDoc.exists ? userDoc.data().email : null,
        totalProdutos: prodsSnap.size
      });
    }
    res.json({ ok: true, stores });
  } catch (err) {
    console.error('Erro ao buscar lojas públicas:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  PRODUTOS – CRIAR
// ============================================================

// Medida em centímetros. Zero/vazio vira null de propósito: "não informado" e
// "mede 0 cm" são coisas diferentes, e tratar as duas como 0 faria um produto
// sem medida caber em qualquer lugar.
function medidaCm(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
}

app.post('/api/products', authenticateToken, async (req, res) => {
  const { storeId, nome, preco, descricao, categoria, estoque, peso } = req.body;
  if (!storeId || !nome || !preco) return res.status(400).json({ ok: false, msg: 'Campos obrigatórios faltando.' });

  try {
    const storeDoc = await db.collection('lojas').doc(storeId).get();
    if (!storeDoc.exists || storeDoc.data().usuario_id !== req.user.uid) {
      return res.status(403).json({ ok: false, msg: 'Acesso negado.' });
    }

    const ref = await db.collection('produtos').add({
      loja_id: storeId, nome, preco, descricao, categoria: categoria || null,
      estoque: estoque || 0, peso: peso || 0, ativo: true, imagem_url: null,
      // Medidas da embalagem — é por elas que a fila decide se o pedido cabe
      // na moto ou exige carro
      comprimento: medidaCm(req.body.comprimento),
      largura:     medidaCm(req.body.largura),
      altura:      medidaCm(req.body.altura),
      criado_em: admin.firestore.FieldValue.serverTimestamp()
    });
    const productDoc = await ref.get();
    res.json({ ok: true, product: { id: ref.id, ...productDoc.data() } });
  } catch (err) {
    console.error('Erro ao criar produto:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  PRODUTOS – LISTAR POR LOJA
// ============================================================

app.get('/api/products/store/:storeId', async (req, res) => {
  try {
    const snap = await db.collection('produtos')
      .where('loja_id', '==', req.params.storeId)
      .where('ativo', '==', true)
      .get();
    res.json({ ok: true, products: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) {
    console.error('Erro ao buscar produtos:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  PRODUTOS – ATUALIZAR
// ============================================================

app.put('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const productDoc = await db.collection('produtos').doc(req.params.id).get();
    if (!productDoc.exists) return res.status(404).json({ ok: false, msg: 'Produto não encontrado.' });

    const storeDoc = await db.collection('lojas').doc(productDoc.data().loja_id).get();
    if (!storeDoc.exists || storeDoc.data().usuario_id !== req.user.uid) {
      return res.status(403).json({ ok: false, msg: 'Acesso negado.' });
    }

    const campos = ['nome', 'preco', 'descricao', 'categoria', 'estoque', 'peso', 'ativo'];
    const updates = {};
    for (const campo of campos) {
      if (req.body[campo] !== undefined) updates[campo] = req.body[campo];
    }
    // Medidas passam pelo saneamento, não direto do body
    for (const campo of ['comprimento', 'largura', 'altura']) {
      if (req.body[campo] !== undefined) updates[campo] = medidaCm(req.body[campo]);
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ ok: false, msg: 'Nenhum campo para atualizar.' });

    await db.collection('produtos').doc(req.params.id).update(updates);
    const updated = await db.collection('produtos').doc(req.params.id).get();
    res.json({ ok: true, product: { id: req.params.id, ...updated.data() } });
  } catch (err) {
    console.error('Erro ao atualizar produto:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  PRODUTOS – DELETAR (soft delete)
// ============================================================

app.delete('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const productDoc = await db.collection('produtos').doc(req.params.id).get();
    if (!productDoc.exists) return res.status(404).json({ ok: false, msg: 'Produto não encontrado.' });

    const storeDoc = await db.collection('lojas').doc(productDoc.data().loja_id).get();
    if (!storeDoc.exists || storeDoc.data().usuario_id !== req.user.uid) {
      return res.status(403).json({ ok: false, msg: 'Acesso negado.' });
    }

    await db.collection('produtos').doc(req.params.id).update({ ativo: false });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao deletar produto:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  PRODUTOS – BUSCA PÚBLICA
// ============================================================

app.get('/api/products', async (req, res) => {
  const { query, categoria } = req.query;
  try {
    const snap = await db.collection('produtos').where('ativo', '==', true).get();
    let products = [];

    for (const doc of snap.docs) {
      const data = doc.data();
      const storeDoc = await db.collection('lojas').doc(data.loja_id).get();
      if (!storeDoc.exists || !storeDoc.data().ativa) continue;
      products.push({
        id:         doc.id,
        nome:       data.nome,
        preco:      data.preco,
        descricao:  data.descricao,
        imagem_url: data.imagem_url,
        categoria:  data.categoria,
        estoque:    data.estoque,
        // Peso e medidas ficam ocultos do comprador; servem ao frete e a decidir
        // em que veículo o pedido cabe
        peso:        data.peso || 0,
        comprimento: data.comprimento ?? null,
        largura:     data.largura ?? null,
        altura:      data.altura ?? null,
        nota_media: data.nota_media || 0,
        nota_count: data.nota_count || 0,
        loja: {
          id:     data.loja_id,
          nome:   storeDoc.data().nome,
          cidade: storeDoc.data().cidade,
          estado: storeDoc.data().estado
        }
      });
    }

    if (query) {
      const q = query.toLowerCase();
      products = products.filter(p =>
        p.nome?.toLowerCase().includes(q) ||
        p.descricao?.toLowerCase().includes(q)
      );
    }

    if (categoria && categoria !== 'todas') {
      products = products.filter(p => p.categoria === categoria);
    }

    res.json({ ok: true, products });
  } catch (err) {
    console.error('Erro ao buscar produtos:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  CARRINHO – vinculado ao usuário logado (cliente OU lojista)
//  Estrutura no Firestore:
//    carrinho (coleção)
//      └─ {uid} (documento do dono — guarda cliente_id e atualizado_em)
//           └─ produtos (subcoleção)
//                └─ {produtoId} (um documento por produto, com qty)
//  Como a chave é o uid do token, cada usuário só vê o próprio carrinho.
// ============================================================

// Referência da subcoleção de produtos do carrinho de um usuário
function cartProdutosRef(uid) {
  return db.collection('carrinho').doc(uid).collection('produtos');
}

// Buscar o carrinho do usuário autenticado (consulta no Firestore)
app.get('/api/cart', authenticateToken, async (req, res) => {
  try {
    const snap = await cartProdutosRef(req.user.uid).get();
    const items = snap.docs.map(d => d.data());
    res.json({ ok: true, items });
  } catch (err) {
    console.error('Erro ao buscar carrinho:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// Salvar/substituir o carrinho do usuário autenticado
// Cada item vira um documento na subcoleção "produtos" (id do doc = id do produto)
app.put('/api/cart', authenticateToken, async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  try {
    const col   = cartProdutosRef(req.user.uid);
    const batch = db.batch();

    // 1) limpa os produtos atuais
    const existing = await col.get();
    existing.docs.forEach(d => batch.delete(d.ref));

    // 2) grava os produtos enviados (um doc por produto)
    items.forEach(item => {
      const docId = String(item.id || col.doc().id);
      batch.set(col.doc(docId), item);
    });

    // 3) marca o dono no documento pai (para o carrinho aparecer ligado ao cliente)
    batch.set(db.collection('carrinho').doc(req.user.uid), {
      cliente_id: req.user.uid,
      atualizado_em: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await batch.commit();
    res.json({ ok: true, items });
  } catch (err) {
    console.error('Erro ao salvar carrinho:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// Esvaziar o carrinho do usuário autenticado
app.delete('/api/cart', authenticateToken, async (req, res) => {
  try {
    const col   = cartProdutosRef(req.user.uid);
    const batch = db.batch();
    const existing = await col.get();
    existing.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    await db.collection('carrinho').doc(req.user.uid).delete().catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao limpar carrinho:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  PEDIDOS – registra o que cada cliente comprou (coleção "pedidos")
//  Necessário para liberar avaliação só de produtos comprados.
// ============================================================

// Registrar uma compra (chamado ao concluir o checkout)
app.post('/api/orders', authenticateToken, async (req, res) => {
  const itens = Array.isArray(req.body.itens) ? req.body.itens : [];
  if (!itens.length) return res.status(400).json({ ok: false, msg: 'Pedido vazio.' });
  try {
    const normalizados = itens.map(i => ({
      produto_id: String(i.id || i.produto_id || ''),
      nome:       i.nome || 'Produto',
      preco:      Number(i.preco) || 0,
      qty:        Number(i.qty) || 1,
      imagem_url: i.imagem_url || null,
      categoria:  i.categoria || null,
      loja_id:    (i.loja && i.loja.id)   || i.loja_id   || null,
      loja_nome:  (i.loja && i.loja.nome) || i.loja_nome || null,
      // Peso e medidas seguem para o pedido: sem eles não há como saber em que
      // veículo a entrega cabe (antes ficavam só no produto e se perdiam aqui)
      peso:        Number(i.peso) || 0,
      comprimento: medidaCm(i.comprimento),
      largura:     medidaCm(i.largura),
      altura:      medidaCm(i.altura)
    })).filter(i => i.produto_id);

    if (!normalizados.length) return res.status(400).json({ ok: false, msg: 'Itens inválidos.' });

    const produto_ids = [...new Set(normalizados.map(i => i.produto_id))];
    const loja_ids    = [...new Set(normalizados.map(i => i.loja_id).filter(Boolean))];
    const total = normalizados.reduce((s, i) => s + i.preco * i.qty, 0);

    // Dados do comprador (para o lojista ver quem comprou)
    const userDoc = await db.collection('usuarios').doc(req.user.uid).get();
    const perfil = userDoc.exists ? userDoc.data() : {};
    const usuario_nome  = perfil.nome  || 'Cliente';
    const usuario_email = perfil.email || null;

    // Endereço de entrega: o que o checkout mandou, completado pelo CEP (ViaCEP)
    // e, no que faltar, pelo cadastro do cliente. É o que o entregador vai ver.
    const entrega = await montarEnderecoEntrega(req.body.entrega || {}, perfil);

    // --- Tarifa do entregador: congelada agora, para ele ver antes de aceitar ---
    // A corrida sai da loja e termina no cliente. Com várias lojas, o ponto de
    // partida é a primeira que tem coordenada, e cada loja conta como parada.
    let origemColeta = null;
    for (const id of loja_ids) {
      origemColeta = await coordsDaLoja(id);
      if (origemColeta) break;
    }
    const tarifa = calcularTarifa({
      distanciaKm: distanciaKm(origemColeta, entrega),
      paradas: loja_ids.length || 1
    });

    // Baixa o estoque conforme a quantidade comprada de cada produto
    const qtyPorProduto = {};
    normalizados.forEach(i => { qtyPorProduto[i.produto_id] = (qtyPorProduto[i.produto_id] || 0) + i.qty; });
    for (const [pid, qty] of Object.entries(qtyPorProduto)) {
      const pref = db.collection('produtos').doc(pid);
      const pdoc = await pref.get();
      if (pdoc.exists) {
        const atual = Number(pdoc.data().estoque) || 0;
        await pref.update({ estoque: Math.max(0, atual - qty) });
      }
    }

    const agora = new Date().toISOString();
    const dadosPedido = {
      usuario_id: req.user.uid,
      usuario_nome, usuario_email,
      usuario_telefone: perfil.telefone || null,
      itens: normalizados,
      produto_ids,                               // facilita checar "comprou este produto?"
      loja_ids,                                  // facilita listar vendas por loja
      total: Math.round(total * 100) / 100,
      // --- entrega: o pedido nasce na fila, esperando um entregador aceitar ---
      entrega_status: 'aguardando',
      entrega,
      entregador_id: null,
      entregador_nome: null,
      entregador_telefone: null,
      entregador_local: null,                    // última posição GPS enviada pelo entregador
      entrega_historico: [{ status: 'aguardando', em: agora }],
      // Quanto o entregador recebe por esta corrida, e como esse número foi feito
      entrega_tarifa: tarifa.valor,
      entrega_tarifa_detalhe: tarifa.detalhe,
      // Peso, volume e maior item — é com isto que a fila decide se o pedido
      // cabe no veículo de quem está olhando
      entrega_medidas: envelopeDoPedido(normalizados),
      entrega_origem: origemColeta,              // de onde sai a coleta
      // Código que o cliente dita na porta. Só sai daqui para o próprio cliente:
      // nenhuma rota do entregador devolve este campo.
      entrega_codigo: gerarCodigoEntrega(),
      entrega_tentativas: 0,
      entrega_bloqueada: false,
      criado_em: admin.firestore.FieldValue.serverTimestamp()
    };
    const ref = await db.collection('pedidos').add(dadosPedido);
    // O código volta junto: é o pedido de quem está pedindo, e mostrá-lo já na
    // tela de sucesso é o que evita o cliente descobrir que ele existe só quando
    // o entregador bate na porta.
    res.json({ ok: true, pedido: { id: ref.id, codigo: dadosPedido.entrega_codigo } });
  } catch (err) {
    console.error('Erro ao registrar pedido:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// Vendas da(s) loja(s) do lojista autenticado — quem comprou cada produto
app.get('/api/sales', authenticateToken, async (req, res) => {
  try {
    const lojasSnap = await db.collection('lojas').where('usuario_id', '==', req.user.uid).get();
    const myLojaIds = lojasSnap.docs.map(d => d.id);
    if (!myLojaIds.length) return res.json({ ok: true, vendas: [], total: 0 });

    // Consulta só os pedidos que tocam as minhas lojas, usando o loja_ids gravado na criação.
    // (Antes isto lia a coleção inteira e filtrava em memória: uma leitura por pedido do
    //  marketplace a cada abertura do painel.) array-contains-any aceita 30 valores por
    //  consulta, então lojistas com mais de 30 lojas viram vários lotes, deduplicados por id.
    const lotes = [];
    for (let i = 0; i < myLojaIds.length; i += 30) lotes.push(myLojaIds.slice(i, i + 30));
    const docsPorId = new Map();
    for (const lote of lotes) {
      const snap = await db.collection('pedidos').where('loja_ids', 'array-contains-any', lote).get();
      snap.docs.forEach(d => docsPorId.set(d.id, d));
    }
    const pedidosSnap = { docs: [...docsPorId.values()] };

    const vendas = [];
    pedidosSnap.docs.forEach(d => {
      const ped = d.data();
      (ped.itens || []).forEach(it => {
        if (myLojaIds.includes(it.loja_id)) {
          const data = ped.criado_em && ped.criado_em.toDate ? ped.criado_em.toDate().toISOString() : null;
          vendas.push({
            pedido_id: d.id,
            produto_nome: it.nome,
            qty: it.qty || 1,
            preco: it.preco || 0,
            subtotal: Math.round((it.preco || 0) * (it.qty || 1) * 100) / 100,
            comprador: ped.usuario_nome || 'Cliente',
            comprador_email: ped.usuario_email || null,
            data
          });
        }
      });
    });
    vendas.sort((a, b) => (b.data || '').localeCompare(a.data || ''));   // mais recentes primeiro
    const total = vendas.reduce((s, v) => s + v.subtotal, 0);
    res.json({ ok: true, vendas, total: Math.round(total * 100) / 100 });
  } catch (err) {
    console.error('Erro ao listar vendas:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// Listar os produtos comprados pelo usuário (para a aba "Minhas Compras")
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    const snap = await db.collection('pedidos').where('usuario_id', '==', req.user.uid).get();
    const porProduto = {};                       // agrupa por produto (última compra vence)
    snap.docs.forEach(d => {
      (d.data().itens || []).forEach(it => {
        if (it.produto_id) porProduto[it.produto_id] = { ...it, pedido_id: d.id };
      });
    });
    res.json({ ok: true, produtos: Object.values(porProduto) });
  } catch (err) {
    console.error('Erro ao listar pedidos:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  ENTREGAS – o entregador escolhe um pedido e compartilha o GPS
//
//  Os dados vivem no próprio documento de "pedidos" (não há coleção nova):
//    entrega_status ....... aguardando → aceito → a_caminho → entregue
//    entrega .............. endereço do cliente (+ lat/lng quando dá para geocodificar)
//    entregador_id/nome ... quem aceitou (null enquanto está na fila)
//    entregador_local ..... última posição enviada pelo app do entregador
//    entrega_historico .... carimbo de cada mudança de status
// ============================================================

const ENTREGA_FLUXO = ['aguardando', 'aceito', 'a_caminho', 'entregue'];

// ============================================================
//  O QUE CABE EM QUE VEÍCULO
//
//  Encaixar caixas num compartimento é bin packing 3D — NP-difícil, e resolver
//  de verdade seria exagero para uma sacola de mercado. Em vez disso usamos as
//  duas checagens que a logística real usa, e que pegam quase todos os casos:
//
//    1. O MAIOR ITEM cabe? Um cabo de vassoura de 120 cm não entra num baú de
//       80 cm, e nenhuma conta de volume conserta isso.
//    2. O VOLUME TOTAL cabe, descontando o ar entre as caixas?
//
//  Não é exato — mas erra para o lado seguro e é explicável ao entregador.
// ============================================================

// Caixas não se encaixam perfeitamente: sobra ar entre elas. 75% é a folga
// usada em logística para carga miúda e variada.
const APROVEITAMENTO = 0.75;

// Um item cabe girado de qualquer jeito? Ordenar os dois trios em ordem
// decrescente e comparar posição a posição resolve as 6 rotações de uma vez:
// o maior lado do item tem que caber no maior lado do compartimento, e assim
// por diante.
function itemCabe(item, caixa) {
  const a = [...item].sort((x, y) => y - x);
  const b = [...caixa].sort((x, y) => y - x);
  return a[0] <= b[0] && a[1] <= b[1] && a[2] <= b[2];
}

// Resume o pedido inteiro num "envelope": peso, volume e o maior item.
// itens_sem_medida é contado e exposto — um pedido meio medido não pode passar
// por totalmente medido.
function envelopeDoPedido(itens) {
  let peso = 0, volumeL = 0, semMedida = 0;
  let maiorItem = null, maiorLado = 0;

  (itens || []).forEach(i => {
    const qty = Number(i.qty) || 1;
    peso += (Number(i.peso) || 0) * qty;

    const c = medidaCm(i.comprimento), l = medidaCm(i.largura), a = medidaCm(i.altura);
    if (c && l && a) {
      volumeL += (c * l * a / 1000) * qty;      // cm³ → litros
      const maior = Math.max(c, l, a);
      if (maior > maiorLado) { maiorLado = maior; maiorItem = [c, l, a]; }
    } else {
      semMedida += qty;
    }
  });

  return {
    peso_kg:  Math.round(peso * 100) / 100,
    volume_l: Math.round(volumeL * 10) / 10,
    maior_item: maiorItem,                      // [c,l,a] do item mais comprido
    itens_sem_medida: semMedida
  };
}

// Capacidade declarada pelo entregador. Campo faltando vira null — capacidade
// pela metade não filtra nada, e é melhor não filtrar do que filtrar errado.
function capacidadeValida(cap) {
  if (!cap) return null;
  const c = medidaCm(cap.comprimento), l = medidaCm(cap.largura), a = medidaCm(cap.altura);
  const p = Number(cap.peso_max);
  if (!c || !l || !a) return null;
  return { comprimento: c, largura: l, altura: a,
           peso_max: Number.isFinite(p) && p > 0 ? p : null,
           categoria: cap.categoria || null };
}

// Veredito para um pedido: cabe, não cabe, ou não dá para saber.
//   { cabe: true|false, motivo, incerto }
// incerto=true significa "tem item sem medida" — o pedido aparece na fila com
// aviso, em vez de sumir. Esconder trabalho por falta de cadastro do lojista
// puniria o entregador por um erro que não é dele.
function cabeNoVeiculo(env, cap) {
  if (!cap) return { cabe: true, motivo: 'Capacidade do veículo não cadastrada', incerto: true };
  if (!env) return { cabe: true, motivo: 'Pedido sem medidas', incerto: true };

  if (cap.peso_max && env.peso_kg > cap.peso_max) {
    return { cabe: false, motivo: `Pesa ${env.peso_kg} kg — seu limite é ${cap.peso_max} kg`, incerto: false };
  }
  if (env.maior_item && !itemCabe(env.maior_item, [cap.comprimento, cap.largura, cap.altura])) {
    const [c, l, a] = env.maior_item;
    return { cabe: false, motivo: `Tem item de ${c}×${l}×${a} cm — não entra no seu compartimento`, incerto: false };
  }
  const capacidadeL = (cap.comprimento * cap.largura * cap.altura / 1000) * APROVEITAMENTO;
  if (env.volume_l > capacidadeL) {
    return { cabe: false, motivo: `Ocupa ~${env.volume_l} L — cabem ~${Math.round(capacidadeL)} L`, incerto: false };
  }
  if (env.itens_sem_medida > 0) {
    return { cabe: true, incerto: true,
             motivo: `${env.itens_sem_medida} item(ns) sem medida cadastrada — confira antes de sair` };
  }
  return { cabe: true, motivo: null, incerto: false };
}

// ============================================================
//  TARIFA DO ENTREGADOR
//
//  O entregador precisa saber quanto vai ganhar ANTES de aceitar — senão a
//  escolha vira aposta. A tarifa é calculada uma vez, na criação do pedido, e
//  congelada no documento: o que ele viu na fila é o que ele recebe, mesmo que
//  a tabela mude depois.
//
//  Note que a tarifa NÃO acompanha o valor da mercadoria. Levar um pedido de
//  R$ 900 a 8 km dá o mesmo trabalho que levar um de R$ 50 a 8 km — pagar por
//  valor premiaria sorte, não esforço.
// ============================================================
const TARIFA = {
  base:       5.00,   // sair, pegar o pacote, encarar o trânsito
  por_km:     1.20,   // distância da coleta até o cliente
  por_parada: 1.50,   // cada loja onde é preciso passar (pedido com 2 lojas = 2 paradas)
  minimo:     7.00,   // ninguém roda por menos que isto
  // Sem coordenadas não dá para medir a distância. Em vez de pagar só a base
  // (que puniria o entregador por uma falha nossa de geocodificação), assume-se
  // uma corrida curta típica de bairro.
  km_presumido: 3
};

function calcularTarifa({ distanciaKm, paradas = 1 }) {
  const km = distanciaKm != null ? distanciaKm : TARIFA.km_presumido;
  const bruto = TARIFA.base
              + km * TARIFA.por_km
              + Math.max(1, paradas) * TARIFA.por_parada;
  const valor = Math.max(TARIFA.minimo, bruto);
  return {
    valor: Math.round(valor * 100) / 100,
    // A composição vai junto para o painel poder explicar o número em vez de
    // só exibi-lo — entregador que não entende a conta desconfia dela.
    detalhe: {
      base: TARIFA.base,
      km: Math.round(km * 10) / 10,
      valor_km: Math.round(km * TARIFA.por_km * 100) / 100,
      paradas: Math.max(1, paradas),
      valor_paradas: Math.round(Math.max(1, paradas) * TARIFA.por_parada * 100) / 100,
      estimado: distanciaKm == null,   // distância presumida, não medida
      minimo_aplicado: valor > bruto
    }
  };
}

// Coordenadas da loja, para saber de onde sai a corrida. Geocodifica na primeira
// vez e grava no documento da loja — as próximas leituras são de graça.
async function coordsDaLoja(lojaId) {
  if (!lojaId) return null;
  try {
    const ref = db.collection('lojas').doc(String(lojaId));
    const doc = await ref.get();
    if (!doc.exists) return null;
    const l = doc.data();

    const jaTem = coordsValidas(l);
    if (jaTem) return jaTem;
    if (l.geo_falhou) return null;      // não insiste a cada pedido num endereço que não resolve

    const coords = await geocodificarEndereco({
      logradouro: l.endereco || null, numero: null, bairro: null,
      cidade: l.cidade || null, uf: l.estado || null, cep: l.cep || null
    });
    if (coords) {
      await ref.update({ lat: coords.lat, lng: coords.lng, geo_precisao: coords.precisao }).catch(() => {});
      return { lat: coords.lat, lng: coords.lng };
    }
    await ref.update({ geo_falhou: true }).catch(() => {});
    return null;
  } catch {
    return null;   // tarifa não pode derrubar a criação do pedido
  }
}

// ============================================================
//  CÓDIGO DE CONFIRMAÇÃO DE ENTREGA
//
//  Quem prova que a entrega aconteceu é o CLIENTE, não o entregador. O sistema
//  gera um código, mostra só para o cliente, e o entregador só finaliza (e só
//  recebe) digitando o código que o cliente dita na porta.
//
//  Duas regras que sustentam isso:
//    1. o código NUNCA entra em nenhuma resposta destinada ao entregador;
//    2. tentativa errada é contada — 4 dígitos são adivinháveis por força bruta
//       se ninguém estiver contando.
// ============================================================
const TENTATIVAS_MAX = 5;

function gerarCodigoEntrega() {
  // 4 dígitos: curto o bastante para ser ditado em voz alta na porta.
  // A proteção real contra adivinhação é o limite de tentativas, não o tamanho.
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

// Só o dono do tipo certo passa. Devolve o perfil, ou null (já respondeu o erro).
async function exigirTipo(req, res, tipo) {
  const doc = await db.collection('usuarios').doc(req.user.uid).get();
  if (!doc.exists) { res.status(404).json({ ok: false, msg: 'Usuário não encontrado.' }); return null; }
  const perfil = doc.data();
  if (perfil.tipo !== tipo) {
    res.status(403).json({ ok: false, msg: `Acesso restrito a contas do tipo "${tipo}".` });
    return null;
  }
  return perfil;
}

// Lê uma coordenada vinda do cliente. CUIDADO: Number(null) é 0 e Number.isFinite(0)
// é true — foi assim que endereços sem GPS acabaram gravados na "Ilha Nula" (0,0),
// no Golfo da Guiné. Aqui, ausência de valor vira null de verdade.
function coordenada(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// O marketplace é brasileiro: coordenada fora daqui (ou exatamente 0,0) é erro,
// não endereço. Serve de rede de segurança para qualquer origem de coordenada.
function coordenadaPlausivel(lat, lng) {
  if (lat === null || lng === null) return false;
  if (lat === 0 && lng === 0) return false;                    // Ilha Nula
  return lat >= -34.5 && lat <= 5.5 && lng >= -74.5 && lng <= -33.5;
}

// Devolve { lat, lng } do par se ele for plausível; senão null.
function coordsValidas(o) {
  if (!o) return null;
  const lat = coordenada(o.lat), lng = coordenada(o.lng);
  return coordenadaPlausivel(lat, lng) ? { lat, lng } : null;
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// Margem de erro do GPS, em metros. Um navegador de computador não tem GPS:
// ele estima pela rede/IP e erra de centenas de metros a dezenas de quilômetros.
// Aceitar essa leitura como "ponto exato" manda o entregador para outro bairro —
// pior do que não ter coordenada nenhuma, porque parece confiável.
const GPS_BOM_M  = 100;    // até 100 m: é GPS de verdade, vale mais que o geocoder
const GPS_MEIO_M = 1000;   // até 1 km: só serve se o geocoder não achar o número
                           // acima disso: descartado, o endereço escrito é melhor

// Distância em km entre dois pontos (haversine).
// Só calcula com coordenadas plausíveis — senão devolveria "5.900 km" por causa
// de um ponto inválido, que é pior do que não mostrar distância nenhuma.
function distanciaKm(a, b) {
  const p1 = coordsValidas(a), p2 = coordsValidas(b);
  if (!p1 || !p2) return null;
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(p2.lat - p1.lat), dLng = rad(p2.lng - p1.lng);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(p1.lat)) * Math.cos(rad(p2.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

// Mesma conta, sem arredondar — para somar trechos curtos de trajeto, onde
// arredondar para 100 m a cada ping zeraria a soma inteira.
function distanciaMetros(a, b) {
  const p1 = coordsValidas(a), p2 = coordsValidas(b);
  if (!p1 || !p2) return null;
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(p2.lat - p1.lat), dLng = rad(p2.lng - p1.lng);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(p1.lat)) * Math.cos(rad(p2.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- Cache de geocodificação ----------
// Geocodificar custa até 6 consultas ao Nominatim com 1,1 s de espera entre elas
// (a política deles é 1 consulta/segundo), tudo dentro da criação do pedido: o
// cliente ficava olhando a tela girar. Endereço é dado estável, então o resultado
// é guardado por CEP+número — o segundo pedido para a mesma casa sai instantâneo.
const CACHE_GEO_DIAS = 180;

function chaveGeo(e) {
  return [e.cep, e.numero, e.logradouro, e.bairro, e.cidade, e.uf]
    .map(v => String(v || '').trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
}

async function geoDoCache(chave) {
  try {
    const doc = await db.collection('geocache').doc(Buffer.from(chave).toString('base64url').slice(0, 400)).get();
    if (!doc.exists) return null;
    const d = doc.data();
    const idade = (Date.now() - new Date(d.em).getTime()) / 864e5;
    if (idade > CACHE_GEO_DIAS) return null;
    return coordsValidas(d) ? { lat: d.lat, lng: d.lng, precisao: d.precisao } : null;
  } catch { return null; }   // cache indisponível nunca pode derrubar um pedido
}

async function guardarGeo(chave, coords) {
  try {
    await db.collection('geocache')
      .doc(Buffer.from(chave).toString('base64url').slice(0, 400))
      .set({ ...coords, em: new Date().toISOString() });
  } catch { /* idem */ }
}

// Uma consulta ao Nominatim (OpenStreetMap, sem chave de API).
async function nominatim(params) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&' +
              new URLSearchParams(params);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'MercadoLocal/1.0 (entregas)' },   // exigido pela política de uso
      signal: AbortSignal.timeout(7000)
    });
    if (!r.ok) return null;
    const lista = await r.json();
    if (!Array.isArray(lista) || !lista.length) return null;
    const lat = parseFloat(lista[0].lat), lng = parseFloat(lista[0].lon);
    return coordenadaPlausivel(lat, lng) ? { lat, lng } : null;
  } catch {
    return null;
  }
}

// Converte o endereço em coordenadas tentando do mais exato para o mais genérico.
// Devolve também QUÃO preciso foi o acerto, para a interface não prometer exatidão
// que não tem:
//   exata → rua + número    rua → rua sem número    bairro → centro do bairro
//   cep   → centro do CEP   cidade → centro da cidade (último recurso)
//
// O passo do BAIRRO é essencial no Brasil: o OpenStreetMap não conhece a maioria
// das ruas e CEPs das cidades médias, mas conhece os bairros. Sem ele, um endereço
// no Jardim Ana Rosa caía no centroide de Taubaté — ou seja, mandava o entregador
// para o Centro, a quase 3 km do lugar certo.
// Raio máximo, em km, que um resultado pode estar do centro da cidade informada
// antes de virar suspeito. Nominatim tem o hábito de devolver a "Rua das Flores"
// de outro estado quando não acha a da cidade certa; sem esta checagem o pedido
// era gravado com um ponto a 400 km e o entregador via um mapa impossível.
const RAIO_CIDADE_KM = 60;

async function geocodificarEndereco(e) {
  const chave = chaveGeo(e);
  const emCache = await geoDoCache(chave);
  if (emCache) return emCache;

  const cidadeUf = [e.cidade, e.uf].filter(Boolean).join(', ');
  const tentativas = [];

  if (e.logradouro && e.cidade) {
    if (e.numero) {
      tentativas.push({ precisao: 'exata', params: {
        street: `${e.numero} ${e.logradouro}`, city: e.cidade, state: e.uf || '' } });
      tentativas.push({ precisao: 'exata', params: {
        q: [e.logradouro, e.numero, e.bairro, cidadeUf, 'Brasil'].filter(Boolean).join(', ') } });
    }
    tentativas.push({ precisao: 'rua', params: {
      street: e.logradouro, city: e.cidade, state: e.uf || '' } });
    tentativas.push({ precisao: 'rua', params: {
      q: [e.logradouro, e.bairro, cidadeUf, 'Brasil'].filter(Boolean).join(', ') } });
  }
  if (e.bairro && e.cidade) {
    tentativas.push({ precisao: 'bairro', params: {
      q: [e.bairro, cidadeUf, 'Brasil'].filter(Boolean).join(', ') } });
  }
  if (e.cep && String(e.cep).replace(/\D/g, '').length === 8) {
    tentativas.push({ precisao: 'cep', params: { postalcode: String(e.cep).replace(/\D/g, '') } });
  }
  if (e.cidade) {
    tentativas.push({ precisao: 'cidade', params: { city: e.cidade, state: e.uf || '' } });
  }

  // Âncora para conferir os acertos: o centro da cidade. Vem de graça quando a
  // última tentativa roda, mas precisamos dele ANTES para validar as primeiras.
  let centroCidade = null;
  if (e.cidade) {
    centroCidade = await nominatim({ city: e.cidade, state: e.uf || '' });
  }

  let achou = null;
  for (let i = 0; i < tentativas.length; i++) {
    await esperar(1100);                       // política do Nominatim: no máx. 1 consulta/segundo
    const t = tentativas[i];
    const coords = await nominatim(t.params);
    if (!coords) continue;

    // Longe demais da cidade informada? O resultado é de outro lugar com nome igual.
    if (centroCidade && t.precisao !== 'cidade') {
      const desvio = distanciaKm(coords, centroCidade);
      if (desvio !== null && desvio > RAIO_CIDADE_KM) continue;
    }
    achou = { ...coords, precisao: t.precisao };
    break;
  }

  // Nada casou, mas sabemos onde é a cidade: melhor o centro dela (avisando que é
  // impreciso) do que devolver "sem ponto no mapa".
  if (!achou && centroCidade) achou = { ...centroCidade, precisao: 'cidade' };

  if (achou) await guardarGeo(chave, achou);
  return achou;
}

// Junta o que o checkout mandou + ViaCEP + cadastro do cliente num endereço só.
async function montarEnderecoEntrega(body, perfil) {
  const cep = String(body.cep || perfil.cep || '').replace(/\D/g, '');
  const viaCep = cep.length === 8 ? await resolverCep(cep) : null;

  const entrega = {
    cep:         cep || null,
    logradouro:  body.logradouro || (viaCep && viaCep.logradouro) || perfil.endereco || null,
    numero:      body.numero      || null,
    complemento: body.complemento || null,
    bairro:      body.bairro || (viaCep && viaCep.bairro) || null,
    cidade:      body.cidade || (viaCep && viaCep.cidade) || perfil.cidade || null,
    uf:          body.uf     || (viaCep && viaCep.uf)     || perfil.estado || null,
    referencia:  body.referencia || null,
    lat: null, lng: null,
    precisao: null,         // gps | exata | rua | bairro | cep | cidade | gps_aprox (null = sem localização)
    precisao_m: null        // margem de erro do GPS em metros, quando veio do GPS
  };

  // Onde o cliente diz que está, e quão confiável é essa leitura.
  // O checkout manda precisao_m; pedidos antigos e clientes que ajustaram o pino
  // à mão mandam sem — nesse caso confiamos, porque foi uma escolha deliberada.
  const doCliente = coordsValidas(body);
  const margemM   = coordenada(body.precisao_m);
  const ajustadoAMao = body.origem === 'manual';

  // GPS bom (ou pino posto a dedo no mapa) ganha de qualquer geocodificação:
  // aponta a porta, não a rua.
  if (doCliente && (ajustadoAMao || margemM === null || margemM <= GPS_BOM_M)) {
    entrega.lat = doCliente.lat;
    entrega.lng = doCliente.lng;
    entrega.precisao = 'gps';
    entrega.precisao_m = ajustadoAMao ? null : margemM;
    return entrega;
  }

  const coords = await geocodificarEndereco(entrega);

  // GPS mediano (100 m – 1 km): só vale se o geocoder não achou o número da casa.
  // Um acerto "exata" do geocoder é melhor do que um raio de meio quilômetro.
  if (doCliente && margemM !== null && margemM <= GPS_MEIO_M) {
    if (coords && coords.precisao === 'exata') {
      entrega.lat = coords.lat; entrega.lng = coords.lng; entrega.precisao = 'exata';
    } else {
      entrega.lat = doCliente.lat; entrega.lng = doCliente.lng;
      entrega.precisao = 'gps_aprox'; entrega.precisao_m = margemM;
    }
    return entrega;
  }

  // GPS ruim (> 1 km) é descartado sem dó: é a estimativa por IP do navegador de
  // computador, que já mandou entregador para a cidade vizinha.
  if (coords) {
    entrega.lat = coords.lat;
    entrega.lng = coords.lng;
    entrega.precisao = coords.precisao;
  }
  return entrega;
}

// Quando cada etapa aconteceu, lido do histórico de status. O histórico é a única
// fonte: não existe campo separado que possa divergir dele.
function marcosDaEntrega(historico) {
  const em = {};
  (historico || []).forEach(h => {
    // Primeira ocorrência vence: um pedido devolvido à fila e reaceito não deve
    // fingir que a primeira aceitação nunca existiu.
    if (h && h.status && h.em && !em[h.status]) em[h.status] = h.em;
  });
  const min = (a, b) => (a && b) ? Math.round((new Date(b) - new Date(a)) / 60000) : null;
  return {
    aceito_em:   em.aceito    || null,
    saiu_em:     em.a_caminho || null,
    entregue_em: em.entregue  || null,
    // Quanto o pedido esperou na fila, quanto o entregador levou para sair e
    // quanto tempo ficou na rua — os três números que explicam uma entrega lenta.
    espera_min:  min(em.aguardando, em.aceito),
    preparo_min: min(em.aceito, em.a_caminho),
    rua_min:     min(em.a_caminho, em.entregue),
    total_min:   min(em.aceito, em.entregue)
  };
}

// Resumo de um pedido do ponto de vista da entrega.
//
// incluirCodigo é o interruptor de sigilo do código de confirmação: só as rotas
// de rastreio do CLIENTE o ligam. Nenhuma rota do entregador pode ligá-lo — se
// alguém ligar por engano, o entregador consegue finalizar sozinho e a trava
// inteira deixa de existir.
function resumoEntrega(doc, { incluirCliente = false, incluirCodigo = false } = {}) {
  const p = doc.data();
  const criado = p.criado_em && p.criado_em.toDate ? p.criado_em.toDate().toISOString() : null;
  const itens = (p.itens || []).map(i => ({
    nome: i.nome, qty: i.qty || 1, preco: i.preco || 0,
    imagem_url: i.imagem_url || null, loja_nome: i.loja_nome || null
  }));
  // Coordenada implausível (ex.: pedidos gravados antes da correção da Ilha Nula)
  // é descartada na leitura: melhor mostrar só o endereço do que um ponto errado.
  const entrega = p.entrega ? { ...p.entrega } : null;
  if (entrega && !coordsValidas(entrega)) {
    entrega.lat = null; entrega.lng = null; entrega.precisao = null;
  }
  const local = coordsValidas(p.entregador_local) ? p.entregador_local : null;

  const marcos = marcosDaEntrega(p.entrega_historico);

  const base = {
    id: doc.id,
    itens,
    total_itens: itens.reduce((s, i) => s + i.qty, 0),
    total: p.total || 0,
    lojas: [...new Set(itens.map(i => i.loja_nome).filter(Boolean))],
    status: p.entrega_status || 'aguardando',
    entrega,
    entregador_local: local,
    historico: p.entrega_historico || [],
    criado_em: criado,
    ...marcos,
    // Onde a entrega aconteceu, para agrupar por região sem o painel ter que
    // reparsear o endereço inteiro
    bairro: (entrega && entrega.bairro) || null,
    cidade: (entrega && entrega.cidade) || null,
    // Trajeto realmente percorrido (soma dos pings do GPS) e a distância que
    // faltava quando o pedido foi aceito
    percorrido_km: p.entregador_km != null ? Math.round(p.entregador_km * 10) / 10 : null,
    distancia_inicial_km: p.entrega_km_inicial != null ? p.entrega_km_inicial : null,
    // Peso, volume e maior item — para o entregador saber se cabe no veículo dele
    medidas: p.entrega_medidas || null,
    // Quanto esta corrida paga — o número que decide se vale aceitar
    tarifa: p.entrega_tarifa != null ? p.entrega_tarifa : null,
    tarifa_detalhe: p.entrega_tarifa_detalhe || null,
    // Estado da trava de confirmação (sem revelar o código em si)
    tentativas_restantes: Math.max(0, TENTATIVAS_MAX - (p.entrega_tentativas || 0)),
    bloqueada: !!p.entrega_bloqueada,
    pagamento: p.entrega_pagamento || null      // { destino, valor, em } depois de finalizada
  };

  // O código só existe para quem comprou. Um `if` explícito, e não um campo
  // solto no objeto, para que incluí-lo seja sempre uma decisão consciente.
  if (incluirCodigo) base.codigo = p.entrega_codigo || null;
  if (incluirCliente) {
    base.cliente = {
      nome: p.usuario_nome || 'Cliente',
      telefone: p.usuario_telefone || null,
      email: p.usuario_email || null
    };
  }
  base.entregador = p.entregador_id
    ? { id: p.entregador_id, nome: p.entregador_nome, telefone: p.entregador_telefone }
    : null;
  return base;
}

// --- ENTREGADOR: cadastrar a capacidade do veículo ---
// Medidas do compartimento, não do carro. O que importa é o que cabe no baú/
// porta-malas — nenhuma tabela FIPE sabe isso, só quem carrega todo dia.
app.put('/api/couriers/capacity', authenticateToken, async (req, res) => {
  if (!await exigirTipo(req, res, 'entregador')) return;

  // Enviar {} apaga a capacidade e volta a mostrar a fila inteira
  if (req.body && req.body.limpar) {
    await db.collection('usuarios').doc(req.user.uid).set({ capacidade: null }, { merge: true });
    return res.json({ ok: true, capacidade: null });
  }

  const cap = capacidadeValida(req.body);
  if (!cap) {
    return res.status(400).json({
      ok: false,
      msg: 'Informe comprimento, largura e altura do compartimento (em cm), todos maiores que zero.'
    });
  }
  try {
    await db.collection('usuarios').doc(req.user.uid).set({ capacidade: cap }, { merge: true });
    res.json({
      ok: true,
      capacidade: cap,
      volume_util_l: Math.round((cap.comprimento * cap.largura * cap.altura / 1000) * APROVEITAMENTO)
    });
  } catch (err) {
    console.error('Erro ao salvar capacidade:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

app.get('/api/couriers/capacity', authenticateToken, async (req, res) => {
  const perfil = await exigirTipo(req, res, 'entregador');
  if (!perfil) return;
  const cap = capacidadeValida(perfil.capacidade);
  res.json({
    ok: true,
    capacidade: cap,
    volume_util_l: cap ? Math.round((cap.comprimento * cap.largura * cap.altura / 1000) * APROVEITAMENTO) : null
  });
});

// --- ENTREGADOR: pedidos de outras pessoas esperando alguém levar ---
app.get('/api/deliveries/available', authenticateToken, async (req, res) => {
  const perfilEntregador = await exigirTipo(req, res, 'entregador');
  if (!perfilEntregador) return;
  try {
    const snap = await db.collection('pedidos').where('entrega_status', '==', 'aguardando').get();

    // Posição atual do entregador (opcional) para ordenar por proximidade
    const eu = {
      lat: Number(req.query.lat),
      lng: Number(req.query.lng)
    };
    const temPosicao = Number.isFinite(eu.lat) && Number.isFinite(eu.lng);
    // Raio máximo em km. Sem GPS ele é ignorado — filtrar por uma distância que
    // não sabemos calcular esvaziaria a fila sem explicação.
    const raioKm = Number(req.query.raio_km);
    const temRaio = temPosicao && Number.isFinite(raioKm) && raioKm > 0;

    // Capacidade do veículo: cada pedido vem com o veredito de encaixe, e
    // 'so_cabe=1' esconde de vez o que não serve.
    const capacidade = capacidadeValida(perfilEntregador.capacidade);
    const soCabe = req.query.so_cabe === '1' && !!capacidade;

    let pedidos = snap.docs
      .filter(d => d.data().usuario_id !== req.user.uid)   // ninguém entrega a própria compra
      .map(d => {
        const item = resumoEntrega(d, { incluirCliente: true });
        item.distancia_km = temPosicao ? distanciaKm(eu, item.entrega || {}) : null;
        item.encaixe = cabeNoVeiculo(item.medidas, capacidade);
        return item;
      });

    // Quantos ficaram de fora do raio — o painel diz isso em vez de só sumir com eles
    let foraDoRaio = 0;
    if (temRaio) {
      const dentro = pedidos.filter(p => p.distancia_km == null || p.distancia_km <= raioKm);
      foraDoRaio = pedidos.length - dentro.length;
      pedidos = dentro;
    }

    // Idem para o que não cabe: o número é dito, nunca escondido em silêncio
    let naoCabem = 0;
    if (soCabe) {
      const cabem = pedidos.filter(p => p.encaixe.cabe);
      naoCabem = pedidos.length - cabem.length;
      pedidos = cabem;
    }

    // Mais perto primeiro; sem GPS, mais recente primeiro
    pedidos.sort((a, b) => {
      if (temPosicao && a.distancia_km != null && b.distancia_km != null) {
        return a.distancia_km - b.distancia_km;
      }
      return (b.criado_em || '').localeCompare(a.criado_em || '');
    });

    res.json({
      ok: true, pedidos,
      fora_do_raio: foraDoRaio,
      nao_cabem: naoCabem,
      tem_capacidade: !!capacidade
    });
  } catch (err) {
    console.error('Erro ao listar entregas disponíveis:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// --- ENTREGADOR: aceitar um pedido (transação: dois entregadores não pegam o mesmo) ---
app.post('/api/deliveries/:id/accept', authenticateToken, async (req, res) => {
  const perfil = await exigirTipo(req, res, 'entregador');
  if (!perfil) return;
  // Onde o entregador estava ao aceitar — vira a distância inicial do trajeto.
  // Opcional: quem aceita com o GPS desligado simplesmente não tem esse número.
  const daAceitacao = coordsValidas(req.body);

  try {
    const ref = db.collection('pedidos').doc(req.params.id);
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error('PEDIDO_NAO_ENCONTRADO');
      const p = doc.data();
      if (p.usuario_id === req.user.uid) throw new Error('PROPRIA_COMPRA');
      if ((p.entrega_status || 'aguardando') !== 'aguardando') throw new Error('JA_ACEITO');

      tx.update(ref, {
        entrega_status: 'aceito',
        entregador_id: req.user.uid,
        entregador_nome: perfil.nome || 'Entregador',
        entregador_telefone: perfil.telefone || null,
        // Zera o trajeto: o contador é deste entregador, não do que devolveu antes
        entregador_km: 0,
        entrega_km_inicial: daAceitacao ? distanciaKm(daAceitacao, p.entrega || {}) : null,
        entrega_historico: admin.firestore.FieldValue.arrayUnion({
          status: 'aceito', em: new Date().toISOString()
        })
      });
    });

    const doc = await ref.get();
    res.json({ ok: true, pedido: resumoEntrega(doc, { incluirCliente: true }) });
  } catch (err) {
    if (err.message === 'PEDIDO_NAO_ENCONTRADO') return res.status(404).json({ ok: false, msg: 'Pedido não encontrado.' });
    if (err.message === 'JA_ACEITO')             return res.status(409).json({ ok: false, msg: 'Outro entregador já aceitou este pedido.' });
    if (err.message === 'PROPRIA_COMPRA')        return res.status(403).json({ ok: false, msg: 'Você não pode entregar a sua própria compra.' });
    console.error('Erro ao aceitar entrega:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// --- ENTREGADOR: devolver o pedido para a fila (só antes de sair para entregar) ---
app.post('/api/deliveries/:id/release', authenticateToken, async (req, res) => {
  if (!await exigirTipo(req, res, 'entregador')) return;
  try {
    const ref = db.collection('pedidos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, msg: 'Pedido não encontrado.' });

    const p = doc.data();
    if (p.entregador_id !== req.user.uid) return res.status(403).json({ ok: false, msg: 'Esta entrega não é sua.' });
    if (p.entrega_status === 'entregue')  return res.status(400).json({ ok: false, msg: 'Entrega já concluída.' });

    await ref.update({
      entrega_status: 'aguardando',
      entregador_id: null, entregador_nome: null, entregador_telefone: null,
      entregador_local: null,
      entregador_km: 0, entrega_km_inicial: null,   // o trajeto do próximo começa do zero
      entrega_historico: admin.firestore.FieldValue.arrayUnion({
        status: 'aguardando', em: new Date().toISOString()
      })
    });
    res.json({ ok: true, msg: 'Pedido devolvido para a fila.' });
  } catch (err) {
    console.error('Erro ao liberar entrega:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// --- ENTREGADOR: minhas entregas (em andamento e concluídas) ---
app.get('/api/deliveries/mine', authenticateToken, async (req, res) => {
  if (!await exigirTipo(req, res, 'entregador')) return;
  try {
    const snap = await db.collection('pedidos').where('entregador_id', '==', req.user.uid).get();
    const pedidos = snap.docs.map(d => resumoEntrega(d, { incluirCliente: true }));
    pedidos.sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
    res.json({
      ok: true,
      ativas:     pedidos.filter(p => p.status !== 'entregue'),
      concluidas: pedidos.filter(p => p.status === 'entregue')
    });
  } catch (err) {
    console.error('Erro ao listar minhas entregas:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// --- ENTREGADOR: enviar a posição atual (o comprador acompanha em tempo real) ---
// Trecho entre dois pings que conta como deslocamento de verdade.
// Abaixo de 25 m é tremor do GPS parado (somaria quilômetros fantasmas ao longo
// de uma entrega); acima de 3 km num único ping é salto de sinal, não caminho.
const PASSO_MIN_M = 25;
const PASSO_MAX_M = 3000;

app.post('/api/deliveries/:id/location', authenticateToken, async (req, res) => {
  if (!await exigirTipo(req, res, 'entregador')) return;

  const pos = coordsValidas(req.body);
  if (!pos) {
    return res.status(400).json({ ok: false, msg: 'Coordenadas inválidas ou fora do Brasil.' });
  }
  const margemM = coordenada(req.body.precisao);
  // O painel já filtra, mas a regra tem que valer no servidor também: nenhuma
  // leitura pior que 1 km vira "posição do entregador" na tela do comprador.
  if (margemM !== null && margemM > GPS_MEIO_M) {
    return res.status(400).json({
      ok: false,
      msg: `Leitura imprecisa demais (±${Math.round(margemM)} m). Use o celular com GPS ou marque sua posição no mapa.`
    });
  }
  const { lat, lng } = pos;

  try {
    const ref = db.collection('pedidos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, msg: 'Pedido não encontrado.' });

    const p = doc.data();
    if (p.entregador_id !== req.user.uid) return res.status(403).json({ ok: false, msg: 'Esta entrega não é sua.' });
    if (p.entrega_status === 'entregue')  return res.status(400).json({ ok: false, msg: 'Entrega já concluída.' });

    const local = {
      lat, lng,
      precisao: margemM,                         // metros do GPS; null quando não informado
      atualizado_em: new Date().toISOString()
    };

    // Soma o trecho desde o ping anterior — é isto que vira "distância percorrida"
    // no painel de desempenho.
    const patch = { entregador_local: local };
    const passo = distanciaMetros(p.entregador_local, local);
    if (passo !== null && passo >= PASSO_MIN_M && passo <= PASSO_MAX_M) {
      patch.entregador_km = (Number(p.entregador_km) || 0) + passo / 1000;
    }
    await ref.update(patch);

    res.json({
      ok: true,
      local,
      distancia_km: distanciaKm(local, p.entrega || {})   // quanto falta até o cliente
    });
  } catch (err) {
    console.error('Erro ao atualizar localização:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// --- ENTREGADOR: avançar o status (a_caminho / entregue) ---
//
// Finalizar exige o código que o cliente dita na porta, e é o mesmo ato que
// libera o pagamento. Por isso tudo aqui roda numa transação: conferir o código,
// mudar o status e creditar o dinheiro precisam acontecer juntos ou não
// acontecer. Sem isso, dois toques no botão pagariam a corrida duas vezes.
app.post('/api/deliveries/:id/status', authenticateToken, async (req, res) => {
  const perfil = await exigirTipo(req, res, 'entregador');
  if (!perfil) return;

  const novo = String(req.body.status || '');
  if (!['a_caminho', 'entregue'].includes(novo)) {
    return res.status(400).json({ ok: false, msg: 'Status inválido.' });
  }
  const codigo  = String(req.body.codigo || '').replace(/\D/g, '');
  // Para onde vai o dinheiro: fica na carteira ou sai como saque na hora
  const destino = req.body.destino === 'saque' ? 'saque' : 'carteira';

  try {
    const ref = db.collection('pedidos').doc(req.params.id);
    const usuarioRef = db.collection('usuarios').doc(req.user.uid);
    const movRef = db.collection('carteira_movimentos').doc();

    const finalizando = novo === 'entregue';

    const saida = await db.runTransaction(async (tx) => {
      // ---------- 1) TODAS as leituras ----------
      // O Firestore exige ler tudo antes de escrever qualquer coisa. Por isso a
      // carteira é lida aqui, junto com o pedido, mesmo que só seja usada lá
      // embaixo — ler depois do primeiro tx.update() derruba a transação inteira.
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error('PEDIDO_NAO_ENCONTRADO');
      const uDoc = finalizando ? await tx.get(usuarioRef) : null;

      // ---------- 2) validações (nada escreve) ----------
      const p = doc.data();
      if (p.entregador_id !== req.user.uid) throw new Error('NAO_E_SUA');

      // Só anda para frente no fluxo — é isto que impede pagar duas vezes:
      // na segunda chamada o status já é 'entregue' e a transação aborta.
      const atual = ENTREGA_FLUXO.indexOf(p.entrega_status || 'aguardando');
      if (ENTREGA_FLUXO.indexOf(novo) <= atual) throw new Error('JA_PASSOU');

      const patch = {
        entrega_status: novo,
        entrega_historico: admin.firestore.FieldValue.arrayUnion({
          status: novo, em: new Date().toISOString()
        })
      };

      // 'a_caminho' não mexe em dinheiro nem em código
      if (!finalizando) { tx.update(ref, patch); return { pago: null }; }

      if (p.entrega_bloqueada) throw new Error('BLOQUEADA');

      const esperado = p.entrega_codigo || null;
      if (esperado) {
        if (!codigo) throw new Error('CODIGO_FALTANDO');
        // Comparação em tempo constante: com 4 dígitos o vazamento por tempo é
        // teórico, mas comparar segredo com === é um hábito que não vale ter.
        const bateu = codigo.length === esperado.length &&
          crypto.timingSafeEqual(Buffer.from(codigo), Buffer.from(esperado));
        // NÃO conte a tentativa aqui: lançar erro desfaz toda a transação, e o
        // contador iria embora junto. O registro acontece no catch, fora dela.
        if (!bateu) throw new Error('CODIGO_ERRADO');
      }
      // Pedido antigo, criado antes do código existir: deixa finalizar sem ele,
      // senão essas entregas ficariam presas para sempre.

      const valor = Number(p.entrega_tarifa) || 0;
      patch.entrega_pagamento = { destino, valor, em: new Date().toISOString() };

      // ---------- 3) TODAS as escritas ----------
      tx.update(ref, patch);
      if (valor <= 0) return { pago: { destino, valor: 0, saldo: null } };

      const saldoAtual = Number(uDoc && uDoc.exists ? uDoc.data().saldo : 0) || 0;
      // 'carteira' acumula; 'saque' é recebido na hora e não entra no saldo.
      const novoSaldo = destino === 'carteira'
        ? Math.round((saldoAtual + valor) * 100) / 100
        : saldoAtual;
      tx.set(usuarioRef, { saldo: novoSaldo }, { merge: true });

      // Extrato: toda entrada de dinheiro vira uma linha, inclusive o saque
      // imediato — o entregador precisa poder provar o que recebeu.
      tx.set(movRef, {
        usuario_id: req.user.uid,
        tipo: destino === 'carteira' ? 'credito' : 'saque_imediato',
        valor,
        pedido_id: req.params.id,
        descricao: destino === 'carteira'
          ? 'Entrega concluída — creditado na carteira'
          : 'Entrega concluída — retirado na hora',
        saldo_apos: novoSaldo,
        em: new Date().toISOString()
      });
      return { pago: { destino, valor, saldo: novoSaldo } };
    });

    const atualizado = await ref.get();
    res.json({
      ok: true,
      pedido: resumoEntrega(atualizado, { incluirCliente: true }),
      pagamento: saida.pago
    });
  } catch (err) {
    const mapa = {
      PEDIDO_NAO_ENCONTRADO: [404, 'Pedido não encontrado.'],
      NAO_E_SUA:             [403, 'Esta entrega não é sua.'],
      JA_PASSOU:             [400, 'A entrega já passou desta etapa.'],
      CODIGO_FALTANDO:       [400, 'Peça ao cliente o código de 4 dígitos e digite-o para finalizar.'],
      BLOQUEADA:             [423, 'Confirmação bloqueada por tentativas erradas. Fale com o suporte.'],
    };
    if (mapa[err.message]) {
      const [status, msg] = mapa[err.message];
      return res.status(status).json({ ok: false, msg });
    }
    // Tentativa errada: a transação foi desfeita, então o contador é gravado
    // aqui, com increment atômico — não depende de ter lido o valor antes, o que
    // o torna seguro mesmo com várias tentativas simultâneas.
    if (err.message === 'CODIGO_ERRADO') {
      let restantes = 0;
      try {
        const ref = db.collection('pedidos').doc(req.params.id);
        await ref.update({ entrega_tentativas: admin.firestore.FieldValue.increment(1) });
        const d = await ref.get();
        const usadas = (d.exists && Number(d.data().entrega_tentativas)) || TENTATIVAS_MAX;
        restantes = Math.max(0, TENTATIVAS_MAX - usadas);
        if (restantes === 0) await ref.update({ entrega_bloqueada: true });
      } catch (e) {
        console.error('Falha ao registrar tentativa de código:', e);
      }
      return restantes === 0
        ? res.status(423).json({ ok: false, restantes: 0,
            msg: 'Código incorreto. A confirmação foi bloqueada — fale com o suporte para liberar.' })
        : res.status(400).json({ ok: false, restantes,
            msg: `Código incorreto. ${restantes} tentativa(s) restante(s).` });
    }
    console.error('Erro ao atualizar status da entrega:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  CARTEIRA DO ENTREGADOR
//  saldo fica em usuarios/{uid}.saldo; cada movimento vira uma linha em
//  carteira_movimentos, para o extrato nunca depender de recalcular o saldo.
// ============================================================

app.get('/api/wallet', authenticateToken, async (req, res) => {
  try {
    const uDoc = await db.collection('usuarios').doc(req.user.uid).get();
    const saldo = Number(uDoc.exists ? uDoc.data().saldo : 0) || 0;

    const snap = await db.collection('carteira_movimentos')
      .where('usuario_id', '==', req.user.uid).get();
    const movimentos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.em || '').localeCompare(a.em || ''))
      .slice(0, 100);

    // Totais que o entregador quer ver sem precisar somar na mão
    const ganho = movimentos.reduce((s, m) =>
      s + (['credito', 'saque_imediato'].includes(m.tipo) ? (Number(m.valor) || 0) : 0), 0);

    res.json({ ok: true, saldo, movimentos, total_ganho: Math.round(ganho * 100) / 100 });
  } catch (err) {
    console.error('Erro ao ler carteira:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// Sacar o que está acumulado. Em transação para dois pedidos de saque
// simultâneos não tirarem o mesmo dinheiro duas vezes.
app.post('/api/wallet/withdraw', authenticateToken, async (req, res) => {
  const pedido = Number(req.body.valor);
  try {
    const usuarioRef = db.collection('usuarios').doc(req.user.uid);
    const movRef = db.collection('carteira_movimentos').doc();

    const saldoFinal = await db.runTransaction(async (tx) => {
      const uDoc = await tx.get(usuarioRef);
      const saldo = Number(uDoc.exists ? uDoc.data().saldo : 0) || 0;
      // Sem valor informado, saca tudo — é o caso comum
      const valor = Number.isFinite(pedido) && pedido > 0 ? Math.round(pedido * 100) / 100 : saldo;
      if (valor <= 0)     throw new Error('SEM_SALDO');
      if (valor > saldo)  throw new Error('SALDO_INSUFICIENTE');

      const novo = Math.round((saldo - valor) * 100) / 100;
      tx.set(usuarioRef, { saldo: novo }, { merge: true });
      tx.set(movRef, {
        usuario_id: req.user.uid, tipo: 'saque', valor: -valor,
        pedido_id: null, descricao: 'Saque da carteira',
        saldo_apos: novo, em: new Date().toISOString()
      });
      return { valor, saldo: novo };
    });

    res.json({ ok: true, ...saldoFinal });
  } catch (err) {
    if (err.message === 'SEM_SALDO')          return res.status(400).json({ ok: false, msg: 'Não há saldo para sacar.' });
    if (err.message === 'SALDO_INSUFICIENTE') return res.status(400).json({ ok: false, msg: 'Valor maior que o saldo disponível.' });
    console.error('Erro ao sacar:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// --- CLIENTE: rastrear as próprias compras ---
app.get('/api/deliveries/tracking', authenticateToken, async (req, res) => {
  try {
    const snap = await db.collection('pedidos').where('usuario_id', '==', req.user.uid).get();
    // São os pedidos DO PRÓPRIO cliente: aqui o código de confirmação pode (e
    // precisa) aparecer — é o único lugar onde ele existe para ser lido.
    const pedidos = snap.docs.map(d => {
      const item = resumoEntrega(d, { incluirCodigo: true });
      item.distancia_km = distanciaKm(item.entregador_local, item.entrega || {});
      return item;
    });
    pedidos.sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
    res.json({ ok: true, pedidos });
  } catch (err) {
    console.error('Erro ao rastrear pedidos:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// --- Rastreio de um pedido (o comprador ou o entregador designado) ---
app.get('/api/deliveries/:id/tracking', authenticateToken, async (req, res) => {
  try {
    const doc = await db.collection('pedidos').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, msg: 'Pedido não encontrado.' });

    const p = doc.data();
    const ehCliente    = p.usuario_id    === req.user.uid;
    const ehEntregador = p.entregador_id === req.user.uid;
    if (!ehCliente && !ehEntregador) return res.status(403).json({ ok: false, msg: 'Acesso negado.' });

    // O entregador vê os dados do cliente para conseguir entregar; o cliente vê
    // o código. Nunca os dois ao mesmo tempo para a mesma pessoa.
    const pedido = resumoEntrega(doc, { incluirCliente: ehEntregador, incluirCodigo: ehCliente });
    pedido.distancia_km = distanciaKm(pedido.entregador_local, pedido.entrega || {});
    res.json({ ok: true, pedido });
  } catch (err) {
    console.error('Erro ao rastrear pedido:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  AVALIAÇÕES – notas e comentários (coleção "avaliacoes")
//  Regras: só quem comprou pode avaliar; ninguém avalia produto da própria loja.
//  Uma avaliação por usuário por produto (id = "<produtoId>_<uid>").
// ============================================================

// Recalcula nota_media e nota_count no documento do produto
async function recomputeProductRating(produtoId) {
  const snap = await db.collection('avaliacoes').where('produto_id', '==', produtoId).get();
  const count = snap.size;
  const soma  = snap.docs.reduce((s, d) => s + (Number(d.data().nota) || 0), 0);
  const media = count ? Math.round((soma / count) * 10) / 10 : 0;
  await db.collection('produtos').doc(produtoId).update({ nota_media: media, nota_count: count }).catch(() => {});
  return { media, count };
}

// Criar/atualizar a avaliação do usuário para um produto
app.post('/api/products/:id/reviews', authenticateToken, async (req, res) => {
  const produtoId  = req.params.id;
  const nota       = parseInt(req.body.nota, 10);
  const comentario = (req.body.comentario || '').toString().trim().slice(0, 1000);

  if (!(nota >= 1 && nota <= 5)) return res.status(400).json({ ok: false, msg: 'A nota deve ser de 1 a 5.' });

  try {
    const prodDoc = await db.collection('produtos').doc(produtoId).get();
    if (!prodDoc.exists) return res.status(404).json({ ok: false, msg: 'Produto não encontrado.' });
    const prod = prodDoc.data();

    // Não pode avaliar produto da própria loja (cobre a regra do lojista)
    if (prod.loja_id) {
      const lojaDoc = await db.collection('lojas').doc(prod.loja_id).get();
      if (lojaDoc.exists && lojaDoc.data().usuario_id === req.user.uid) {
        return res.status(403).json({ ok: false, msg: 'Você não pode avaliar um produto da sua própria loja.' });
      }
    }

    // Precisa ter comprado o produto (checagem em memória — evita índice composto)
    const compras  = await db.collection('pedidos').where('usuario_id', '==', req.user.uid).get();
    const comprou  = compras.docs.some(d => (d.data().produto_ids || []).includes(produtoId));
    if (!comprou) return res.status(403).json({ ok: false, msg: 'Você só pode avaliar produtos que comprou.' });

    const userDoc = await db.collection('usuarios').doc(req.user.uid).get();
    const usuario_nome = userDoc.exists ? userDoc.data().nome : 'Usuário';

    const reviewId = `${produtoId}_${req.user.uid}`;  // uma avaliação por usuário/produto
    await db.collection('avaliacoes').doc(reviewId).set({
      produto_id: produtoId,
      produto_nome: prod.nome,
      loja_id: prod.loja_id || null,
      usuario_id: req.user.uid,
      usuario_nome,
      nota, comentario,
      criado_em: admin.firestore.FieldValue.serverTimestamp()
    });

    const rating = await recomputeProductRating(produtoId);
    res.json({ ok: true, review: { id: reviewId, nota, comentario }, rating });
  } catch (err) {
    console.error('Erro ao avaliar produto:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// Listar avaliações de um produto (público)
app.get('/api/products/:id/reviews', async (req, res) => {
  try {
    const snap = await db.collection('avaliacoes').where('produto_id', '==', req.params.id).get();
    const reviews = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const count = reviews.length;
    const media = count ? Math.round((reviews.reduce((s, r) => s + (r.nota || 0), 0) / count) * 10) / 10 : 0;
    res.json({ ok: true, reviews, media, count });
  } catch (err) {
    console.error('Erro ao buscar avaliações:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// Remover a avaliação do usuário para um produto
app.delete('/api/products/:id/reviews', authenticateToken, async (req, res) => {
  try {
    await db.collection('avaliacoes').doc(`${req.params.id}_${req.user.uid}`).delete();
    const rating = await recomputeProductRating(req.params.id);
    res.json({ ok: true, rating });
  } catch (err) {
    console.error('Erro ao remover avaliação:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// Todas as avaliações feitas por um usuário (aba "Minhas Avaliações")
app.get('/api/users/:id/reviews', authenticateToken, async (req, res) => {
  if (req.user.uid !== req.params.id) return res.status(403).json({ ok: false, msg: 'Acesso negado.' });
  try {
    const snap = await db.collection('avaliacoes').where('usuario_id', '==', req.params.id).get();
    res.json({ ok: true, reviews: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) {
    console.error('Erro ao buscar avaliações do usuário:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// ============================================================
//  FRETE / SHIPPING  (100% ViaCEP — sem conta em outros serviços)
//  - ViaCEP (grátis, sem cadastro) → descobre a região pelo CEP
//  - Frete grátis automático pela compra mínima da região
//  - Abaixo do mínimo → cálculo interno por região + peso dos itens
// ============================================================

// UF → Região
const UF_REGIAO = {
  AC:'Norte', AP:'Norte', AM:'Norte', PA:'Norte', RO:'Norte', RR:'Norte', TO:'Norte',
  AL:'Nordeste', BA:'Nordeste', CE:'Nordeste', MA:'Nordeste', PB:'Nordeste',
  PE:'Nordeste', PI:'Nordeste', RN:'Nordeste', SE:'Nordeste',
  DF:'Centro-Oeste', GO:'Centro-Oeste', MT:'Centro-Oeste', MS:'Centro-Oeste',
  ES:'Sudeste', MG:'Sudeste', RJ:'Sudeste', SP:'Sudeste',
  PR:'Sul', RS:'Sul', SC:'Sul'
};

// Compra mínima (R$) para frete grátis por região
const FRETE_GRATIS_MIN = {
  'Sudeste': 199, 'Sul': 249, 'Centro-Oeste': 299, 'Nordeste': 349, 'Norte': 399
};

// Frete base (R$) por região — usado quando a compra fica abaixo do mínimo
const FRETE_BASE = {
  'Sudeste': 19.90, 'Sul': 24.90, 'Centro-Oeste': 29.90, 'Nordeste': 34.90, 'Norte': 39.90
};
const PRAZO_BASE = {
  'Sudeste': '3 a 6 dias úteis', 'Sul': '4 a 8 dias úteis',
  'Centro-Oeste': '5 a 9 dias úteis', 'Nordeste': '6 a 12 dias úteis',
  'Norte': '8 a 15 dias úteis'
};

// Resolve um CEP em { uf, regiao, cidade }. Usa cache para não repetir chamadas.
async function resolverCep(cep, cache) {
  const limpo = String(cep || '').replace(/\D/g, '');
  if (limpo.length !== 8) return null;
  if (cache && cache.has(limpo)) return cache.get(limpo);
  try {
    const r = await fetch(`https://viacep.com.br/ws/${limpo}/json/`);
    if (!r.ok) throw new Error('ViaCEP indisponível');
    const data = await r.json();
    if (data.erro) throw new Error('CEP não encontrado');
    const out = {
      uf: data.uf, regiao: UF_REGIAO[data.uf], cidade: data.localidade,
      logradouro: data.logradouro || null, bairro: data.bairro || null
    };
    if (cache) cache.set(limpo, out);
    return out;
  } catch (e) {
    return null;
  }
}

// Frete de UMA loja: leva em conta a distância entre a origem (loja) e o destino (cliente).
// Mesmo estado = mais barato; mesma região = intermediário; outra região = cheio. + peso.
function freteEntreCeps(origem, destino, pesoKg) {
  const base = FRETE_BASE[destino.regiao] || FRETE_BASE['Sudeste'];
  let mult = 1.0;
  if (origem && origem.uf && origem.uf === destino.uf) mult = 0.6;
  else if (origem && origem.regiao && origem.regiao === destino.regiao) mult = 0.8;
  const peso  = Math.max(0.3, pesoKg || 0.5);
  const frete = base * mult + Math.max(0, peso - 1) * 3;
  return Math.round(frete * 100) / 100;
}

// Consulta de CEP para o checkout preencher (e o cliente poder CORRIGIR) o endereço.
// Deixar rua/bairro visíveis importa: é o que o entregador vai ler, e o CEP às vezes
// devolve o logradouro genérico da região em vez do endereço real.
app.get('/api/cep/:cep', async (req, res) => {
  const cep = String(req.params.cep || '').replace(/\D/g, '');
  if (cep.length !== 8) return res.status(400).json({ ok: false, msg: 'CEP inválido.' });

  const dados = await resolverCep(cep);
  if (!dados) return res.status(404).json({ ok: false, msg: 'CEP não encontrado.' });

  res.json({
    ok: true,
    cep,
    logradouro: dados.logradouro || null,
    bairro:     dados.bairro || null,
    cidade:     dados.cidade || null,
    uf:         dados.uf || null
  });
});

// Cálculo de frete por loja. Body: { cep, lojas: [{ id, nome, subtotal, peso, itens }] }
app.post('/api/shipping/quote', async (req, res) => {
  try {
    const cep   = String(req.body.cep || '').replace(/\D/g, '');
    const lojas = Array.isArray(req.body.lojas) ? req.body.lojas : [];

    if (cep.length !== 8) {
      return res.status(400).json({ ok: false, msg: 'CEP inválido. Digite os 8 dígitos.' });
    }
    if (!lojas.length) {
      return res.status(400).json({ ok: false, msg: 'Carrinho vazio.' });
    }

    const cache   = new Map();
    const destino = await resolverCep(cep, cache);
    if (!destino || !destino.regiao) {
      return res.status(400).json({ ok: false, msg: 'Não foi possível identificar a região do CEP.' });
    }

    const threshold = FRETE_GRATIS_MIN[destino.regiao];
    const detalhe   = [];
    let freteTotal  = 0;

    for (const loja of lojas) {
      const subtotal = parseFloat(loja.subtotal) || 0;
      const itens    = parseInt(loja.itens) || 1;
      const peso     = parseFloat(loja.peso) || (itens * 0.5);

      // Origem: CEP cadastrado na loja (fallback para o estado da loja)
      let origem = null;
      try {
        const storeDoc = await db.collection('lojas').doc(String(loja.id)).get();
        if (storeDoc.exists) {
          const sd = storeDoc.data();
          if (sd.cep) origem = await resolverCep(sd.cep, cache);
          if (!origem && sd.estado) origem = { uf: sd.estado, regiao: UF_REGIAO[sd.estado], cidade: sd.cidade };
        }
      } catch (_) { /* segue com origem nula → frete cheio */ }

      // Frete grátis por loja quando atinge a compra mínima da região do cliente
      let frete = 0, gratis = true;
      if (subtotal < threshold) {
        frete  = freteEntreCeps(origem, destino, peso);
        gratis = false;
      }
      freteTotal += frete;

      detalhe.push({
        id: loja.id, nome: loja.nome || 'Loja',
        subtotal, frete, gratis,
        faltam: gratis ? 0 : Math.round((threshold - subtotal) * 100) / 100,
        prazo: PRAZO_BASE[destino.regiao],
        origem: origem ? `${origem.cidade || ''} - ${origem.uf}`.trim() : null
      });
    }

    freteTotal = Math.round(freteTotal * 100) / 100;

    res.json({
      ok: true,
      cep, uf: destino.uf, regiao: destino.regiao, cidade: destino.cidade,
      threshold,
      freteTotal,
      gratisTotal: freteTotal === 0,
      prazo: PRAZO_BASE[destino.regiao],
      lojas: detalhe
    });
  } catch (err) {
    console.error('Erro no cálculo de frete:', err.message);
    res.status(500).json({ ok: false, msg: 'Não foi possível calcular o frete. Verifique o CEP e tente novamente.' });
  }
});

// ============================================================
//  SEED – DADOS DE DEMO
// ============================================================

app.post('/api/seed', async (req, res) => {
  try {
    const snap = await db.collection('usuarios').limit(1).get();
    if (!snap.empty) return res.json({ ok: false, msg: 'Dados de demo já existem.' });

    const joao    = await admin.auth().createUser({ email: 'loja@demo.com',    password: '123456', displayName: 'João Silva'    });
    const maria   = await admin.auth().createUser({ email: 'maria@demo.com',   password: '123456', displayName: 'Maria Santos'  });
    const cliente = await admin.auth().createUser({ email: 'cliente@demo.com', password: '123456', displayName: 'Cliente Demo'  });

    await db.collection('usuarios').doc(joao.uid).set({ nome: 'João Silva', email: 'loja@demo.com', senha_hash: hashPassword('123456'), tipo: 'lojista', profile_image: null });
    await db.collection('usuarios').doc(maria.uid).set({ nome: 'Maria Santos', email: 'maria@demo.com', senha_hash: hashPassword('123456'), tipo: 'lojista', profile_image: null });
    await db.collection('usuarios').doc(cliente.uid).set({ nome: 'Cliente Demo', email: 'cliente@demo.com', senha_hash: hashPassword('123456'), tipo: 'cliente', profile_image: null });

    const lojaJoao  = await db.collection('lojas').add({ usuario_id: joao.uid,  nome: 'Tech & Cia',  descricao: 'Os melhores eletrônicos da cidade.', categoria: 'Eletrônicos', cidade: 'São Paulo',      estado: 'SP', telefone: '(11) 99999-0001', ativa: true, logo_url: null, banner_url: null });
    const lojaMaria = await db.collection('lojas').add({ usuario_id: maria.uid, nome: 'Moda Chic',   descricao: 'Roupas e acessórios para todos os estilos.', categoria: 'Moda', cidade: 'Rio de Janeiro', estado: 'RJ', telefone: '(21) 99999-0002', ativa: true, logo_url: null, banner_url: null });

    const produtos = [
      [lojaJoao.id,  'Fone Bluetooth Pro',   299.9, 'Eletrônicos', 15, 'Fone sem fio com cancelamento de ruído.'],
      [lojaJoao.id,  'Smartwatch X500',      599.0, 'Eletrônicos',  8, 'Monitora saúde e notificações.'],
      [lojaJoao.id,  'Carregador Turbo 65W',  89.9, 'Eletrônicos', 30, 'Carrega qualquer dispositivo em minutos.'],
      [lojaMaria.id, 'Blusa Floral Verão',    79.9, 'Moda',        20, 'Tecido leve e estampado.'],
      [lojaMaria.id, 'Calça Jeans Slim',     149.9, 'Moda',        12, 'Corte moderno e confortável.'],
      [lojaMaria.id, 'Bolsa de Couro',       249.0, 'Moda',         5, 'Elegante para o dia a dia.']
    ];

    for (const [lojaId, nome, preco, categoria, estoque, descricao] of produtos) {
      await db.collection('produtos').add({ loja_id: lojaId, nome, preco, descricao, categoria, estoque, ativo: true, imagem_url: null });
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
//  ERRO MULTER
// ============================================================

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ ok: false, msg: 'Erro no upload: ' + err.message });
  } else if (err) {
    return res.status(400).json({ ok: false, msg: err.message });
  }
  next();
});

// ============================================================
//  PORTA AUTOMÁTICA
// ============================================================

function findAvailablePort(startPort = 3000, maxAttempts = 100) {
  return new Promise((resolve, reject) => {
    let port = startPort, attempts = 0;
    function testPort() {
      if (attempts >= maxAttempts) return reject(new Error('Sem porta livre'));
      const server = net.createServer();
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(port)));
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') { port++; attempts++; testPort(); }
        else reject(err);
      });
    }
    testPort();
  });
}

async function startServer() {
  try {
    let port;
    try { await findAvailablePort(4000, 1); port = 4000; }
    catch { port = await findAvailablePort(4001); }

    app.listen(port, () => {
      console.log(`\n🚀 Servidor rodando em http://localhost:${port}`);
      console.log('🔥 Conectado ao Firebase (Firestore + Auth) + Cloudinary (imagens)');
      console.log('\n💡 Para carregar dados de demo: POST /api/seed');
      console.log('💻 Abra no navegador: http://localhost:' + port);
    });
  } catch (error) {
    console.error('❌ Erro ao iniciar servidor:', error.message);
    process.exit(1);
  }
}

process.nextTick(() => startServer());
