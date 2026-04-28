-- ============================================
--  HARD RESET - LIMPEZA COMPLETA
-- ============================================

-- ATENÇÃO: Este script vai deletar TODOS os dados e recriar do zero

-- Deletar todas as tabelas existentes
DROP TABLE IF EXISTS produtos CASCADE;
DROP TABLE IF EXISTS lojas CASCADE;
DROP TABLE IF EXISTS categorias CASCADE;
DROP TABLE IF EXISTS usuarios CASCADE;

-- Deletar views
DROP VIEW IF EXISTS v_lojas_publicas;
DROP VIEW IF EXISTS v_produtos_publicos;

-- Criar bucket para imagens (se não existir)
INSERT INTO storage.buckets (id, name, public)
VALUES ('marketplace-images', 'marketplace-images', true)
ON CONFLICT (id) DO NOTHING;

-- ============================================
--  RECREATE TABELAS DO ZERO
-- ============================================

-- Tabela de usuários com UUID
CREATE TABLE usuarios (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome        TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    senha_hash  TEXT NOT NULL,
    tipo        TEXT NOT NULL DEFAULT 'cliente' CHECK (tipo IN ('lojista', 'cliente')),
    profile_image TEXT,
    telefone    TEXT,
    data_nasc   TEXT,
    endereco    TEXT,
    cidade      TEXT,
    estado      TEXT,
    cep         TEXT,
    criado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Habilitar RLS
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;

-- Políticas RLS para usuários
CREATE POLICY "Users can view own profile" ON usuarios
  FOR SELECT USING (auth.uid()::text = id::text);

CREATE POLICY "Users can update own profile" ON usuarios
  FOR UPDATE USING (auth.uid()::text = id::text)
  WITH CHECK (auth.uid()::text = id::text);

CREATE POLICY "Allow user registration" ON usuarios
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public read for auth" ON usuarios
  FOR SELECT USING (true);

-- Tabela de categorias
CREATE TABLE categorias (
    id      SERIAL PRIMARY KEY,
    nome    TEXT NOT NULL UNIQUE
);

-- Habilitar RLS
ALTER TABLE categorias ENABLE ROW LEVEL SECURITY;

-- Políticas RLS para categorias
CREATE POLICY "Public can view categories" ON categorias
  FOR SELECT USING (true);

CREATE POLICY "Authenticated users can manage categories" ON categorias
  FOR ALL USING (auth.uid() IS NOT NULL);

-- Inserir categorias padrão
INSERT INTO categorias (nome) VALUES
  ('Eletrônicos'), ('Moda'), ('Alimentos'), ('Casa & Decoração'),
  ('Esportes'), ('Beleza'), ('Livros'), ('Brinquedos'), ('Outros');

-- Tabela de lojas
CREATE TABLE lojas (
    id              SERIAL PRIMARY KEY,
    usuario_id      UUID NOT NULL,
    nome            TEXT NOT NULL,
    descricao       TEXT,
    categoria       TEXT,
    logo_url        TEXT,
    banner_url      TEXT,
    telefone        TEXT,
    endereco        TEXT,
    cidade          TEXT,
    estado          TEXT,
    ativa           BOOLEAN DEFAULT TRUE,
    criado_em       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- Habilitar RLS
ALTER TABLE lojas ENABLE ROW LEVEL SECURITY;

-- Políticas RLS para lojas
CREATE POLICY "Public can view active stores" ON lojas
  FOR SELECT USING (ativa = true);

CREATE POLICY "Store owners can view own stores" ON lojas
  FOR SELECT USING (auth.uid()::text = usuario_id::text);

CREATE POLICY "Store owners can insert own stores" ON lojas
  FOR INSERT WITH CHECK (auth.uid()::text = usuario_id::text);

CREATE POLICY "Store owners can update own stores" ON lojas
  FOR UPDATE USING (auth.uid()::text = usuario_id::text)
  WITH CHECK (auth.uid()::text = usuario_id::text);

CREATE POLICY "Store owners can delete own stores" ON lojas
  FOR DELETE USING (auth.uid()::text = usuario_id::text);

-- Tabela de produtos
CREATE TABLE produtos (
    id              SERIAL PRIMARY KEY,
    loja_id         INTEGER NOT NULL,
    categoria_id    INTEGER,
    nome            TEXT NOT NULL,
    descricao       TEXT,
    preco           REAL NOT NULL,
    estoque         INTEGER DEFAULT 0,
    imagem_url      TEXT,
    ativo           BOOLEAN DEFAULT TRUE,
    criado_em       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (loja_id)      REFERENCES lojas(id)      ON DELETE CASCADE,
    FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE SET NULL
);

-- Habilitar RLS
ALTER TABLE produtos ENABLE ROW LEVEL SECURITY;

-- Políticas RLS para produtos
CREATE POLICY "Public can view active products" ON produtos
  FOR SELECT USING (
    ativo = true AND
    EXISTS (
      SELECT 1 FROM lojas l
      WHERE l.id = produtos.loja_id AND l.ativa = true
    )
  );

CREATE POLICY "Store owners can view own products" ON produtos
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM lojas l
      WHERE l.id = produtos.loja_id AND l.usuario_id::text = auth.uid()::text
    )
  );

CREATE POLICY "Store owners can insert products in own stores" ON produtos
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM lojas l
      WHERE l.id = produtos.loja_id AND l.usuario_id::text = auth.uid()::text
    )
  );

CREATE POLICY "Store owners can update own products" ON produtos
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM lojas l
      WHERE l.id = produtos.loja_id AND l.usuario_id::text = auth.uid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM lojas l
      WHERE l.id = produtos.loja_id AND l.usuario_id::text = auth.uid()::text
    )
  );

CREATE POLICY "Store owners can delete own products" ON produtos
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM lojas l
      WHERE l.id = produtos.loja_id AND l.usuario_id::text = auth.uid()::text
    )
  );

-- Índices
CREATE INDEX idx_produtos_loja      ON produtos(loja_id);
CREATE INDEX idx_produtos_categoria ON produtos(categoria_id);
CREATE INDEX idx_lojas_usuario      ON lojas(usuario_id);
CREATE INDEX idx_usuarios_email     ON usuarios(email);

-- Views
CREATE VIEW v_lojas_publicas AS
SELECT
    l.id,
    l.nome            AS loja_nome,
    l.descricao,
    l.categoria,
    l.logo_url,
    l.cidade,
    l.estado,
    u.nome            AS lojista_nome,
    COUNT(p.id)       AS total_produtos,
    MIN(p.preco)      AS menor_preco
FROM lojas l
JOIN usuarios u ON u.id = l.usuario_id
LEFT JOIN produtos p ON p.loja_id = l.id AND p.ativo = TRUE
WHERE l.ativa = TRUE
GROUP BY l.id, l.nome, l.descricao, l.categoria, l.logo_url, l.cidade, l.estado, u.nome;

CREATE VIEW v_produtos_publicos AS
SELECT
    p.id,
    p.nome            AS produto_nome,
    p.descricao,
    p.preco,
    p.estoque,
    p.imagem_url,
    p.ativo,
    c.nome            AS categoria_nome,
    l.id              AS loja_id,
    l.nome            AS loja_nome,
    l.cidade,
    l.estado,
    u.nome            AS lojista_nome
FROM produtos p
JOIN lojas l      ON l.id = p.loja_id
JOIN usuarios u ON u.id = l.usuario_id
LEFT JOIN categorias c ON c.id = p.categoria_id
WHERE p.ativo = TRUE AND l.ativa = TRUE;
