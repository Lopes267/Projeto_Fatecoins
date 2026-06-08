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
app.use(express.static(path.join(__dirname)));
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
    const out = { uf: data.uf, regiao: UF_REGIAO[data.uf], cidade: data.localidade };
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
