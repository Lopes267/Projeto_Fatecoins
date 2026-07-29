// ============================================================
//  app.js  –  Marketplace logic (conectado a Node.js)
// ============================================================

// Detectar URL da API dinamicamente
let API_URL = 'http://localhost:4000'; // fallback

async function initAPI() {
  try {
    const res = await fetch('http://localhost:4000/api/config');
    if (res.ok) {
      const config = await res.json();
      API_URL = config.api_url;
      console.log('API URL detectada:', API_URL);
    }
  } catch (err) {
    console.log('Usando API URL padrão:', API_URL);
  }
}

// Inicializar API na carga da página
initAPI();

// Remove QUALQUER carrinho legado em localStorage (de versões antigas do site).
// O carrinho hoje vive 100% online no Firebase, vinculado ao cliente.
try { localStorage.removeItem('mp_cart'); } catch {}

const DB = {
  // ---------- helpers ----------
  _get: (key) => JSON.parse(localStorage.getItem(key) || '[]'),
  _set: (key, val) => localStorage.setItem(key, JSON.stringify(val)),
  _id: () => Date.now() + Math.random().toString(36).slice(2),
  _getToken() {
    try {
      const s = localStorage.getItem('mp_session');
      return s ? JSON.parse(s).access_token : null;
    } catch { return null; }
  },
  _authHeaders() {
    const token = this._getToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  },

  // ---------- users ----------
  async registerUser(nome, email, senha, tipo = 'cliente') {
    // Validação básica de email no cliente
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { ok: false, msg: 'Formato de e-mail inválido.' };
    }

    // Verificar se é um email comum (não disposable)
    const commonDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'];
    const domain = email.split('@')[1];
    if (!commonDomains.includes(domain.toLowerCase())) {
      console.warn('Domínio de e-mail não comum detectado:', domain);
    }

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
      // Token Firebase dura 1 hora — salvar com 55 min para dar margem
      const sessionData = {
        user: data.user,
        access_token: data.session?.access_token,
        loginTime: Date.now(),
        expiresAt: Date.now() + (55 * 60 * 1000)
      };
      localStorage.setItem('mp_session', JSON.stringify(sessionData));
    }
    return data;
  },

  logout() {
    localStorage.removeItem('mp_session');
    localStorage.removeItem('mp_cart');   // remove qualquer carrinho legado deixado no navegador
  },

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
    const res = await fetch(`${API_URL}/api/stores/${userId}`, {
      headers: { ...this._authHeaders() }
    });
    const data = await res.json();
    return data.store || null;
  },

  async saveStore(userId, data) {
    const res = await fetch(`${API_URL}/api/stores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
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
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
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
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify(data)
    });
    const result = await res.json();
    return result.ok ? result.product : null;
  },

  async deleteProduct(id) {
    const res = await fetch(`${API_URL}/api/products/${id}`, {
      method: 'DELETE',
      headers: { ...this._authHeaders() }
    });
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
  },

  // ---------- image uploads ----------
  async uploadImage(file, folder = 'general') {
    const formData = new FormData();
    formData.append('image', file);
    formData.append('folder', folder);

    const token = this._getToken();

    const res = await fetch(`${API_URL}/api/upload-image`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData
    });

    const data = await res.json();
    return data;
  },

  async updateProfileImage(userId, file) {
    const formData = new FormData();
    formData.append('image', file);

    const token = this._getToken();

    const res = await fetch(`${API_URL}/api/users/${userId}/profile-image`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData
    });

    const data = await res.json();
    return data;
  },

  async updateStoreLogo(storeId, file) {
    const formData = new FormData();
    formData.append('image', file);

    const token = this._getToken();

    const res = await fetch(`${API_URL}/api/stores/${storeId}/logo`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData
    });

    const data = await res.json();
    return data;
  },

  async updateStoreBanner(storeId, file) {
    const formData = new FormData();
    formData.append('image', file);

    const token = this._getToken();

    const res = await fetch(`${API_URL}/api/stores/${storeId}/banner`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData
    });

    const data = await res.json();
    return data;
  },

  async updateProductImage(productId, file) {
    const formData = new FormData();
    formData.append('image', file);

    const token = this._getToken();

    const res = await fetch(`${API_URL}/api/products/${productId}/image`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData
    });

    const data = await res.json();
    return data;
  },

  // ---------- cart (carrinho no Firestore, por cliente) ----------
  async getCart() {
    const res = await fetch(`${API_URL}/api/cart`, {
      headers: { ...this._authHeaders() }
    });
    const data = await res.json();
    return data.ok ? (data.items || []) : [];
  },

  async saveCart(items) {
    const res = await fetch(`${API_URL}/api/cart`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify({ items })
    });
    return await res.json();
  },

  async clearCart() {
    const res = await fetch(`${API_URL}/api/cart`, {
      method: 'DELETE',
      headers: { ...this._authHeaders() }
    });
    return await res.json();
  },

  // ---------- pedidos (compras) ----------
  // entrega: { cep, numero, complemento, referencia, lat, lng } — endereço onde o
  // entregador vai levar a compra. O servidor completa o que faltar pelo CEP/cadastro.
  async createOrder(itens, entrega = null) {
    const res = await fetch(`${API_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify({ itens, entrega })
    });
    return await res.json();
  },

  async getMyOrders() {
    const res = await fetch(`${API_URL}/api/orders`, { headers: { ...this._authHeaders() } });
    const data = await res.json();
    return data.ok ? (data.produtos || []) : [];
  },

  // Vendas da loja do lojista (quem comprou cada produto)
  async getSales() {
    const res = await fetch(`${API_URL}/api/sales`, { headers: { ...this._authHeaders() } });
    const data = await res.json();
    return data.ok ? data : { vendas: [], total: 0 };
  },

  // ---------- avaliações ----------
  async getProductReviews(productId) {
    const res = await fetch(`${API_URL}/api/products/${productId}/reviews`);
    return await res.json();   // { ok, reviews, media, count }
  },

  async addProductReview(productId, nota, comentario) {
    const res = await fetch(`${API_URL}/api/products/${productId}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify({ nota, comentario })
    });
    return await res.json();
  },

  async deleteProductReview(productId) {
    const res = await fetch(`${API_URL}/api/products/${productId}/reviews`, {
      method: 'DELETE',
      headers: { ...this._authHeaders() }
    });
    return await res.json();
  },

  async getMyReviews(userId) {
    const res = await fetch(`${API_URL}/api/users/${userId}/reviews`, { headers: { ...this._authHeaders() } });
    const data = await res.json();
    return data.ok ? (data.reviews || []) : [];
  },

  // ---------- entregas ----------
  // Pedidos comprados por outras pessoas que ainda esperam um entregador.
  // Passando a posição atual, a lista vem ordenada do mais perto para o mais longe.
  async getAvailableDeliveries(pos = null) {
    const qs = pos ? `?lat=${pos.lat}&lng=${pos.lng}` : '';
    const res = await fetch(`${API_URL}/api/deliveries/available${qs}`, { headers: { ...this._authHeaders() } });
    return await res.json();
  },

  async acceptDelivery(pedidoId) {
    const res = await fetch(`${API_URL}/api/deliveries/${pedidoId}/accept`, {
      method: 'POST', headers: { ...this._authHeaders() }
    });
    return await res.json();
  },

  async releaseDelivery(pedidoId) {
    const res = await fetch(`${API_URL}/api/deliveries/${pedidoId}/release`, {
      method: 'POST', headers: { ...this._authHeaders() }
    });
    return await res.json();
  },

  async getMyDeliveries() {
    const res = await fetch(`${API_URL}/api/deliveries/mine`, { headers: { ...this._authHeaders() } });
    return await res.json();
  },

  // Envia a posição do entregador — é isto que o comprador vê se mexendo no mapa
  async sendDeliveryLocation(pedidoId, lat, lng, precisao = null) {
    const res = await fetch(`${API_URL}/api/deliveries/${pedidoId}/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify({ lat, lng, precisao })
    });
    return await res.json();
  },

  async setDeliveryStatus(pedidoId, status) {
    const res = await fetch(`${API_URL}/api/deliveries/${pedidoId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify({ status })
    });
    return await res.json();
  },

  // Rastreio do lado do comprador
  async getMyTracking() {
    const res = await fetch(`${API_URL}/api/deliveries/tracking`, { headers: { ...this._authHeaders() } });
    const data = await res.json();
    return data.ok ? (data.pedidos || []) : [];
  },

  async getOrderTracking(pedidoId) {
    const res = await fetch(`${API_URL}/api/deliveries/${pedidoId}/tracking`, { headers: { ...this._authHeaders() } });
    return await res.json();
  }
};

// ============================================================
//  ENTREGAS – helpers de exibição (usados pelo entregador e pelo comprador)
// ============================================================

const ENTREGA_LABEL = {
  aguardando: { texto: 'Aguardando entregador', icone: '🕓', cor: '#f4c56a' },
  aceito:     { texto: 'Entregador a caminho da loja', icone: '📦', cor: '#7b9ff4' },
  a_caminho:  { texto: 'Saiu para entrega', icone: '🛵', cor: '#e8854a' },
  entregue:   { texto: 'Entregue', icone: '✅', cor: '#5dcfa0' }
};

function entregaLabel(status) {
  return ENTREGA_LABEL[status] || ENTREGA_LABEL.aguardando;
}

// Quão confiável é o pino do cliente no mapa. Só o GPS do próprio cliente (ou o
// endereço achado com número) aponta a porta; CEP e cidade caem no meio da região.
const PRECISAO_ENTREGA = {
  gps:    { exato: true,  texto: 'Ponto confirmado pelo GPS do cliente' },
  exata:  { exato: true,  texto: 'Endereço localizado com número' },
  rua:    { exato: false, texto: 'Ponto aproximado: rua encontrada, sem o número' },
  bairro: { exato: false, texto: 'Ponto aproximado: centro do bairro' },
  cep:    { exato: false, texto: 'Ponto aproximado: centro do CEP' },
  cidade: { exato: false, texto: 'Ponto MUITO impreciso: centro da cidade — guie-se pelo endereço escrito' }
};

function precisaoEntrega(entrega) {
  if (!entrega || entrega.lat == null) {
    return { exato: false, texto: 'Sem ponto no mapa — use o endereço escrito', semMapa: true };
  }
  return PRECISAO_ENTREGA[entrega.precisao] ||
         { exato: false, texto: 'Ponto aproximado' };
}

function formatEndereco(e) {
  if (!e) return 'Endereço não informado';
  const linha1 = [e.logradouro, e.numero].filter(Boolean).join(', ');
  const linha2 = [e.bairro, e.cidade, e.uf].filter(Boolean).join(' · ');
  const cep    = e.cep ? `CEP ${String(e.cep).replace(/(\d{5})(\d{3})/, '$1-$2')}` : '';
  return [linha1, e.complemento, linha2, cep].filter(Boolean).join(' — ') || 'Endereço não informado';
}

// "há 12s" / "há 3 min" — mostra se a posição do entregador está fresca
function tempoRelativo(iso) {
  if (!iso) return '—';
  const seg = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seg < 60)   return `há ${Math.max(0, seg)}s`;
  if (seg < 3600) return `há ${Math.floor(seg / 60)} min`;
  if (seg < 86400) return `há ${Math.floor(seg / 3600)}h`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

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
//  IMAGE UPLOAD HELPERS
// ============================================================

function createImageUploadHandler(inputId, previewId, uploadCallback) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  
  if (!input || !preview) return;

  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Validar arquivo
    if (!file.type.startsWith('image/')) {
      toast('Por favor, selecione uma imagem válida.', 'error');
      input.value = '';
      return;
    }

    if (file.size > 5 * 1024 * 1024) { // 5MB
      toast('A imagem deve ter no máximo 5MB.', 'error');
      input.value = '';
      return;
    }

    // Mostrar preview
    const reader = new FileReader();
    reader.onload = (e) => {
      preview.innerHTML = `
        <div style="position: relative; display: inline-block;">
          <img src="${e.target.result}" style="max-width: 200px; max-height: 200px; border-radius: 8px; border: 1px solid var(--border);">
          <button type="button" onclick="removeImage('${inputId}', '${previewId}')" 
                  style="position: absolute; top: -8px; right: -8px; background: var(--red); color: white; 
                         border: none; border-radius: 50%; width: 24px; height: 24px; cursor: pointer; 
                         display: flex; align-items: center; justify-content: center; font-size: 12px;">
            ×
          </button>
        </div>
      `;
    };
    reader.readAsDataURL(file);

    // Fazer upload
    try {
      if (uploadCallback) {
        await uploadCallback(file);
      }
    } catch (error) {
      console.error('Erro no upload:', error);
      toast('Erro ao fazer upload da imagem.', 'error');
      removeImage(inputId, previewId);
    }
  });
}

function removeImage(inputId, previewId) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  
  if (input) input.value = '';
  if (preview) preview.innerHTML = '';
}

async function handleProfileImageUpload(userId) {
  const input = document.getElementById('profile-image-input');
  const file = input.files[0];
  if (!file) return;

  try {
    const result = await DB.updateProfileImage(userId, file);
    if (result.ok) {
      toast('Foto de perfil atualizada com sucesso!');
      const user = DB.currentUser();
      if (user) {
        user.profile_image = result.imageUrl;
        const sessionData = JSON.parse(localStorage.getItem('mp_session'));
        sessionData.user = user;
        localStorage.setItem('mp_session', JSON.stringify(sessionData));
        if (typeof renderNav === 'function') renderNav();
      }
      // Atualizar avatar visualmente na página de perfil
      const avatarEl = document.getElementById('profile-avatar');
      if (avatarEl) {
        avatarEl.style.backgroundImage = `url('${result.imageUrl}')`;
        avatarEl.style.backgroundSize = 'cover';
        avatarEl.style.backgroundPosition = 'center';
        avatarEl.textContent = '';
      }
    } else {
      toast(result.msg || 'Erro ao atualizar foto de perfil.', 'error');
    }
  } catch (error) {
    console.error('Erro:', error);
    toast('Erro ao atualizar foto de perfil.', 'error');
  }
}

async function handleStoreLogoUpload(storeId) {
  const input = document.getElementById('store-logo-input');
  const file = input.files[0];
  if (!file) return;

  try {
    const result = await DB.updateStoreLogo(storeId, file);
    if (result.ok) {
      toast('Logo da loja atualizado com sucesso!');
      // Atualizar preview se existir
      const preview = document.getElementById('logo-preview');
      if (preview) {
        preview.innerHTML = `<img src="${result.logoUrl}" style="max-width: 100px; max-height: 100px; border-radius: 8px;">`;
      }
    } else {
      toast(result.msg || 'Erro ao atualizar logo.', 'error');
    }
  } catch (error) {
    console.error('Erro:', error);
    toast('Erro ao atualizar logo.', 'error');
  }
}

async function handleStoreBannerUpload(storeId) {
  const input = document.getElementById('store-banner-input');
  const file = input.files[0];
  if (!file) return;

  try {
    const result = await DB.updateStoreBanner(storeId, file);
    if (result.ok) {
      toast('Banner da loja atualizado com sucesso!');
      // Atualizar preview se existir
      const preview = document.getElementById('banner-preview');
      if (preview) {
        preview.innerHTML = `<img src="${result.bannerUrl}" style="max-width: 300px; max-height: 150px; border-radius: 8px;">`;
      }
    } else {
      toast(result.msg || 'Erro ao atualizar banner.', 'error');
    }
  } catch (error) {
    console.error('Erro:', error);
    toast('Erro ao atualizar banner.', 'error');
  }
}

async function handleProductImageUpload(productId) {
  const input = document.getElementById('product-image-input');
  const file = input.files[0];
  if (!file) return;

  try {
    const result = await DB.updateProductImage(productId, file);
    if (result.ok) {
      toast('Imagem do produto atualizada com sucesso!');
      // Atualizar preview se existir
      const preview = document.getElementById('product-image-preview');
      if (preview) {
        preview.innerHTML = `<img src="${result.imageUrl}" style="max-width: 150px; max-height: 150px; border-radius: 8px;">`;
      }
    } else {
      toast(result.msg || 'Erro ao atualizar imagem.', 'error');
    }
  } catch (error) {
    console.error('Erro:', error);
    toast('Erro ao atualizar imagem.', 'error');
  }
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
    } else if (timeLeft < (10 * 60 * 1000)) {
      // Faltam menos de 10 minutos
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
