-- =====================================================================
-- GOOD CAKE · SISTEMA DE GESTÃO
-- Banco de dados (Supabase / PostgreSQL)
-- Rodar inteiro no SQL Editor de um projeto NOVO do Supabase.
-- =====================================================================

-- gen_random_uuid() é nativo do PostgreSQL 13+

-- ---------------------------------------------------------------------
-- 1. UNIDADES, USUÁRIOS E ACESSO
-- ---------------------------------------------------------------------
create table public.unidades (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  nome        text not null,
  cidade      text,
  responsavel text,
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.perfis (
  id         uuid primary key references auth.users(id) on delete cascade,
  nome       text not null default '',
  email      text,
  papel      text not null default 'pendente' check (papel in ('gestor','operador','pendente')),
  ativo      boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.membros_unidade (
  user_id    uuid not null references public.perfis(id) on delete cascade,
  unidade_id uuid not null references public.unidades(id) on delete cascade,
  primary key (user_id, unidade_id)
);

create table public.config (
  chave text primary key,
  valor jsonb not null
);

-- usuário logado é gestor ativo?
create or replace function public.eh_gestor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfis where id = auth.uid() and papel = 'gestor' and ativo);
$$;

-- usuário logado está liberado (gestor ou operador ativo)?
create or replace function public.usuario_liberado() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfis where id = auth.uid() and papel in ('gestor','operador') and ativo);
$$;

