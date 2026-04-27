-- ============================================
--  ENABLE RLS - Comandos para executar no Supabase SQL Editor
-- ============================================

-- Habilitar RLS nas tabelas
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE lojas ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorias ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos ENABLE ROW LEVEL SECURITY;

-- Políticas RLS para usuários
-- Usuários podem ver seu próprio perfil
CREATE POLICY "Users can view own profile" ON usuarios
  FOR SELECT USING (auth.uid()::text = id::text);

-- Usuários podem atualizar seu próprio perfil (exceto senha)
CREATE POLICY "Users can update own profile" ON usuarios
  FOR UPDATE USING (auth.uid()::text = id::text)
  WITH CHECK (auth.uid()::text = id::text);

-- Permitir inserção para registro (será controlado pelo código)
CREATE POLICY "Allow user registration" ON usuarios
  FOR INSERT WITH CHECK (true);

-- Permitir leitura pública para algumas operações (será controlado pelo código)
CREATE POLICY "Allow public read for auth" ON usuarios
  FOR SELECT USING (true);

-- Políticas RLS para lojas
-- Todos podem ver lojas ativas (público)
CREATE POLICY "Public can view active stores" ON lojas
  FOR SELECT USING (ativa = true);

-- Lojistas podem ver suas próprias lojas (ativas ou não)
CREATE POLICY "Store owners can view own stores" ON lojas
  FOR SELECT USING (auth.uid()::text = usuario_id::text);

-- Lojistas podem inserir suas próprias lojas
CREATE POLICY "Store owners can insert own stores" ON lojas
  FOR INSERT WITH CHECK (auth.uid()::text = usuario_id::text);

-- Lojistas podem atualizar suas próprias lojas
CREATE POLICY "Store owners can update own stores" ON lojas
  FOR UPDATE USING (auth.uid()::text = usuario_id::text)
  WITH CHECK (auth.uid()::text = usuario_id::text);

-- Lojistas podem deletar suas próprias lojas
CREATE POLICY "Store owners can delete own stores" ON lojas
  FOR DELETE USING (auth.uid()::text = usuario_id::text);

-- Políticas RLS para categorias
-- Todos podem ver categorias
CREATE POLICY "Public can view categories" ON categorias
  FOR SELECT USING (true);

-- Usuários autenticados podem gerenciar categorias (por enquanto)
CREATE POLICY "Authenticated users can manage categories" ON categorias
  FOR ALL USING (auth.uid() IS NOT NULL);

-- Políticas RLS para produtos
-- Todos podem ver produtos ativos de lojas ativas
CREATE POLICY "Public can view active products" ON produtos
  FOR SELECT USING (
    ativo = true AND
    EXISTS (
      SELECT 1 FROM lojas l
      WHERE l.id = produtos.loja_id AND l.ativa = true
    )
  );

-- Lojistas podem ver todos os seus produtos (ativos ou não)
CREATE POLICY "Store owners can view own products" ON produtos
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM lojas l
      WHERE l.id = produtos.loja_id AND l.usuario_id::text = auth.uid()::text
    )
  );

-- Lojistas podem inserir produtos em suas lojas
CREATE POLICY "Store owners can insert products in own stores" ON produtos
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM lojas l
      WHERE l.id = produtos.loja_id AND l.usuario_id::text = auth.uid()::text
    )
  );

-- Lojistas podem atualizar seus próprios produtos
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

-- Lojistas podem deletar seus próprios produtos
CREATE POLICY "Store owners can delete own products" ON produtos
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM lojas l
      WHERE l.id = produtos.loja_id AND l.usuario_id::text = auth.uid()::text
    )
  );