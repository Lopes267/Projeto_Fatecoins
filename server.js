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
        peso:       data.peso || 0,   // oculto no front; usado só no cálculo de frete
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
      loja_nome:  (i.loja && i.loja.nome) || i.loja_nome || null
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
    const ref = await db.collection('pedidos').add({
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
      criado_em: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true, pedido: { id: ref.id } });
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
async function geocodificarEndereco(e) {
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

  for (let i = 0; i < tentativas.length; i++) {
    if (i > 0) await esperar(1100);            // política do Nominatim: no máx. 1 consulta/segundo
    const t = tentativas[i];
    const coords = await nominatim(t.params);
    if (coords) return { ...coords, precisao: t.precisao };
  }
  return null;
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
    precisao: null          // exata | rua | cep | cidade | gps  (null = sem localização)
  };

  // O GPS do próprio cliente é a melhor fonte; só depois cai para o geocoder.
  const doCliente = coordsValidas(body);
  if (doCliente) {
    entrega.lat = doCliente.lat;
    entrega.lng = doCliente.lng;
    entrega.precisao = 'gps';
  } else {
    const coords = await geocodificarEndereco(entrega);
    if (coords) {
      entrega.lat = coords.lat;
      entrega.lng = coords.lng;
      entrega.precisao = coords.precisao;
    }
  }
  return entrega;
}

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

// Resumo de um pedido do ponto de vista da entrega
function resumoEntrega(doc, { incluirCliente = false } = {}) {
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
    criado_em: criado
  };
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

// --- ENTREGADOR: pedidos de outras pessoas esperando alguém levar ---
app.get('/api/deliveries/available', authenticateToken, async (req, res) => {
  if (!await exigirTipo(req, res, 'entregador')) return;
  try {
    const snap = await db.collection('pedidos').where('entrega_status', '==', 'aguardando').get();

    // Posição atual do entregador (opcional) para ordenar por proximidade
    const eu = {
      lat: Number(req.query.lat),
      lng: Number(req.query.lng)
    };
    const temPosicao = Number.isFinite(eu.lat) && Number.isFinite(eu.lng);

    const pedidos = snap.docs
      .filter(d => d.data().usuario_id !== req.user.uid)   // ninguém entrega a própria compra
      .map(d => {
        const item = resumoEntrega(d, { incluirCliente: true });
        item.distancia_km = temPosicao ? distanciaKm(eu, item.entrega || {}) : null;
        return item;
      });

    // Mais perto primeiro; sem GPS, mais recente primeiro
    pedidos.sort((a, b) => {
      if (temPosicao && a.distancia_km != null && b.distancia_km != null) {
        return a.distancia_km - b.distancia_km;
      }
      return (b.criado_em || '').localeCompare(a.criado_em || '');
    });

    res.json({ ok: true, pedidos });
  } catch (err) {
    console.error('Erro ao listar entregas disponíveis:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// --- ENTREGADOR: aceitar um pedido (transação: dois entregadores não pegam o mesmo) ---
app.post('/api/deliveries/:id/accept', authenticateToken, async (req, res) => {
  const perfil = await exigirTipo(req, res, 'entregador');
  if (!perfil) return;
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
app.post('/api/deliveries/:id/location', authenticateToken, async (req, res) => {
  if (!await exigirTipo(req, res, 'entregador')) return;

  const pos = coordsValidas(req.body);
  if (!pos) {
    return res.status(400).json({ ok: false, msg: 'Coordenadas inválidas ou fora do Brasil.' });
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
      precisao: coordenada(req.body.precisao),   // metros do GPS; null quando não informado
      atualizado_em: new Date().toISOString()
    };
    await ref.update({ entregador_local: local });

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
app.post('/api/deliveries/:id/status', authenticateToken, async (req, res) => {
  if (!await exigirTipo(req, res, 'entregador')) return;

  const novo = String(req.body.status || '');
  if (!['a_caminho', 'entregue'].includes(novo)) {
    return res.status(400).json({ ok: false, msg: 'Status inválido.' });
  }

  try {
    const ref = db.collection('pedidos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, msg: 'Pedido não encontrado.' });

    const p = doc.data();
    if (p.entregador_id !== req.user.uid) return res.status(403).json({ ok: false, msg: 'Esta entrega não é sua.' });

    // Só anda para frente no fluxo
    const atual = ENTREGA_FLUXO.indexOf(p.entrega_status || 'aguardando');
    if (ENTREGA_FLUXO.indexOf(novo) <= atual) {
      return res.status(400).json({ ok: false, msg: 'A entrega já passou desta etapa.' });
    }

    await ref.update({
      entrega_status: novo,
      entrega_historico: admin.firestore.FieldValue.arrayUnion({
        status: novo, em: new Date().toISOString()
      })
    });
    const atualizado = await ref.get();
    res.json({ ok: true, pedido: resumoEntrega(atualizado, { incluirCliente: true }) });
  } catch (err) {
    console.error('Erro ao atualizar status da entrega:', err);
    res.status(500).json({ ok: false, msg: 'Erro interno do servidor.' });
  }
});

// --- CLIENTE: rastrear as próprias compras ---
app.get('/api/deliveries/tracking', authenticateToken, async (req, res) => {
  try {
    const snap = await db.collection('pedidos').where('usuario_id', '==', req.user.uid).get();
    const pedidos = snap.docs.map(d => {
      const item = resumoEntrega(d);
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

    const pedido = resumoEntrega(doc, { incluirCliente: ehEntregador });
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
