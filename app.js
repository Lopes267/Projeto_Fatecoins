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
      // Armazenar com timestamp de expiração (24 horas)
      const sessionData = {
        user: data.user,
        loginTime: Date.now(),
        expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 horas em ms
      };
      localStorage.setItem('mp_session', JSON.stringify(sessionData));
    }
    return data;
  },

  logout() { localStorage.removeItem('mp_session'); },

  currentUser() {
    const s = localStorage.getItem('mp_session');
    if (!s) return null;
    
    try {
      const sessionData = JSON.parse(s);
      
      // Verificar se a sessão expirou
      if (Date.now() > sessionData.expiresAt) {
        console.warn('⏰ Sessão expirada (24h)');
        localStorage.removeItem('mp_session');
        return null;
      }
      
      return sessionData.user;
    } catch (e) {
      console.error('Erro ao parsear sessão:', e);
      localStorage.removeItem('mp_session');
      return null;
    }
  },
  
  isSessionExpired() {
    const s = localStorage.getItem('mp_session');
    if (!s) return false;
    try {
      const sessionData = JSON.parse(s);
      return Date.now() > sessionData.expiresAt;
    } catch {
      return false;
    }
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
//  VALIDAÇÃO DE SESSÃO
// ============================================================

function checkSessionExpiry() {
  const s = localStorage.getItem('mp_session');
  if (!s) return;
  
  try {
    const sessionData = JSON.parse(s);
    const timeLeft = sessionData.expiresAt - Date.now();
    
    if (timeLeft <= 0) {
      // Sessão expirada
      console.warn('⏰ Sessão expirada!');
      localStorage.removeItem('mp_session');
      if (!window.location.href.includes('login.html') && !window.location.href.includes('index.html')) {
        toast('Sua sessão expirou. Faça login novamente.', 'error');
        setTimeout(() => window.location.href = 'login.html', 2000);
      }
    } else if (timeLeft < (60 * 60 * 1000)) {
      // Faltam menos de 1 hora
      console.warn(`⏰ Sessão expira em ${Math.round(timeLeft / (60 * 1000))} minutos`);
    }
  } catch (e) {
    console.error('Erro ao verificar sessão:', e);
  }
}

// Verificar sessão a cada 5 minutos
setInterval(checkSessionExpiry, 5 * 60 * 1000);
// Verificar também ao carregar a página
document.addEventListener('DOMContentLoaded', checkSessionExpiry);

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
