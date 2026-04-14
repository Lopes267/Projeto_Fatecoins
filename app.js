// ============================================================
//  app.js  –  Marketplace logic (conectado a Node.js)
//  Backend: http://localhost:5800
// ============================================================

const API_URL = 'http://localhost:5800';

const DB = {
  // ---------- helpers ----------
  _get: (key) => JSON.parse(localStorage.getItem(key) || '[]'),
  _set: (key, val) => localStorage.setItem(key, JSON.stringify(val)),
  _id: () => Date.now() + Math.random().toString(36).slice(2),

  // ---------- users ----------
  async registerUser(nome, email, senha, tipo = 'cliente') {
    const res = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome, email, senha, tipo })
    });
    return await res.json();
  },

  async loginUser(email, senha) {
    const res = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, senha })
    });
    const data = await res.json();
    if (data.ok) {
      sessionStorage.setItem('mp_session', JSON.stringify(data.user));
    }
    return data;
  },

  logout() { sessionStorage.removeItem('mp_session'); },

  currentUser() {
    const s = sessionStorage.getItem('mp_session');
    return s ? JSON.parse(s) : null;
  },

  // ---------- stores ----------
  async getMyStore(userId) {
    const res = await fetch(`${API_URL}/api/stores/${userId}`);
    const data = await res.json();
    return data.store || null;
  },

  async saveStore(userId, data) {
    const res = await fetch(`${API_URL}/api/stores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, ...data })
    });
    const result = await res.json();
    return result.ok ? result.store : null;
  },

  async getPublicStores(query = '') {
    const res = await fetch(`${API_URL}/api/stores-public`);
    const data = await res.json();
    let stores = data.stores || [];
    if (query) {
      const q = query.toLowerCase();
      stores = stores.filter(s =>
        s.nome.toLowerCase().includes(q) ||
        (s.descricao || '').toLowerCase().includes(q) ||
        (s.categoria || '').toLowerCase().includes(q)
      );
    }
    return stores;
  },

  // ---------- products ----------
  async addProduct(storeId, data) {
    const res = await fetch(`${API_URL}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId, ...data })
    });
    const result = await res.json();
    return result.ok ? result.product : null;
  },

  async getStoreProducts(storeId) {
    const res = await fetch(`${API_URL}/api/products/store/${storeId}`);
    const data = await res.json();
    return data.products || [];
  },

  async updateProduct(id, data) {
    const res = await fetch(`${API_URL}/api/products/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await res.json();
    return result.ok ? result.product : null;
  },

  async deleteProduct(id) {
    const res = await fetch(`${API_URL}/api/products/${id}`, { method: 'DELETE' });
    return await res.json();
  },

  // ---------- search ----------
  async searchProducts(query = '', categoria = '') {
    const params = new URLSearchParams();
    if (query) params.append('query', query);
    if (categoria && categoria !== 'todas') params.append('categoria', categoria);
    
    const res = await fetch(`${API_URL}/api/products?${params}`);
    const data = await res.json();
    return data.products || [];
  }
};

// ============================================================
//  AUTH HELPERS
// ============================================================

function requireAuth(tipo) {
  const user = DB.currentUser();
  if (!user) { window.location.href = 'login.html'; return null; }
  if (tipo && user.tipo !== tipo) { window.location.href = 'marketplace.html'; return null; }
  return user;
}

function toast(msg, tipo = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${tipo}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 3000);
}

function formatPrice(n) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
}

// ============================================================
//  SEED DATA (demo)
// ============================================================
async function seedDemo() {
  try {
    const res = await fetch(`${API_URL}/api/seed`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      console.log('✅ Dados de demo carregados!');
    }
  } catch (err) {
    console.error('⚠️  Servidor não disponível. Use localStorage como fallback.');
  }
}

document.addEventListener('DOMContentLoaded', seedDemo);