-- usuário logado acessa a unidade? (gestor acessa todas)
create or replace function public.tem_acesso(p_unidade uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.eh_gestor() or exists (
    select 1 from membros_unidade m join perfis p on p.id = m.user_id
    where m.user_id = auth.uid() and m.unidade_id = p_unidade and p.ativo and p.papel = 'operador');
$$;

-- novo usuário: o primeiro vira gestor; os demais ficam "pendente" até um gestor liberar
create or replace function public.fn_novo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into perfis (id, nome, email, papel)
  values (new.id,
          coalesce(nullif(new.raw_user_meta_data->>'nome',''), split_part(new.email,'@',1)),
          new.email,
          case when not exists (select 1 from perfis where papel = 'gestor') then 'gestor' else 'pendente' end);
  return new;
end $$;

create trigger trg_novo_usuario after insert on auth.users
for each row execute function public.fn_novo_usuario();

-- ---------------------------------------------------------------------
-- 2. CADASTROS: FORNECEDORES, INSUMOS, PREPAROS, PRODUTOS (FICHAS TÉCNICAS)
-- ---------------------------------------------------------------------
create table public.fornecedores (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  telefone   text,
  cidade     text,
  obs        text,
  ativo      boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.insumos (
  id               uuid primary key default gen_random_uuid(),
  nome             text not null,
  categoria        text not null default 'Ingrediente' check (categoria in ('Ingrediente','Embalagem','Outros')),
  unidade          text not null check (unidade in ('g','ml','un')),
  embalagem_padrao numeric,                       -- conteúdo de 1 embalagem (ex.: 395 g)
  custo_referencia numeric not null default 0,    -- R$ por g / ml / un (última compra)
  estoque_minimo   numeric not null default 0,
  marca_indicada   text,
  ativo            boolean not null default true,
  created_at       timestamptz not null default now()
);

create table public.preparos (
  id           uuid primary key default gen_random_uuid(),
  codigo       text unique not null,
  nome         text not null,
  rendimento   numeric not null check (rendimento > 0),   -- em gramas
  modo_preparo text,
  ativo        boolean not null default true,
  created_at   timestamptz not null default now()
);

create table public.preparo_itens (
  id             uuid primary key default gen_random_uuid(),
  preparo_id     uuid not null references public.preparos(id) on delete cascade,
  insumo_id      uuid references public.insumos(id),
  sub_preparo_id uuid references public.preparos(id),
  quantidade     numeric not null check (quantidade > 0),
  check (num_nonnulls(insumo_id, sub_preparo_id) = 1),
  check (sub_preparo_id is null or sub_preparo_id <> preparo_id)
);

create table public.produtos (
  id          uuid primary key default gen_random_uuid(),
  codigo      text unique not null,
  nome        text not null,
  linha       text not null default 'Comum' check (linha in ('Comum','Premium')),
  preco_venda numeric not null default 0,
  alergenos   text,
  montagem    text,
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.produto_itens (
  id         uuid primary key default gen_random_uuid(),
  produto_id uuid not null references public.produtos(id) on delete cascade,
  insumo_id  uuid references public.insumos(id),
  preparo_id uuid references public.preparos(id),
  quantidade numeric not null check (quantidade > 0),
  check (num_nonnulls(insumo_id, preparo_id) = 1)
);

create table public.historico_precos (
  id             uuid primary key default gen_random_uuid(),
  produto_id     uuid not null references public.produtos(id) on delete cascade,
  preco_anterior numeric,
  preco_novo     numeric,
  alterado_por   uuid default auth.uid(),
  alterado_em    timestamptz not null default now()
);

create or replace function public.fn_historico_preco() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.preco_venda is distinct from old.preco_venda then
    insert into historico_precos (produto_id, preco_anterior, preco_novo) values (new.id, old.preco_venda, new.preco_venda);
  end if;
  return new;
end $$;
create trigger trg_historico_preco after update on public.produtos
for each row execute function public.fn_historico_preco();

-- ---------------------------------------------------------------------
-- 3. ESTOQUE E MOVIMENTOS (livro-razão único)
-- ---------------------------------------------------------------------
create table public.estoque_insumos (
  unidade_id    uuid not null references public.unidades(id) on delete cascade,
  insumo_id     uuid not null references public.insumos(id) on delete cascade,
  quantidade    numeric not null default 0,
  custo_medio   numeric not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (unidade_id, insumo_id)
);

create table public.estoque_produtos (
  unidade_id    uuid not null references public.unidades(id) on delete cascade,
  produto_id    uuid not null references public.produtos(id) on delete cascade,
  quantidade    numeric not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (unidade_id, produto_id)
);

create table public.movimentos (
  id             uuid primary key default gen_random_uuid(),
  unidade_id     uuid not null references public.unidades(id),
  data           date not null default current_date,
  tipo           text not null check (tipo in ('entrada','producao','consumo_producao','venda',
                    'transferencia_saida','transferencia_entrada','ajuste_contagem','perda','estorno')),
  insumo_id      uuid references public.insumos(id),
  produto_id     uuid references public.produtos(id),
  quantidade     numeric not null,           -- positivo entra, negativo sai
  custo_unitario numeric not null default 0,
  valor          numeric generated always as (quantidade * custo_unitario) stored,
  fornecedor_id  uuid references public.fornecedores(id),
  validade       date,
  documento_id   uuid,                       -- entrada / produção / venda / transferência / contagem
  obs            text,
  criado_por     uuid default auth.uid(),
  criado_em      timestamptz not null default now(),
  check (num_nonnulls(insumo_id, produto_id) = 1)
);
create index on public.movimentos (unidade_id, data);
create index on public.movimentos (documento_id);

-- aplica cada movimento no saldo (e no custo médio dos insumos)
create or replace function public.fn_aplicar_movimento() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_q numeric; v_c numeric;
begin
  if new.insumo_id is not null then
    insert into estoque_insumos (unidade_id, insumo_id, quantidade, custo_medio)
    values (new.unidade_id, new.insumo_id, 0, 0) on conflict do nothing;
    select quantidade, custo_medio into v_q, v_c from estoque_insumos
      where unidade_id = new.unidade_id and insumo_id = new.insumo_id for update;
    if new.quantidade > 0 and new.tipo in ('entrada','transferencia_entrada') and new.custo_unitario > 0 then
      v_c := case when v_q > 0 then (v_q * v_c + new.quantidade * new.custo_unitario) / (v_q + new.quantidade)
                  else new.custo_unitario end;
    end if;
    update estoque_insumos set quantidade = v_q + new.quantidade, custo_medio = v_c, atualizado_em = now()
      where unidade_id = new.unidade_id and insumo_id = new.insumo_id;
    if new.tipo = 'entrada' and new.quantidade > 0 and new.custo_unitario > 0 then
      update insumos set custo_referencia = new.custo_unitario where id = new.insumo_id;
    end if;
  else
    insert into estoque_produtos (unidade_id, produto_id, quantidade)
    values (new.unidade_id, new.produto_id, new.quantidade)
    on conflict (unidade_id, produto_id)
    do update set quantidade = estoque_produtos.quantidade + excluded.quantidade, atualizado_em = now();
  end if;
  return new;
end $$;
create trigger trg_aplicar_movimento after insert on public.movimentos
for each row execute function public.fn_aplicar_movimento();

-- ---------------------------------------------------------------------
-- 4. CUSTOS (fichas técnicas) — calculados na hora, por unidade
-- ---------------------------------------------------------------------
create or replace function public.custo_insumo(p_insumo uuid, p_unidade uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(custo_medio,0) from estoque_insumos
       where unidade_id = p_unidade and insumo_id = p_insumo and quantidade > 0),
    (select custo_referencia from insumos where id = p_insumo), 0);
$$;

create or replace function public.custo_preparo_g(p_preparo uuid, p_unidade uuid, p_nivel int default 0) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare v_total numeric := 0; v_rend numeric; r record;
begin
  if p_nivel > 6 then return 0; end if;
  select rendimento into v_rend from preparos where id = p_preparo;
  for r in select * from preparo_itens where preparo_id = p_preparo loop
    if r.insumo_id is not null then
      v_total := v_total + r.quantidade * custo_insumo(r.insumo_id, p_unidade);
    else
      v_total := v_total + r.quantidade * custo_preparo_g(r.sub_preparo_id, p_unidade, p_nivel + 1);
    end if;
  end loop;
  return case when coalesce(v_rend,0) > 0 then v_total / v_rend else 0 end;
end $$;

create or replace function public.custo_produto(p_produto uuid, p_unidade uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when pi.insumo_id is not null
                           then pi.quantidade * public.custo_insumo(pi.insumo_id, p_unidade)
                           else pi.quantidade * public.custo_preparo_g(pi.preparo_id, p_unidade) end), 0)
  from produto_itens pi where pi.produto_id = p_produto;
$$;

-- quanto de cada insumo vai em N unidades de um produto (explode preparos)
create or replace function public.explodir_produto(p_produto uuid, p_qtd numeric)
returns table (insumo_id uuid, quantidade numeric)
language sql stable security definer set search_path = public as $$
  with recursive arvore as (
    select pi.insumo_id, pi.preparo_id, pi.quantidade * p_qtd as qtd, 0 as nivel
      from produto_itens pi where pi.produto_id = p_produto
    union all
    select it.insumo_id, it.sub_preparo_id, a.qtd * it.quantidade / pr.rendimento, a.nivel + 1
      from arvore a
      join preparos pr on pr.id = a.preparo_id
      join preparo_itens it on it.preparo_id = pr.id
     where a.preparo_id is not null and a.nivel < 6
  )
  select arvore.insumo_id, sum(arvore.qtd) from arvore where arvore.insumo_id is not null group by arvore.insumo_id;
$$;

-- fichas técnicas com custo e CMV teórico da unidade
create or replace function public.fichas_custos(p_unidade uuid)
returns table (produto_id uuid, codigo text, nome text, linha text, preco_venda numeric, custo numeric, cmv numeric, ativo boolean)
language sql stable security definer set search_path = public as $$
  select p.id, p.codigo, p.nome, p.linha, p.preco_venda,
         round(public.custo_produto(p.id, p_unidade), 4),
         case when p.preco_venda > 0 then round(public.custo_produto(p.id, p_unidade) / p.preco_venda, 4) end,
         p.ativo
  from produtos p
  where public.usuario_liberado()
  order by p.codigo;
$$;

create or replace function public.preparos_custos(p_unidade uuid)
returns table (preparo_id uuid, codigo text, nome text, rendimento numeric, custo_g numeric, custo_total numeric)
language sql stable security definer set search_path = public as $$
  select pr.id, pr.codigo, pr.nome, pr.rendimento,
         round(public.custo_preparo_g(pr.id, p_unidade), 6),
         round(public.custo_preparo_g(pr.id, p_unidade) * pr.rendimento, 2)
  from preparos pr
  where public.usuario_liberado()
  order by pr.codigo;
$$;

-- ---------------------------------------------------------------------
-- 5. OPERAÇÃO: ENTRADAS, PRODUÇÃO, VENDAS, RESERVAS, TRANSFERÊNCIAS, PERDAS
-- ---------------------------------------------------------------------
create table public.entradas (
  id            uuid primary key default gen_random_uuid(),
  unidade_id    uuid not null references public.unidades(id),
  data          date not null default current_date,
  fornecedor_id uuid references public.fornecedores(id),
  documento     text,
  valor_total   numeric not null default 0,
  status        text not null default 'ativa' check (status in ('ativa','estornada')),
  obs           text,
  criado_por    uuid default auth.uid(),
  criado_em     timestamptz not null default now()
);

create table public.producoes (
  id               uuid primary key default gen_random_uuid(),
  unidade_id       uuid not null references public.unidades(id),
  data             date not null default current_date,
  receitas         numeric not null check (receitas > 0),
  potes_esperados  numeric not null,
  potes_produzidos numeric not null,
  rendimento       numeric generated always as (case when potes_esperados > 0 then potes_produzidos / potes_esperados end) stored,
  obs              text,
  criado_por       uuid default auth.uid(),
  criado_em        timestamptz not null default now()
);

create table public.producao_itens (
  id          uuid primary key default gen_random_uuid(),
  producao_id uuid not null references public.producoes(id) on delete cascade,
  produto_id  uuid not null references public.produtos(id),
  quantidade  numeric not null check (quantidade > 0),
  validade    date
);

create table public.reservas (
  id           uuid primary key default gen_random_uuid(),
  unidade_id   uuid not null references public.unidades(id),
  cliente      text not null,
  telefone     text,
  data_entrega date not null,
  hora         text,
  sinal        numeric not null default 0,
  status       text not null default 'pendente' check (status in ('pendente','confirmada','entregue','cancelada')),
  obs          text,
  venda_id     uuid,
  criado_por   uuid default auth.uid(),
  criado_em    timestamptz not null default now()
);

create table public.reserva_itens (
  id         uuid primary key default gen_random_uuid(),
  reserva_id uuid not null references public.reservas(id) on delete cascade,
  produto_id uuid not null references public.produtos(id),
  quantidade numeric not null check (quantidade > 0)
);

create table public.vendas (
  id         uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references public.unidades(id),
  data       date not null default current_date,
  cliente    text,
  canal      text,
  pagamento  text,
  desconto   numeric not null default 0,
  total      numeric not null default 0,
  status     text not null default 'ativa' check (status in ('ativa','cancelada')),
  reserva_id uuid references public.reservas(id),
  obs        text,
  criado_por uuid default auth.uid(),
  criado_em  timestamptz not null default now()
);

create table public.venda_itens (
  id             uuid primary key default gen_random_uuid(),
  venda_id       uuid not null references public.vendas(id) on delete cascade,
  produto_id     uuid not null references public.produtos(id),
  quantidade     numeric not null check (quantidade > 0),
  preco_unitario numeric not null default 0,
  custo_unitario numeric not null default 0     -- custo da ficha técnica no momento da venda
);

create table public.transferencias (
  id          uuid primary key default gen_random_uuid(),
  origem_id   uuid not null references public.unidades(id),
  destino_id  uuid not null references public.unidades(id),
  data        date not null default current_date,
  obs         text,
  criado_por  uuid default auth.uid(),
  criado_em   timestamptz not null default now(),
  check (origem_id <> destino_id)
);

create table public.transferencia_itens (
  id               uuid primary key default gen_random_uuid(),
  transferencia_id uuid not null references public.transferencias(id) on delete cascade,
  insumo_id        uuid references public.insumos(id),
  produto_id       uuid references public.produtos(id),
  quantidade       numeric not null check (quantidade > 0),
  check (num_nonnulls(insumo_id, produto_id) = 1)
);

-- ---------------------------------------------------------------------
-- 6. CONTAGEM SEMANAL E CMV REAL
-- ---------------------------------------------------------------------
create table public.contagens (
  id                    uuid primary key default gen_random_uuid(),
  unidade_id            uuid not null references public.unidades(id),
  data                  date not null default current_date,
  status                text not null default 'aberta' check (status in ('aberta','fechada')),
  periodo_inicio        date,
  estoque_inicial_valor numeric,
  compras_valor         numeric,
  estoque_final_valor   numeric,
  cmv_valor             numeric,
  faturamento           numeric,
  cmv_percentual        numeric,
  obs                   text,
  criado_por            uuid default auth.uid(),
  criado_em             timestamptz not null default now(),
  fechado_em            timestamptz
);

create table public.contagem_itens (
  id                 uuid primary key default gen_random_uuid(),
  contagem_id        uuid not null references public.contagens(id) on delete cascade,
  insumo_id          uuid references public.insumos(id),
  produto_id         uuid references public.produtos(id),
  quantidade_sistema numeric not null default 0,
  quantidade_contada numeric,
  custo_unitario     numeric not null default 0,
  check (num_nonnulls(insumo_id, produto_id) = 1)
);

-- ---------------------------------------------------------------------
-- 7. FUNÇÕES DE OPERAÇÃO (RPC) — tudo numa transação só
-- ---------------------------------------------------------------------
create or replace function public.exigir_acesso(p_unidade uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.tem_acesso(p_unidade) then
    raise exception 'Sem acesso a esta unidade.' using errcode = '42501';
  end if;
end $$;

-- ENTRADA DE PRODUTOS (compras)
-- p = {unidade_id, data, fornecedor_id, documento, obs,
--      itens: [{insumo_id, quantidade (g/ml/un), valor_total, validade}]}
create or replace function public.rpc_registrar_entrada(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_un uuid := (p->>'unidade_id')::uuid; v_data date := coalesce((p->>'data')::date, current_date);
        it jsonb; v_q numeric; v_v numeric; v_total numeric := 0;
begin
  perform exigir_acesso(v_un);
  if jsonb_array_length(coalesce(p->'itens','[]'::jsonb)) = 0 then raise exception 'Inclua ao menos um item.'; end if;
  insert into entradas (unidade_id, data, fornecedor_id, documento, obs)
  values (v_un, v_data, nullif(p->>'fornecedor_id','')::uuid, p->>'documento', p->>'obs') returning id into v_id;
  for it in select * from jsonb_array_elements(p->'itens') loop
    v_q := (it->>'quantidade')::numeric; v_v := coalesce((it->>'valor_total')::numeric, 0);
    if v_q is null or v_q <= 0 then raise exception 'Quantidade inválida.'; end if;
    insert into movimentos (unidade_id, data, tipo, insumo_id, quantidade, custo_unitario, fornecedor_id, validade, documento_id, obs)
    values (v_un, v_data, 'entrada', (it->>'insumo_id')::uuid, v_q, v_v / v_q,
            nullif(p->>'fornecedor_id','')::uuid, nullif(it->>'validade','')::date, v_id, p->>'documento');
    v_total := v_total + v_v;
  end loop;
  update entradas set valor_total = v_total where id = v_id;
  return v_id;
end $$;

create or replace function public.rpc_estornar_entrada(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e entradas; m movimentos;
begin
  select * into e from entradas where id = p_id;
  if not found then raise exception 'Entrada não encontrada.'; end if;
  perform exigir_acesso(e.unidade_id);
  if not eh_gestor() then raise exception 'Apenas gestores podem estornar.'; end if;
  if e.status = 'estornada' then return; end if;
  for m in select * from movimentos where documento_id = p_id and tipo = 'entrada' loop
    insert into movimentos (unidade_id, data, tipo, insumo_id, quantidade, custo_unitario, documento_id, obs)
    values (m.unidade_id, current_date, 'estorno', m.insumo_id, -m.quantidade, m.custo_unitario, p_id, 'Estorno de entrada');
  end loop;
  update entradas set status = 'estornada' where id = p_id;
end $$;

-- PRODUÇÃO: p = {unidade_id, data, receitas, obs, itens: [{produto_id, quantidade, validade}]}
-- baixa os insumos pela ficha técnica e dá entrada nos potes prontos
create or replace function public.rpc_registrar_producao(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_un uuid := (p->>'unidade_id')::uuid; v_data date := coalesce((p->>'data')::date, current_date);
        v_rec numeric := (p->>'receitas')::numeric; v_padrao numeric; v_potes numeric := 0; it jsonb; ex record;
begin
  perform exigir_acesso(v_un);
  if v_rec is null or v_rec <= 0 then raise exception 'Informe quantas receitas foram feitas.'; end if;
  select coalesce((valor)::text::numeric, 8) into v_padrao from config where chave = 'potes_por_receita';
  v_padrao := coalesce(v_padrao, 8);
  select coalesce(sum((x->>'quantidade')::numeric),0) into v_potes from jsonb_array_elements(p->'itens') x;
  if v_potes <= 0 then raise exception 'Informe os potes produzidos.'; end if;
  insert into producoes (unidade_id, data, receitas, potes_esperados, potes_produzidos, obs)
  values (v_un, v_data, v_rec, v_rec * v_padrao, v_potes, p->>'obs') returning id into v_id;
  for it in select * from jsonb_array_elements(p->'itens') loop
    if coalesce((it->>'quantidade')::numeric,0) <= 0 then continue; end if;
    insert into producao_itens (producao_id, produto_id, quantidade, validade)
    values (v_id, (it->>'produto_id')::uuid, (it->>'quantidade')::numeric, nullif(it->>'validade','')::date);
    insert into movimentos (unidade_id, data, tipo, produto_id, quantidade, custo_unitario, documento_id, validade)
    values (v_un, v_data, 'producao', (it->>'produto_id')::uuid, (it->>'quantidade')::numeric,
            custo_produto((it->>'produto_id')::uuid, v_un), v_id, nullif(it->>'validade','')::date);
    for ex in select * from explodir_produto((it->>'produto_id')::uuid, (it->>'quantidade')::numeric) loop
      insert into movimentos (unidade_id, data, tipo, insumo_id, quantidade, custo_unitario, documento_id)
      values (v_un, v_data, 'consumo_producao', ex.insumo_id, -ex.quantidade, custo_insumo(ex.insumo_id, v_un), v_id);
    end loop;
  end loop;
  return v_id;
end $$;

-- VENDA: p = {unidade_id, data, cliente, canal, pagamento, desconto, reserva_id, obs,
--             itens: [{produto_id, quantidade, preco_unitario}]}
create or replace function public.rpc_registrar_venda(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_un uuid := (p->>'unidade_id')::uuid; v_data date := coalesce((p->>'data')::date, current_date);
        it jsonb; v_custo numeric; v_total numeric := 0; v_desc numeric := coalesce((p->>'desconto')::numeric, 0);
        v_res uuid := nullif(p->>'reserva_id','')::uuid;
begin
  perform exigir_acesso(v_un);
  if jsonb_array_length(coalesce(p->'itens','[]'::jsonb)) = 0 then raise exception 'Inclua ao menos um sabor.'; end if;
  insert into vendas (unidade_id, data, cliente, canal, pagamento, desconto, reserva_id, obs)
  values (v_un, v_data, p->>'cliente', p->>'canal', p->>'pagamento', v_desc, v_res, p->>'obs') returning id into v_id;
  for it in select * from jsonb_array_elements(p->'itens') loop
    v_custo := custo_produto((it->>'produto_id')::uuid, v_un);
    insert into venda_itens (venda_id, produto_id, quantidade, preco_unitario, custo_unitario)
    values (v_id, (it->>'produto_id')::uuid, (it->>'quantidade')::numeric, coalesce((it->>'preco_unitario')::numeric,0), v_custo);
    insert into movimentos (unidade_id, data, tipo, produto_id, quantidade, custo_unitario, documento_id)
    values (v_un, v_data, 'venda', (it->>'produto_id')::uuid, -(it->>'quantidade')::numeric, v_custo, v_id);
    v_total := v_total + (it->>'quantidade')::numeric * coalesce((it->>'preco_unitario')::numeric,0);
  end loop;
  update vendas set total = greatest(v_total - v_desc, 0) where id = v_id;
  if v_res is not null then
    update reservas set status = 'entregue', venda_id = v_id where id = v_res and unidade_id = v_un;
  end if;
  return v_id;
end $$;

create or replace function public.rpc_cancelar_venda(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v vendas; m movimentos;
begin
  select * into v from vendas where id = p_id;
  if not found then raise exception 'Venda não encontrada.'; end if;
  perform exigir_acesso(v.unidade_id);
  if v.status = 'cancelada' then return; end if;
  for m in select * from movimentos where documento_id = p_id and tipo = 'venda' loop
    insert into movimentos (unidade_id, data, tipo, produto_id, quantidade, custo_unitario, documento_id, obs)
    values (m.unidade_id, current_date, 'estorno', m.produto_id, -m.quantidade, m.custo_unitario, p_id, 'Venda cancelada');
  end loop;
  update vendas set status = 'cancelada' where id = p_id;
  if v.reserva_id is not null then update reservas set status = 'confirmada', venda_id = null where id = v.reserva_id; end if;
end $$;

-- RESERVA (cria ou edita): p = {id?, unidade_id, cliente, telefone, data_entrega, hora, sinal, status, obs,
--                               itens: [{produto_id, quantidade}]}
create or replace function public.rpc_salvar_reserva(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id','')::uuid; v_un uuid := (p->>'unidade_id')::uuid; it jsonb;
begin
  perform exigir_acesso(v_un);
  if coalesce(trim(p->>'cliente'),'') = '' then raise exception 'Informe o nome do cliente.'; end if;
  if v_id is null then
    insert into reservas (unidade_id, cliente, telefone, data_entrega, hora, sinal, status, obs)
    values (v_un, p->>'cliente', p->>'telefone', (p->>'data_entrega')::date, p->>'hora',
            coalesce((p->>'sinal')::numeric,0), coalesce(nullif(p->>'status',''),'pendente'), p->>'obs')
    returning id into v_id;
  else
    update reservas set cliente = p->>'cliente', telefone = p->>'telefone', data_entrega = (p->>'data_entrega')::date,
           hora = p->>'hora', sinal = coalesce((p->>'sinal')::numeric,0),
           status = coalesce(nullif(p->>'status',''), status), obs = p->>'obs'
     where id = v_id and unidade_id = v_un;
    delete from reserva_itens where reserva_id = v_id;
  end if;
  for it in select * from jsonb_array_elements(coalesce(p->'itens','[]'::jsonb)) loop
    if coalesce((it->>'quantidade')::numeric,0) > 0 then
      insert into reserva_itens (reserva_id, produto_id, quantidade)
      values (v_id, (it->>'produto_id')::uuid, (it->>'quantidade')::numeric);
    end if;
  end loop;
  return v_id;
end $$;

-- TRANSFERÊNCIA ENTRE UNIDADES: p = {origem_id, destino_id, data, obs, itens: [{insumo_id|produto_id, quantidade}]}
create or replace function public.rpc_transferir(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_o uuid := (p->>'origem_id')::uuid; v_d uuid := (p->>'destino_id')::uuid;
        v_data date := coalesce((p->>'data')::date, current_date); it jsonb; v_q numeric; v_c numeric;
        v_ins uuid; v_prod uuid;
begin
  perform exigir_acesso(v_o); perform exigir_acesso(v_d);
  if v_o = v_d then raise exception 'Origem e destino precisam ser diferentes.'; end if;
  insert into transferencias (origem_id, destino_id, data, obs) values (v_o, v_d, v_data, p->>'obs') returning id into v_id;
  for it in select * from jsonb_array_elements(coalesce(p->'itens','[]'::jsonb)) loop
    v_q := (it->>'quantidade')::numeric;
    if coalesce(v_q,0) <= 0 then continue; end if;
    v_ins := nullif(it->>'insumo_id','')::uuid; v_prod := nullif(it->>'produto_id','')::uuid;
    v_c := case when v_ins is not null then custo_insumo(v_ins, v_o) else custo_produto(v_prod, v_o) end;
    insert into transferencia_itens (transferencia_id, insumo_id, produto_id, quantidade) values (v_id, v_ins, v_prod, v_q);
    insert into movimentos (unidade_id, data, tipo, insumo_id, produto_id, quantidade, custo_unitario, documento_id, obs)
    values (v_o, v_data, 'transferencia_saida', v_ins, v_prod, -v_q, v_c, v_id, p->>'obs'),
           (v_d, v_data, 'transferencia_entrada', v_ins, v_prod, v_q, v_c, v_id, p->>'obs');
  end loop;
  return v_id;
end $$;

-- PERDA (vencido, quebrado, sem refrigeração): p = {unidade_id, data, insumo_id|produto_id, quantidade, obs}
create or replace function public.rpc_registrar_perda(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_un uuid := (p->>'unidade_id')::uuid; v_ins uuid := nullif(p->>'insumo_id','')::uuid;
        v_prod uuid := nullif(p->>'produto_id','')::uuid; v_q numeric := (p->>'quantidade')::numeric;
begin
  perform exigir_acesso(v_un);
  if coalesce(v_q,0) <= 0 then raise exception 'Quantidade inválida.'; end if;
  insert into movimentos (unidade_id, data, tipo, insumo_id, produto_id, quantidade, custo_unitario, obs)
  values (v_un, coalesce((p->>'data')::date, current_date), 'perda', v_ins, v_prod, -v_q,
          case when v_ins is not null then custo_insumo(v_ins, v_un) else custo_produto(v_prod, v_un) end, p->>'obs')
  returning id into v_id;
  return v_id;
end $$;

-- CONTAGEM: abre com a foto do estoque do sistema
create or replace function public.rpc_abrir_contagem(p_unidade uuid, p_data date default current_date) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform exigir_acesso(p_unidade);
  select id into v_id from contagens where unidade_id = p_unidade and status = 'aberta' limit 1;
  if v_id is not null then return v_id; end if;
  insert into contagens (unidade_id, data) values (p_unidade, coalesce(p_data, current_date)) returning id into v_id;
  insert into contagem_itens (contagem_id, insumo_id, quantidade_sistema, custo_unitario)
  select v_id, i.id, coalesce(e.quantidade,0), custo_insumo(i.id, p_unidade)
    from insumos i left join estoque_insumos e on e.insumo_id = i.id and e.unidade_id = p_unidade
   where i.ativo;
  insert into contagem_itens (contagem_id, produto_id, quantidade_sistema, custo_unitario)
  select v_id, pr.id, coalesce(e.quantidade,0), custo_produto(pr.id, p_unidade)
    from produtos pr left join estoque_produtos e on e.produto_id = pr.id and e.unidade_id = p_unidade
   where pr.ativo;
  return v_id;
end $$;

-- CONTAGEM: fecha, lança os ajustes e calcula o CMV real do período
-- CMV = estoque inicial + compras (+ transferências recebidas − enviadas) − estoque final
create or replace function public.rpc_fechar_contagem(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c contagens; ant contagens; it contagem_itens; v_atual numeric; v_dif numeric;
        v_ini numeric; v_compras numeric; v_final numeric; v_fat numeric; v_cmv numeric; v_inicio date;
begin
  select * into c from contagens where id = p_id;
  if not found then raise exception 'Contagem não encontrada.'; end if;
  perform exigir_acesso(c.unidade_id);
  if c.status = 'fechada' then raise exception 'Esta contagem já foi fechada.'; end if;

  for it in select * from contagem_itens where contagem_id = p_id and quantidade_contada is not null loop
    if it.insumo_id is not null then
      select coalesce(quantidade,0) into v_atual from estoque_insumos where unidade_id = c.unidade_id and insumo_id = it.insumo_id;
    else
      select coalesce(quantidade,0) into v_atual from estoque_produtos where unidade_id = c.unidade_id and produto_id = it.produto_id;
    end if;
    v_dif := it.quantidade_contada - coalesce(v_atual, 0);
    if v_dif <> 0 then
      insert into movimentos (unidade_id, data, tipo, insumo_id, produto_id, quantidade, custo_unitario, documento_id, obs)
      values (c.unidade_id, c.data, 'ajuste_contagem', it.insumo_id, it.produto_id, v_dif, it.custo_unitario, p_id, 'Contagem semanal');
    end if;
  end loop;

  select * into ant from contagens where unidade_id = c.unidade_id and status = 'fechada' and data < c.data
   order by data desc, fechado_em desc limit 1;
  v_inicio := coalesce(ant.data, (select min(data) - 1 from movimentos where unidade_id = c.unidade_id), c.data - 7);
  v_ini := coalesce(ant.estoque_final_valor, 0);
  select coalesce(sum(valor),0) into v_compras from movimentos
   where unidade_id = c.unidade_id and data > v_inicio and data <= c.data
     and (tipo in ('entrada','transferencia_entrada','transferencia_saida')
          or (tipo = 'estorno' and insumo_id is not null));
  select coalesce(sum(coalesce(quantidade_contada, greatest(quantidade_sistema,0)) * custo_unitario),0) into v_final
    from contagem_itens where contagem_id = p_id;
  select coalesce(sum(total),0) into v_fat from vendas
   where unidade_id = c.unidade_id and status = 'ativa' and data > v_inicio and data <= c.data;
  -- a 1ª contagem só fixa o estoque inicial: sem contagem anterior não há CMV real
  v_cmv := case when ant.id is null then null else v_ini + v_compras - v_final end;

  update contagens set status = 'fechada', fechado_em = now(), periodo_inicio = v_inicio + 1,
         estoque_inicial_valor = v_ini, compras_valor = v_compras, estoque_final_valor = v_final,
         cmv_valor = v_cmv, faturamento = v_fat,
         cmv_percentual = case when v_fat > 0 and v_cmv is not null then v_cmv / v_fat end
   where id = p_id;
  return jsonb_build_object('estoque_inicial', v_ini, 'compras', v_compras, 'estoque_final', v_final,
                            'cmv', v_cmv, 'faturamento', v_fat,
                            'cmv_percentual', case when v_fat > 0 and v_cmv is not null then v_cmv / v_fat end);
end $$;

-- PAINEL da unidade num período
create or replace function public.rpc_painel(p_unidade uuid, p_de date, p_ate date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  perform exigir_acesso(p_unidade);
  select jsonb_build_object(
    'faturamento', coalesce((select sum(total) from vendas where unidade_id = p_unidade and status='ativa' and data between p_de and p_ate),0),
    'num_vendas',  (select count(*) from vendas where unidade_id = p_unidade and status='ativa' and data between p_de and p_ate),
    'potes',       coalesce((select sum(vi.quantidade) from venda_itens vi join vendas v on v.id = vi.venda_id
                             where v.unidade_id = p_unidade and v.status='ativa' and v.data between p_de and p_ate),0),
    'custo_vendido', coalesce((select sum(vi.quantidade * vi.custo_unitario) from venda_itens vi join vendas v on v.id = vi.venda_id
                             where v.unidade_id = p_unidade and v.status='ativa' and v.data between p_de and p_ate),0),
    'por_dia', coalesce((select jsonb_agg(jsonb_build_object('data', d, 'total', t) order by d) from (
                 select data d, sum(total) t from vendas where unidade_id = p_unidade and status='ativa'
                  and data between p_de and p_ate group by data) x), '[]'),
    'top', coalesce((select jsonb_agg(jsonb_build_object('nome', nome, 'qtd', q, 'total', t) order by q desc) from (
                 select pr.nome, sum(vi.quantidade) q, sum(vi.quantidade * vi.preco_unitario) t
                   from venda_itens vi join vendas v on v.id = vi.venda_id join produtos pr on pr.id = vi.produto_id
                  where v.unidade_id = p_unidade and v.status='ativa' and v.data between p_de and p_ate
                  group by pr.nome) x), '[]'),
    'por_canal', coalesce((select jsonb_agg(jsonb_build_object('canal', c, 'total', t) order by t desc) from (
                 select coalesce(nullif(canal,''),'Outro') c, sum(total) t from vendas
                  where unidade_id = p_unidade and status='ativa' and data between p_de and p_ate group by 1) x), '[]'),
    'perdas', coalesce((select -sum(valor) from movimentos where unidade_id = p_unidade and tipo='perda' and data between p_de and p_ate),0),
    'rendimento_medio', (select sum(potes_produzidos) / nullif(sum(potes_esperados),0) from producoes
                          where unidade_id = p_unidade and data between p_de and p_ate),
    'producoes', (select count(*) from producoes where unidade_id = p_unidade and data between p_de and p_ate),
    'reservas_abertas', (select count(*) from reservas where unidade_id = p_unidade and status in ('pendente','confirmada')),
    'ultima_contagem', (select to_jsonb(c) from contagens c where unidade_id = p_unidade and status='fechada'
                          order by data desc, fechado_em desc limit 1)
  ) into r;
  return r;
end $$;

-- FICHAS TÉCNICAS (gestor): salva o cabeçalho e substitui os itens numa única transação
-- p = {id?, codigo, nome, linha, preco_venda, alergenos, montagem, ativo, itens?: [{insumo_id|preparo_id, quantidade}]}
create or replace function public.rpc_salvar_produto(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id','')::uuid; it jsonb;
begin
  if not eh_gestor() then raise exception 'Apenas gestores podem alterar fichas técnicas.'; end if;
  if coalesce(trim(p->>'nome'),'') = '' or coalesce(trim(p->>'codigo'),'') = '' then raise exception 'Informe código e nome.'; end if;
  if v_id is null then
    insert into produtos (codigo, nome, linha, preco_venda, alergenos, montagem, ativo)
    values (trim(p->>'codigo'), trim(p->>'nome'), coalesce(nullif(p->>'linha',''),'Comum'), coalesce((p->>'preco_venda')::numeric,0),
            p->>'alergenos', p->>'montagem', coalesce((p->>'ativo')::boolean, true))
    returning id into v_id;
  else
    update produtos set codigo = trim(p->>'codigo'), nome = trim(p->>'nome'), linha = coalesce(nullif(p->>'linha',''),'Comum'),
           preco_venda = coalesce((p->>'preco_venda')::numeric,0), alergenos = p->>'alergenos', montagem = p->>'montagem',
           ativo = coalesce((p->>'ativo')::boolean, true)
     where id = v_id;
  end if;
  if p ? 'itens' then
    delete from produto_itens where produto_id = v_id;
    for it in select * from jsonb_array_elements(coalesce(p->'itens','[]'::jsonb)) loop
      if coalesce((it->>'quantidade')::numeric,0) > 0 then
        insert into produto_itens (produto_id, insumo_id, preparo_id, quantidade)
        values (v_id, nullif(it->>'insumo_id','')::uuid, nullif(it->>'preparo_id','')::uuid, (it->>'quantidade')::numeric);
      end if;
    end loop;
  end if;
  return v_id;
end $$;

-- p = {id?, codigo, nome, rendimento, modo_preparo, ativo, itens?: [{insumo_id|sub_preparo_id, quantidade}]}
create or replace function public.rpc_salvar_preparo(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id','')::uuid; it jsonb;
begin
  if not eh_gestor() then raise exception 'Apenas gestores podem alterar fichas técnicas.'; end if;
  if coalesce((p->>'rendimento')::numeric,0) <= 0 then raise exception 'Informe o rendimento em gramas.'; end if;
  if v_id is null then
    insert into preparos (codigo, nome, rendimento, modo_preparo, ativo)
    values (trim(p->>'codigo'), trim(p->>'nome'), (p->>'rendimento')::numeric, p->>'modo_preparo', coalesce((p->>'ativo')::boolean, true))
    returning id into v_id;
  else
    update preparos set codigo = trim(p->>'codigo'), nome = trim(p->>'nome'), rendimento = (p->>'rendimento')::numeric,
           modo_preparo = p->>'modo_preparo', ativo = coalesce((p->>'ativo')::boolean, true)
     where id = v_id;
  end if;
  if p ? 'itens' then
    delete from preparo_itens where preparo_id = v_id;
    for it in select * from jsonb_array_elements(coalesce(p->'itens','[]'::jsonb)) loop
      if coalesce((it->>'quantidade')::numeric,0) > 0 then
        if nullif(it->>'sub_preparo_id','')::uuid = v_id then raise exception 'Um preparo não pode conter ele mesmo.'; end if;
        insert into preparo_itens (preparo_id, insumo_id, sub_preparo_id, quantidade)
        values (v_id, nullif(it->>'insumo_id','')::uuid, nullif(it->>'sub_preparo_id','')::uuid, (it->>'quantidade')::numeric);
      end if;
    end loop;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 8. SEGURANÇA (RLS)
-- ---------------------------------------------------------------------
alter table public.unidades            enable row level security;
alter table public.perfis              enable row level security;
alter table public.membros_unidade     enable row level security;
alter table public.config              enable row level security;
alter table public.fornecedores        enable row level security;
alter table public.insumos             enable row level security;
alter table public.preparos            enable row level security;
alter table public.preparo_itens       enable row level security;
alter table public.produtos            enable row level security;
alter table public.produto_itens       enable row level security;
alter table public.historico_precos    enable row level security;
alter table public.estoque_insumos     enable row level security;
alter table public.estoque_produtos    enable row level security;
alter table public.movimentos          enable row level security;
alter table public.entradas            enable row level security;
alter table public.producoes           enable row level security;
alter table public.producao_itens      enable row level security;
alter table public.reservas            enable row level security;
alter table public.reserva_itens       enable row level security;
alter table public.vendas              enable row level security;
alter table public.venda_itens         enable row level security;
alter table public.transferencias      enable row level security;
alter table public.transferencia_itens enable row level security;
alter table public.contagens           enable row level security;
alter table public.contagem_itens      enable row level security;

-- unidades: vê as suas; gestor edita
create policy unidades_sel on public.unidades for select to authenticated using (public.tem_acesso(id));
create policy unidades_ges on public.unidades for all to authenticated using (public.eh_gestor()) with check (public.eh_gestor());

-- perfis: cada um vê o seu; gestor vê e edita todos
create policy perfis_sel on public.perfis for select to authenticated using (id = auth.uid() or public.eh_gestor());
create policy perfis_upd on public.perfis for update to authenticated using (public.eh_gestor()) with check (public.eh_gestor());
create policy membros_sel on public.membros_unidade for select to authenticated using (user_id = auth.uid() or public.eh_gestor());
create policy membros_ges on public.membros_unidade for all to authenticated using (public.eh_gestor()) with check (public.eh_gestor());

-- cadastros: todos liberados leem; gestor altera
do $$
declare t text;
begin
  foreach t in array array['config','fornecedores','insumos','preparos','preparo_itens','produtos','produto_itens','historico_precos'] loop
    execute format('create policy %1$s_sel on public.%1$s for select to authenticated using (public.usuario_liberado())', t);
    execute format('create policy %1$s_ges on public.%1$s for all to authenticated using (public.eh_gestor()) with check (public.eh_gestor())', t);
  end loop;
end $$;
-- fornecedores também podem ser cadastrados por operadores (na hora da entrada)
create policy fornecedores_ins on public.fornecedores for insert to authenticated with check (public.usuario_liberado());

-- tabelas por unidade: leitura pela unidade; escrita só pelas funções (RPC)
do $$
declare t text;
begin
  foreach t in array array['estoque_insumos','estoque_produtos','movimentos','entradas','producoes','reservas','vendas','contagens'] loop
    execute format('create policy %1$s_sel on public.%1$s for select to authenticated using (public.tem_acesso(unidade_id))', t);
  end loop;
end $$;
create policy reservas_upd on public.reservas for update to authenticated
  using (public.tem_acesso(unidade_id)) with check (public.tem_acesso(unidade_id));
create policy contagens_upd on public.contagens for update to authenticated
  using (public.tem_acesso(unidade_id) and status = 'aberta') with check (public.tem_acesso(unidade_id));
create policy contagens_del on public.contagens for delete to authenticated
  using (public.eh_gestor() and status = 'aberta');

create policy producao_itens_sel on public.producao_itens for select to authenticated
  using (exists (select 1 from public.producoes x where x.id = producao_id and public.tem_acesso(x.unidade_id)));
create policy reserva_itens_sel on public.reserva_itens for select to authenticated
  using (exists (select 1 from public.reservas x where x.id = reserva_id and public.tem_acesso(x.unidade_id)));
create policy venda_itens_sel on public.venda_itens for select to authenticated
  using (exists (select 1 from public.vendas x where x.id = venda_id and public.tem_acesso(x.unidade_id)));
create policy transferencias_sel on public.transferencias for select to authenticated
  using (public.tem_acesso(origem_id) or public.tem_acesso(destino_id));
create policy transferencia_itens_sel on public.transferencia_itens for select to authenticated
  using (exists (select 1 from public.transferencias x where x.id = transferencia_id
                 and (public.tem_acesso(x.origem_id) or public.tem_acesso(x.destino_id))));
create policy contagem_itens_sel on public.contagem_itens for select to authenticated
  using (exists (select 1 from public.contagens x where x.id = contagem_id and public.tem_acesso(x.unidade_id)));
create policy contagem_itens_upd on public.contagem_itens for update to authenticated
  using (exists (select 1 from public.contagens x where x.id = contagem_id and x.status = 'aberta' and public.tem_acesso(x.unidade_id)))
  with check (exists (select 1 from public.contagens x where x.id = contagem_id and x.status = 'aberta' and public.tem_acesso(x.unidade_id)));

-- funções: só usuários logados
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;

-- ---------------------------------------------------------------------
-- 9. DADOS INICIAIS
-- ---------------------------------------------------------------------
insert into public.unidades (slug, nome, cidade, responsavel) values
  ('cachoeiro',      'GoodCake - Cachoeiro de Itapemirim', 'Cachoeiro de Itapemirim', 'Analanda'),
  ('grande-vitoria', 'GoodCake - Grande Vitória',          'Serra / Grande Vitória',  'Vinicius');

insert into public.config (chave, valor) values
  ('potes_por_receita', '8'),
  ('meta_cmv', '0.35'),
  ('dia_contagem', '6');

-- insumos com o custo da 1ª compra (R$ por g / ml / un)
insert into public.insumos (nome, categoria, unidade, embalagem_padrao, custo_referencia, estoque_minimo, marca_indicada) values
  ('Ovo',                          'Ingrediente', 'un',   30, 11.99/30,   6,   'Ovo grande, sempre o mesmo tamanho'),
  ('Açúcar refinado',              'Ingrediente', 'g',  1000, 5.00/1000,  500, 'União, Caravelas ou Guarani'),
  ('Farinha de trigo',             'Ingrediente', 'g',  1000, 3.77/1000,  500, 'Tipo 1, sem fermento'),
  ('Fermento químico em pó',       'Ingrediente', 'g',   100, 5.69/100,   20,  'Royal ou Dr. Oetker'),
  ('Leite condensado',             'Ingrediente', 'g',   395, 5.89/395,   790, 'Italac, Piracanjuba ou Itambé (não mistura láctea)'),
  ('Creme de leite',               'Ingrediente', 'g',   200, 2.19/200,   800, 'Creme de leite de verdade, não "culinário"'),
  ('Leite em pó Ninho',            'Ingrediente', 'g',   350, 21.99/350,  100, 'Ninho integral (não composto lácteo)'),
  ('Chocolate branco',             'Ingrediente', 'g',    80, 5.98/80,    100, 'Barra de chocolate, não cobertura'),
  ('Chocolate ao leite',           'Ingrediente', 'g',  1000, 64.99/1000, 100, 'Barra de chocolate, não cobertura'),
  ('Chocolate em pó 50%',          'Ingrediente', 'g',  1000, 54.00/1000, 50,  'Solúvel 50% cacau'),
  ('Biscoito Oreo',                'Ingrediente', 'g',    90, 5.00/90,    90,  'Oreo original'),
  ('Nutella',                      'Ingrediente', 'g',   350, 30.00/350,  100, 'Nutella'),
  ('Amendoim/avelã triturado',     'Ingrediente', 'g',   500, 12.00/500,  50,  null),
  ('Morango',                      'Ingrediente', 'g',   250, 8.00/250,   0,   'Fresco, firme e vermelho'),
  ('Maçã',                         'Ingrediente', 'un',    1, 1.50,       0,   'Gala ou Fuji'),
  ('Pote 220 ml com lacre',        'Embalagem',   'un',  200, 198.55/200, 20,  'Mesmo modelo nas duas unidades'),
  ('Colher descartável',           'Embalagem',   'un',  100, 6.90/100,   20,  null),
  ('Etiqueta Good Cake',           'Embalagem',   'un',   15, 0.10,       15,  'Etiqueta única 5 cm');

-- preparos (receita padrão = 8 potes de 220 ml)
insert into public.preparos (codigo, nome, rendimento, modo_preparo) values
  ('PB-01','Massa pão de ló',   600,  'Forno pré-aquecido a 180 °C. Bater ovos e açúcar 8–10 min, juntar a água, incorporar a farinha peneirada e por último o fermento. Assar 25–30 min em forma 20x30. Esfriar e esfarelar.'),
  ('PB-02','Recheio base',      1246, '2 leites condensados + 4 cremes de leite em fogo médio-baixo, mexendo, 12–15 min até cobrir a colher. Rendimento medido: 1.246 g.'),
  ('PB-03','Creme Ninho',       1426, 'Recheio base quente + chocolate branco picado + Ninho peneirado. Gelar no mínimo 3 h.'),
  ('PB-04','Creme Chocolate',   1406, 'Recheio base quente + chocolate ao leite picado + chocolate em pó. Gelar no mínimo 3 h.'),
  ('PB-05','Geleia de morango', 400,  '500 g morango + 150 g açúcar + ½ maçã ralada. Fogo baixo 20–30 min até o ponto do pires.');

insert into public.preparo_itens (preparo_id, insumo_id, sub_preparo_id, quantidade)
select pr.id, i.id, sp.id, x.q
from (values
  ('PB-01','Ovo',null,3), ('PB-01','Açúcar refinado',null,200), ('PB-01','Farinha de trigo',null,180), ('PB-01','Fermento químico em pó',null,8),
  ('PB-02','Leite condensado',null,790), ('PB-02','Creme de leite',null,800),
  ('PB-03',null,'PB-02',1246), ('PB-03','Leite em pó Ninho',null,80), ('PB-03','Chocolate branco',null,100),
  ('PB-04',null,'PB-02',1246), ('PB-04','Chocolate em pó 50%',null,60), ('PB-04','Chocolate ao leite',null,100),
  ('PB-05','Morango',null,500), ('PB-05','Açúcar refinado',null,150), ('PB-05','Maçã',null,0.5)
) as x(prep, ins, sub, q)
join public.preparos pr on pr.codigo = x.prep
left join public.insumos i on i.nome = x.ins
left join public.preparos sp on sp.codigo = x.sub;

-- produtos (pote 220 ml). Cada pote = 1/8 da receita padrão.
insert into public.produtos (codigo, nome, linha, preco_venda, alergenos, montagem) values
  ('BP-01','Ninho com Morango','Premium',14,'Contém leite, ovo e glúten.','3 camadas: massa esfarelada / creme Ninho / geleia. Geleia no topo.'),
  ('BP-02','ChocoNinho',       'Comum',  12,'Contém leite, ovo e glúten.','3 camadas: massa / creme chocolate / massa / creme Ninho.'),
  ('BP-03','Chocomousse',      'Comum',  12,'Contém leite, ovo e glúten.','3 camadas: massa / creme chocolate. Chocolate em pó no topo.'),
  ('BP-04','Duo Ninho',        'Comum',  12,'Contém leite, ovo e glúten.','3 camadas: massa / creme Ninho. Ninho polvilhado no topo.'),
  ('BP-05','Ninho com Nutella','Premium',14,'Contém leite, ovo, glúten, soja e avelã.','3 camadas: massa / creme Ninho / fio de Nutella. Nutella no topo.'),
  ('BP-06','Ninho com Oreo',   'Premium',14,'Contém leite, ovo, glúten e soja.','3 camadas: massa / creme Ninho / Oreo triturado. Oreo no topo.'),
  ('BP-07','Crocante de Avelã','Premium',14,'Contém leite, ovo, glúten, soja, avelã e amendoim.','3 camadas: massa / creme chocolate / Nutella. Crocante no topo.');

insert into public.produto_itens (produto_id, insumo_id, preparo_id, quantidade)
select p.id, i.id, pr.id, x.q
from (values
  ('BP-01',null,'PB-01',75), ('BP-01',null,'PB-03',178.25), ('BP-01',null,'PB-05',22),
  ('BP-02',null,'PB-01',75), ('BP-02',null,'PB-03',89.125), ('BP-02',null,'PB-04',87.875),
  ('BP-03',null,'PB-01',75), ('BP-03',null,'PB-04',175.75), ('BP-03','Chocolate em pó 50%',null,2),
  ('BP-04',null,'PB-01',75), ('BP-04',null,'PB-03',178.25), ('BP-04','Leite em pó Ninho',null,5),
  ('BP-05',null,'PB-01',75), ('BP-05',null,'PB-03',178.25), ('BP-05','Nutella',null,20),
  ('BP-06',null,'PB-01',75), ('BP-06',null,'PB-03',178.25), ('BP-06','Biscoito Oreo',null,13),
  ('BP-07',null,'PB-01',75), ('BP-07',null,'PB-04',175.75), ('BP-07','Nutella',null,20), ('BP-07','Amendoim/avelã triturado',null,10)
) as x(prod, ins, prep, q)
join public.produtos p on p.codigo = x.prod
left join public.insumos i on i.nome = x.ins
left join public.preparos pr on pr.codigo = x.prep;

-- embalagem em todos os potes
insert into public.produto_itens (produto_id, insumo_id, quantidade)
select p.id, i.id, 1 from public.produtos p
cross join public.insumos i where i.nome in ('Pote 220 ml com lacre','Colher descartável','Etiqueta Good Cake');
