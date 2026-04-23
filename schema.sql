-- ============================================
--  MARKETPLACE DATABASE SCHEMA (SQLite)
-- ============================================

-- Tabela de usuários (lojistas e clientes)
CREATE TABLE IF NOT EXISTS usuarios (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
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
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de lojas (uma por lojista)
CREATE TABLE IF NOT EXISTS lojas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id      INTEGER NOT NULL,
    nome            TEXT NOT NULL,
    descricao       TEXT,
    categoria       TEXT,
    logo_url        TEXT,
    banner_url      TEXT,
    telefone        TEXT,
    endereco        TEXT,
    cidade          TEXT,
    estado          TEXT,
    ativa           INTEGER DEFAULT 1,
    criado_em       DATETIME DEFAULT CURRENT_TIMESTAMP,
    atualizado_em   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- Tabela de categorias de produto
CREATE TABLE IF NOT EXISTS categorias (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    nome    TEXT NOT NULL UNIQUE
);

INSERT OR IGNORE INTO categorias (nome) VALUES
  ('Eletrônicos'), ('Moda'), ('Alimentos'), ('Casa & Decoração'),
  ('Esportes'), ('Beleza'), ('Livros'), ('Brinquedos'), ('Outros');

-- Tabela de produtos
CREATE TABLE IF NOT EXISTS produtos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    loja_id         INTEGER NOT NULL,
    categoria_id    INTEGER,
    nome            TEXT NOT NULL,
    descricao       TEXT,
    preco           REAL NOT NULL,
    estoque         INTEGER DEFAULT 0,
    imagem_url      TEXT,
    ativo           INTEGER DEFAULT 1,
    criado_em       DATETIME DEFAULT CURRENT_TIMESTAMP,
    atualizado_em   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (loja_id)      REFERENCES lojas(id)      ON DELETE CASCADE,
    FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE SET NULL
);

-- Índices para buscas rápidas
CREATE INDEX IF NOT EXISTS idx_produtos_loja      ON produtos(loja_id);
CREATE INDEX IF NOT EXISTS idx_produtos_categoria ON produtos(categoria_id);
CREATE INDEX IF NOT EXISTS idx_lojas_usuario      ON lojas(usuario_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_email     ON usuarios(email);

-- ============================================
-- VIEWS ÚTEIS
-- ============================================

-- Visão pública: lojas com contagem de produtos
CREATE VIEW IF NOT EXISTS v_lojas_publicas AS
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
LEFT JOIN produtos p ON p.loja_id = l.id AND p.ativo = 1
WHERE l.ativa = 1
GROUP BY l.id;

-- Visão de produtos com info da loja
CREATE VIEW IF NOT EXISTS v_produtos_publicos AS
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
WHERE p.ativo = 1 AND l.ativa = 1;
