-- ============================================
--  MARKETPLACE DATABASE SCHEMA
-- ============================================

CREATE DATABASE IF NOT EXISTS marketplace;
USE marketplace;

-- Tabela de usuários (lojistas e clientes)
CREATE TABLE usuarios (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    nome        VARCHAR(100) NOT NULL,
    email       VARCHAR(150) NOT NULL UNIQUE,
    senha_hash  VARCHAR(255) NOT NULL,
    tipo        ENUM('lojista', 'cliente') NOT NULL DEFAULT 'cliente',
    criado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de lojas (uma por lojista)
CREATE TABLE lojas (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    usuario_id      INT NOT NULL,
    nome            VARCHAR(150) NOT NULL,
    descricao       TEXT,
    categoria       VARCHAR(80),
    logo_url        VARCHAR(255),
    banner_url      VARCHAR(255),
    telefone        VARCHAR(20),
    endereco        VARCHAR(255),
    cidade          VARCHAR(100),
    estado          VARCHAR(50),
    ativa           BOOLEAN DEFAULT TRUE,
    criado_em       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- Tabela de categorias de produto
CREATE TABLE categorias (
    id      INT AUTO_INCREMENT PRIMARY KEY,
    nome    VARCHAR(100) NOT NULL UNIQUE
);

INSERT INTO categorias (nome) VALUES
  ('Eletrônicos'), ('Moda'), ('Alimentos'), ('Casa & Decoração'),
  ('Esportes'), ('Beleza'), ('Livros'), ('Brinquedos'), ('Outros');

-- Tabela de produtos
CREATE TABLE produtos (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    loja_id         INT NOT NULL,
    categoria_id    INT,
    nome            VARCHAR(200) NOT NULL,
    descricao       TEXT,
    preco           DECIMAL(10,2) NOT NULL,
    estoque         INT DEFAULT 0,
    imagem_url      VARCHAR(255),
    ativo           BOOLEAN DEFAULT TRUE,
    criado_em       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (loja_id)      REFERENCES lojas(id)      ON DELETE CASCADE,
    FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE SET NULL
);

-- Índices para buscas rápidas
CREATE INDEX idx_produtos_loja      ON produtos(loja_id);
CREATE INDEX idx_produtos_categoria ON produtos(categoria_id);
CREATE INDEX idx_lojas_usuario      ON lojas(usuario_id);
CREATE INDEX idx_usuarios_email     ON usuarios(email);

-- ============================================
-- VIEWS ÚTEIS
-- ============================================

-- Visão pública: lojas com contagem de produtos
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
GROUP BY l.id;

-- Visão de produtos com info da loja
CREATE VIEW v_produtos_publicos AS
SELECT
    p.id,
    p.nome            AS produto_nome,
    p.descricao,
    p.preco,
    p.estoque,
    p.imagem_url,
    c.nome            AS categoria_nome,
    l.id              AS loja_id,
    l.nome            AS loja_nome,
    l.cidade,
    l.estado
FROM produtos p
JOIN lojas l      ON l.id = p.loja_id
LEFT JOIN categorias c ON c.id = p.categoria_id
WHERE p.ativo = TRUE AND l.ativa = TRUE;
