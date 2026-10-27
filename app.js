/* Good Cake · Gestão
 * App de página única (sem build). Banco: Supabase (Postgres + RLS + funções RPC em schema.sql).
 * Toda movimentação de estoque passa pelas funções rpc_* do banco, que validam o acesso por unidade.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ conexão
  const CFG = window.GOODCAKE_CONFIG || {};
  const configurado = window.__SB_MOCK__ || (CFG.SUPABASE_URL && !/SEU-PROJETO/.test(CFG.SUPABASE_URL));
  const sb = window.__SB_MOCK__ || (configurado ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null);

  // ------------------------------------------------------------------ estado
  const S = {
    user: null, perfil: null, unidades: [], un: null,
    cat: { produtos: [], insumos: [], fornecedores: [], preparos: [], produtoItens: [], preparoItens: [], config: {} },
    estoqueIns: {},       // insumo_id -> {quantidade, custo_medio} da unidade atual
    charts: [], pendentes: 0, periodo: null,
  };

  // ------------------------------------------------------------------ utilidades
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = (v) => { const x = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v); return Number.isFinite(x) ? x : 0; };
  const fmt = (v, d = 0) => n(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtAuto = (v) => fmt(v, Math.abs(n(v) % 1) > 1e-9 ? (Math.abs(n(v) * 10 % 1) > 1e-9 ? 2 : 1) : 0);
  const brl = (v) => n(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const pct = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : fmt(n(v) * 100, d) + '%';
  const hoje = () => new Date().toLocaleDateString('sv-SE');
  const addDias = (d, k) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + k); return x.toLocaleDateString('sv-SE'); };
  const dataBR = (d) => d ? new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('pt-BR') : '—';
  const dataCurta = (d) => d ? new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '—';
  const diaSemana = (d) => new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long' });
  const inicioMes = (d = hoje()) => d.slice(0, 8) + '01';
  const fimMes = (d) => { const x = new Date(d.slice(0, 8) + '01T12:00:00'); x.setMonth(x.getMonth() + 1); x.setDate(0); return x.toLocaleDateString('sv-SE'); };
  const potesPorReceita = () => n(S.cat.config.potes_por_receita) || 8;
  const metaCmv = () => n(S.cat.config.meta_cmv) || 0.35;
  const ehGestor = () => S.perfil?.papel === 'gestor';
  const unAtual = () => S.unidades.find((u) => u.id === S.un);
  const nomeCurto = (u) => (u?.nome || '').replace(/^GoodCake\s*-\s*/i, '');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
  };

  function proximaContagem() {
    const dia = n(S.cat.config.dia_contagem ?? 6);
    const d = new Date(hoje() + 'T12:00:00');
    const k = (dia - d.getDay() + 7) % 7;
    return addDias(hoje(), k);
  }

  const UNID = { g: 'g', ml: 'ml', un: 'un' };
  function qtdFmt(v, u) {
    v = n(v);
    if (u === 'g' && Math.abs(v) >= 1000) return fmt(v / 1000, 2) + ' kg';
    if (u === 'ml' && Math.abs(v) >= 1000) return fmt(v / 1000, 2) + ' L';
    return fmtAuto(v) + ' ' + (UNID[u] || u || '');
  }
  function custoUnFmt(c, u) {
    if (u === 'g') return brl(n(c) * 1000) + '/kg';
    if (u === 'ml') return brl(n(c) * 1000) + '/L';
    return brl(c) + '/' + (u || 'un');
  }

  // ------------------------------------------------------------------ ícones (traço simples)
  const ICONES = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    venda: '<path d="M6 7h12l-1 13H7L6 7z"/><path d="M9 7a3 3 0 016 0"/>',
    reserva: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M9 15l2 2 4-4"/>',
    producao: '<path d="M4 20h16"/><path d="M6 20V10h12v10"/><path d="M9 10V6a3 3 0 016 0v4"/>',
    contagem: '<path d="M9 5h10M9 12h10M9 19h10"/><path d="M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2"/>',
    estoque: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
    entrada: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>',
    transf: '<path d="M4 8h14l-3-3"/><path d="M20 16H6l3 3"/>',
    ficha: '<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M10 12h6M10 16h6"/>',
    cadastro: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"/>',
    usuarios: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0114 0"/><path d="M16 4.5a3.5 3.5 0 010 7M22 20a7 7 0 00-4-6.3"/>',
    mais: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    lixo: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    sair: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
    whats: '<path d="M4 20l1.3-3.9A8 8 0 1112 20a8 8 0 01-4.1-1.1L4 20z"/>',
    perda: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
    lapis: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  };
  const ic = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES[k] || ''}</svg>`;

  // ------------------------------------------------------------------ feedback
  function toast(msg, tipo = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + tipo; t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), tipo === 'erro' ? 6000 : 3200);
  }
  function msgErro(e) {
    const m = e?.message || String(e);
    if (/row-level security|permission denied/i.test(m)) return 'Você não tem permissão para isso.';
    if (/Invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
    if (/Email not confirmed/i.test(m)) return 'Confirme o e-mail pelo link que você recebeu e tente de novo.';
    if (/duplicate key/i.test(m)) return 'Já existe um cadastro com esse código ou nome.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Sem conexão com o servidor. Verifique a internet.';
    return m.replace(/^.*?ERROR:\s*/, '');
  }
  const falha = (e) => { console.error(e); toast(msgErro(e), 'erro'); };

  async function dados(qb) { const { data, error } = await qb; if (error) throw error; return data; }
  async function rpc(fn, args) { const { data, error } = await sb.rpc(fn, args); if (error) throw error; return data; }

  async function ocupado(btn, fn) {
    const txt = btn.innerHTML; btn.disabled = true; btn.innerHTML = 'Salvando…';
    try { return await fn(); } catch (e) { falha(e); return undefined; } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = txt; } }
  }

  // ------------------------------------------------------------------ modal
  function abrirModal({ titulo, corpo, rodape = '', classe = '' }) {
    const d = document.createElement('dialog');
    d.className = 'modal ' + classe;
    d.innerHTML = `<div class="modal-topo"><h2>${esc(titulo)}</h2><button type="button" class="icone-btn" data-fechar aria-label="Fechar">${ic('x')}</button></div>
      <div class="modal-corpo">${corpo}</div>${rodape ? `<div class="modal-rodape">${rodape}</div>` : ''}`;
    document.body.appendChild(d);
    d.showModal();
    d.addEventListener('click', (e) => { if (e.target.closest('[data-fechar]')) d.close(); });
    d.addEventListener('close', () => d.remove());
    d.fechar = () => d.close();
    d.$ = (s) => d.querySelector(s);
    d.$$ = (s) => [...d.querySelectorAll(s)];
    return d;
  }
  function confirmar(msg, { ok = 'Confirmar', perigo = false, titulo = 'Confirmar' } = {}) {
    return new Promise((res) => {
      const d = abrirModal({ titulo, classe: 'estreito', corpo: `<p style="margin:0">${msg}</p>`,
        rodape: `<button class="btn sec" data-fechar>Voltar</button><button class="btn ${perigo ? 'perigo' : ''}" data-ok>${esc(ok)}</button>` });
      let r = false;
      d.$('[data-ok]').onclick = () => { r = true; d.close(); };
      d.addEventListener('close', () => res(r));
    });
  }

  // ------------------------------------------------------------------ componentes
  const opcoes = (lista, sel, { vazio = null, rot = (x) => x.nome, val = (x) => x.id } = {}) =>
    (vazio !== null ? `<option value="">${esc(vazio)}</option>` : '') +
    lista.map((x) => `<option value="${esc(val(x))}" ${String(val(x)) === String(sel ?? '') ? 'selected' : ''}>${esc(rot(x))}</option>`).join('');

  const produtosAtivos = () => S.cat.produtos.filter((p) => p.ativo);
  const insumosAtivos = () => S.cat.insumos.filter((i) => i.ativo);
  const prodPorId = (id) => S.cat.produtos.find((p) => p.id === id);
  const insPorId = (id) => S.cat.insumos.find((i) => i.id === id);
  const prepPorId = (id) => S.cat.preparos.find((p) => p.id === id);
  const fornPorId = (id) => S.cat.fornecedores.find((f) => f.id === id);
  const nomeItem = (m) => m.produto_id ? (prodPorId(m.produto_id)?.nome || '?') : (insPorId(m.insumo_id)?.nome || '?');
  const resumoItens = (itens) => itens.map((i) => `${fmtAuto(i.quantidade)}× ${esc(prodPorId(i.produto_id)?.nome || '?')}`).join(', ') || '—';

  function selInsumoOpcoes(sel) {
    const cats = ['Ingrediente', 'Embalagem', 'Outros'];
    return '<option value="">Selecione…</option>' + cats.map((c) => {
      const l = insumosAtivos().filter((i) => i.categoria === c);
      return l.length ? `<optgroup label="${c}">${opcoes(l, sel)}</optgroup>` : '';
    }).join('');
  }

  // seletor de sabores com +/−
  function saboresUI(el, { qtds = {}, precos = false, estoque = null, onChange = null } = {}) {
    const prods = produtosAtivos();
    el.innerHTML = `<div class="sabores">${prods.map((p) => `
      <div class="sabor" data-id="${p.id}">
        <span class="ponto ${esc(p.linha)}"></span>
        <div class="info"><b title="${esc(p.nome)}">${esc(p.nome)}</b>
          <span>${precos ? brl(p.preco_venda) + ' · ' : ''}${estoque ? 'estoque ' + fmtAuto(estoque[p.id] || 0) : esc(p.linha)}</span></div>
        <div class="stepper"><button type="button" data-d="-1" aria-label="menos">−</button>
          <input type="number" min="0" step="1" inputmode="numeric" value="${qtds[p.id] || 0}" aria-label="${esc(p.nome)}">
          <button type="button" data-d="1" aria-label="mais">+</button></div>
      </div>`).join('') || '<div class="vazio">Cadastre os sabores em Fichas técnicas.</div>'}</div>`;
    const ler = () => {
      const o = {};
      $$('.sabor', el).forEach((s) => { const v = Math.max(0, n(s.querySelector('input').value)); s.classList.toggle('sel', v > 0); if (v > 0) o[s.dataset.id] = v; });
      return o;
    };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-d]'); if (!b) return;
      const inp = b.parentElement.querySelector('input');
      inp.value = Math.max(0, n(inp.value) + n(b.dataset.d));
      const o = ler(); onChange && onChange(o);
    });
    el.addEventListener('input', () => { const o = ler(); onChange && onChange(o); });
    ler();
    return ler;
  }

  function badgeStatus(s) {
    const m = { ativa: 'verde', cancelada: 'cinza', estornada: 'cinza', pendente: 'dourado', confirmada: 'rosa', entregue: 'verde', aberta: 'dourado', fechada: 'verde' };
    return `<span class="badge ${m[s] || ''}">${esc(s)}</span>`;
  }
  function badgeCmv(c) {
    if (c === null || c === undefined) return '<span class="badge cinza">—</span>';
    const meta = metaCmv();
    const cls = c <= meta ? 'verde' : c <= meta + 0.05 ? 'dourado' : 'vermelho';
    return `<span class="badge ${cls}">${pct(c)}</span>`;
  }
  function badgeRend(r) {
    if (r === null || r === undefined) return '<span class="badge cinza">—</span>';
    const cls = r >= 0.999 ? 'verde' : r >= 0.9 ? 'dourado' : 'vermelho';
    return `<span class="badge ${cls}">${pct(r, 0)}</span>`;
  }
  const TIPOS_MOV = {
    entrada: ['Entrada', 'verde'], producao: ['Produção', 'rosa'], consumo_producao: ['Consumo produção', 'cinza'],
    venda: ['Venda', 'cacau'], transferencia_saida: ['Transf. enviada', 'dourado'], transferencia_entrada: ['Transf. recebida', 'dourado'],
    ajuste_contagem: ['Ajuste contagem', 'rosa'], perda: ['Perda', 'vermelho'], estorno: ['Estorno', 'cinza'],
  };
  const badgeMov = (t) => `<span class="badge ${(TIPOS_MOV[t] || [])[1] || ''}">${esc((TIPOS_MOV[t] || [t])[0])}</span>`;

  const tabela = (cab, linhas, { vazio = 'Nada por aqui ainda.', rodape = '' } = {}) => `
    <div class="tabela-wrap"><table class="tabela"><thead><tr>${cab.map((c) => `<th class="${c.startsWith('#') ? 'num' : ''}">${esc(c.replace(/^#/, ''))}</th>`).join('')}</tr></thead>
    <tbody>${linhas.length ? linhas.join('') : `<tr><td colspan="${cab.length}" class="vazio">${esc(vazio)}</td></tr>`}</tbody>${rodape ? `<tfoot>${rodape}</tfoot>` : ''}</table></div>`;

  function seletorPeriodo(el, onMuda, inicial) {
    const p = inicial || { de: inicioMes(), ate: hoje() };
    el.innerHTML = `<div class="filtros">
      <select data-preset aria-label="Período"><option value="hoje">Hoje</option><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option>
        <option value="mes">Este mês</option><option value="mesant">Mês passado</option><option value="custom">Personalizado</option></select>
      <input type="date" data-de value="${p.de}" aria-label="De"><input type="date" data-ate value="${p.ate}" aria-label="Até"></div>`;
    const sel = $('[data-preset]', el), de = $('[data-de]', el), ate = $('[data-ate]', el);
    sel.value = p.preset || 'mes';
    const muda = () => { onMuda({ de: de.value, ate: ate.value, preset: sel.value }); };
    sel.onchange = () => {
      const h = hoje();
      if (sel.value === 'hoje') { de.value = h; ate.value = h; }
      if (sel.value === '7') { de.value = addDias(h, -6); ate.value = h; }
      if (sel.value === '30') { de.value = addDias(h, -29); ate.value = h; }
      if (sel.value === 'mes') { de.value = inicioMes(h); ate.value = h; }
      if (sel.value === 'mesant') { const a = addDias(inicioMes(h), -1); de.value = inicioMes(a); ate.value = fimMes(a); }
      muda();
    };
    de.onchange = ate.onchange = () => { sel.value = 'custom'; muda(); };
  }

  function wa(tel, texto = '') {
    let d = String(tel || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.length <= 11) d = '55' + d;
    return `https://wa.me/${d}${texto ? '?text=' + encodeURIComponent(texto) : ''}`;
  }

  // ------------------------------------------------------------------ carga de dados
  async function carregarCatalogo() {
    const [produtos, insumos, fornecedores, preparos, produtoItens, preparoItens, config] = await Promise.all([
      dados(sb.from('produtos').select('*').order('codigo')),
      dados(sb.from('insumos').select('*').order('nome')),
      dados(sb.from('fornecedores').select('*').order('nome')),
      dados(sb.from('preparos').select('*').order('codigo')),
      dados(sb.from('produto_itens').select('*')),
      dados(sb.from('preparo_itens').select('*')),
      dados(sb.from('config').select('*')),
    ]);
    const cfg = {};
    (config || []).forEach((c) => { cfg[c.chave] = typeof c.valor === 'string' ? JSON.parse(c.valor) : c.valor; });
    S.cat = { produtos, insumos, fornecedores, preparos, produtoItens, preparoItens, config: cfg };
  }
  async function carregarEstoqueIns() {
    const l = await dados(sb.from('estoque_insumos').select('*').eq('unidade_id', S.un));
    S.estoqueIns = {}; l.forEach((e) => { S.estoqueIns[e.insumo_id] = e; });
    return l;
  }
  async function estoqueProdutos(un = S.un) {
    const l = await dados(sb.from('estoque_produtos').select('*').eq('unidade_id', un));
    const o = {}; l.forEach((e) => { o[e.produto_id] = n(e.quantidade); }); return o;
  }

  // custos (mesma regra do banco: custo médio da unidade; sem estoque, último preço de compra)
  function custoInsumo(id) {
    const e = S.estoqueIns[id];
    if (e && n(e.quantidade) > 0 && n(e.custo_medio) > 0) return n(e.custo_medio);
    return n(insPorId(id)?.custo_referencia);
  }
  function custoPreparoG(id, nivel = 0) {
    if (nivel > 6) return 0;
    const pr = prepPorId(id); if (!pr || n(pr.rendimento) <= 0) return 0;
    const tot = S.cat.preparoItens.filter((i) => i.preparo_id === id)
      .reduce((s, i) => s + n(i.quantidade) * (i.insumo_id ? custoInsumo(i.insumo_id) : custoPreparoG(i.sub_preparo_id, nivel + 1)), 0);
    return tot / n(pr.rendimento);
  }
  const custoItemProduto = (i) => n(i.quantidade) * (i.insumo_id ? custoInsumo(i.insumo_id) : custoPreparoG(i.preparo_id));
  const custoProduto = (id) => S.cat.produtoItens.filter((i) => i.produto_id === id).reduce((s, i) => s + custoItemProduto(i), 0);

  // explode N potes em insumos (para prever o consumo de uma produção)
  function explodir(prodQtds) {
    const out = {};
    const addPrep = (pid, g, nivel) => {
      const pr = prepPorId(pid); if (!pr || nivel > 6) return;
      S.cat.preparoItens.filter((i) => i.preparo_id === pid).forEach((i) => {
        const q = g * n(i.quantidade) / n(pr.rendimento);
        if (i.insumo_id) out[i.insumo_id] = (out[i.insumo_id] || 0) + q; else addPrep(i.sub_preparo_id, q, nivel + 1);
      });
    };
    Object.entries(prodQtds).forEach(([pid, qtd]) => {
      S.cat.produtoItens.filter((i) => i.produto_id === pid).forEach((i) => {
        const q = n(i.quantidade) * qtd;
        if (i.insumo_id) out[i.insumo_id] = (out[i.insumo_id] || 0) + q; else addPrep(i.preparo_id, q, 1);
      });
    });
    return out;
  }

  // ------------------------------------------------------------------ autenticação
  function telaConfig() {
    $('#raiz').innerHTML = `<div class="auth"><div class="auth-card"><div class="faixas"><i></i><i></i><i></i></div><div class="corpo">
      <img class="logo" src="logo.png" alt="Good Cake">
      <h1>Falta conectar o banco</h1>
      <p class="sub">Abra o arquivo <b>config.js</b> e preencha a URL e a chave anon do projeto Supabase da Good Cake. O passo a passo está no README.</p>
    </div></div></div>`;
  }

  function telaAuth(modo = 'entrar', aviso = '') {
    const titulos = { entrar: ['Entrar', 'Gestão das unidades Good Cake'], criar: ['Criar acesso', 'Depois do cadastro, um gestor libera seu acesso'],
      esqueci: ['Recuperar senha', 'Enviaremos um link para o seu e-mail'], nova: ['Nova senha', 'Escolha uma senha nova'] };
    const [t, sub] = titulos[modo];
    $('#raiz').innerHTML = `<div class="auth"><div class="auth-card"><div class="faixas"><i></i><i></i><i></i></div><div class="corpo">
      <img class="logo" src="logo.png" alt="Good Cake">
      <h1>${t}</h1><p class="sub">${sub}</p>
      ${aviso ? `<div class="aviso verde small" style="margin-bottom:14px">${esc(aviso)}</div>` : ''}
      <form id="f-auth" autocomplete="on">
        ${modo === 'criar' ? '<div class="campo"><label for="a-nome">Seu nome</label><input id="a-nome" type="text" required autocomplete="name"></div>' : ''}
        ${modo !== 'nova' ? '<div class="campo"><label for="a-email">E-mail</label><input id="a-email" type="email" required autocomplete="email"></div>' : ''}
        ${modo !== 'esqueci' ? `<div class="campo"><label for="a-senha">Senha</label><input id="a-senha" type="password" required minlength="6" autocomplete="${modo === 'entrar' ? 'current-password' : 'new-password'}"></div>` : ''}
        <button class="btn bloco" type="submit">${{ entrar: 'Entrar', criar: 'Criar acesso', esqueci: 'Enviar link', nova: 'Salvar senha' }[modo]}</button>
      </form>
      <div class="auth-links">
        ${modo === 'entrar' ? '<button data-m="criar">Criar acesso</button><button data-m="esqueci">Esqueci a senha</button>' : '<button data-m="entrar">← Voltar para o login</button>'}
      </div></div></div></div>`;
    $$('.auth-links [data-m]').forEach((b) => { b.onclick = () => telaAuth(b.dataset.m); });
    $('#f-auth').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#f-auth button[type=submit]');
      const email = $('#a-email')?.value.trim(), senha = $('#a-senha')?.value;
      await ocupado(btn, async () => {
        if (modo === 'entrar') {
          const { error } = await sb.auth.signInWithPassword({ email, password: senha });
          if (error) throw error;
        } else if (modo === 'criar') {
          const { data, error } = await sb.auth.signUp({ email, password: senha, options: { data: { nome: $('#a-nome').value.trim() } } });
          if (error) throw error;
          if (!data.session) telaAuth('entrar', 'Cadastro feito! Confirme pelo link enviado ao seu e-mail e depois entre.');
        } else if (modo === 'esqueci') {
          const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
          if (error) throw error;
          telaAuth('entrar', 'Se o e-mail estiver cadastrado, o link de recuperação chegará em instantes.');
        } else if (modo === 'nova') {
          const { error } = await sb.auth.updateUser({ password: senha });
          if (error) throw error;
          toast('Senha alterada.', 'ok'); iniciarSessao();
        }
      });
    };
  }

  function telaPendente() {
    $('#raiz').innerHTML = `<div class="auth"><div class="auth-card"><div class="faixas"><i></i><i></i><i></i></div><div class="corpo">
      <img class="logo" src="logo.png" alt="Good Cake">
      <h1>Acesso aguardando liberação</h1>
      <p class="sub">Olá, ${esc(S.perfil?.nome || '')}! Seu cadastro foi recebido. Peça para um gestor liberar seu acesso em <b>Usuários</b>.</p>
      <button class="btn bloco" id="b-recheck">Verificar de novo</button>
      <div class="auth-links"><button id="b-sair">Sair</button></div>
    </div></div></div>`;
    $('#b-recheck').onclick = () => iniciarSessao();
    $('#b-sair').onclick = () => sb.auth.signOut();
  }

  let iniciando = false;
  async function iniciarSessao() {
    if (iniciando) return; iniciando = true;
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { S.user = null; telaAuth(); return; }
      S.user = session.user;
      S.perfil = await dados(sb.from('perfis').select('*').eq('id', S.user.id).maybeSingle());
      if (!S.perfil || S.perfil.papel === 'pendente' || !S.perfil.ativo) { telaPendente(); return; }
      S.unidades = await dados(sb.from('unidades').select('*').eq('ativo', true).order('nome'));
      if (!S.unidades.length) {
        $('#raiz').innerHTML = '<div class="auth"><div class="auth-card"><div class="corpo"><h1>Sem unidade</h1><p class="sub">Seu usuário ainda não foi ligado a nenhuma unidade. Fale com um gestor.</p></div></div></div>';
        return;
      }
      const salvo = store.get('gc_un');
      S.un = S.unidades.some((u) => u.id === salvo) ? salvo : S.unidades[0].id;
      await carregarCatalogo();
      await carregarEstoqueIns();
      if (ehGestor()) await contarPendentes();
      montarApp();
    } catch (e) { falha(e); telaAuth(); } finally { iniciando = false; }
  }
  async function contarPendentes() {
    const l = await dados(sb.from('perfis').select('id').eq('papel', 'pendente'));
    S.pendentes = l.length;
  }

  // ------------------------------------------------------------------ casca do app
  const ROTAS = [
    { id: 'painel', t: 'Painel', ic: 'home', g: 'Visão geral' },
    { id: 'vendas', t: 'Vendas', ic: 'venda', g: 'Operação' },
    { id: 'reservas', t: 'Reservas', ic: 'reserva', g: 'Operação' },
    { id: 'producao', t: 'Produção', ic: 'producao', g: 'Operação' },
    { id: 'contagem', t: 'Contagem semanal', ic: 'contagem', g: 'Operação' },
    { id: 'estoque', t: 'Estoque', ic: 'estoque', g: 'Estoque' },
    { id: 'entradas', t: 'Entradas', ic: 'entrada', g: 'Estoque' },
    { id: 'transferencias', t: 'Transferências', ic: 'transf', g: 'Estoque' },
    { id: 'fichas', t: 'Fichas técnicas', ic: 'ficha', g: 'Gestão' },
    { id: 'cadastros', t: 'Cadastros', ic: 'cadastro', g: 'Gestão' },
    { id: 'usuarios', t: 'Usuários', ic: 'usuarios', g: 'Gestão', gestor: true },
  ];
  const rotaAtual = () => { const r = (location.hash.replace(/^#\/?/, '') || 'painel').split('?')[0]; return ROTAS.some((x) => x.id === r) ? r : 'painel'; };

  function montarApp() {
    let grupo = '';
    const nav = ROTAS.filter((r) => !r.gestor || ehGestor()).map((r) => {
      const g = r.g !== grupo ? `<div class="grupo">${r.g}</div>` : ''; grupo = r.g;
      const badge = r.id === 'usuarios' && S.pendentes ? `<span class="badge rosa">${S.pendentes}</span>` : '';
      return `${g}<a href="#/${r.id}" data-rota="${r.id}">${ic(r.ic)}<span>${r.t}</span>${badge}</a>`;
    }).join('');
    $('#raiz').innerHTML = `
      <div class="app" id="app">
        <aside class="lateral">
          <div class="faixas"><i></i><i></i><i></i></div>
          <div class="marca"><img src="logo.png" alt=""><div><b>Good Cake</b><span>Gestão · bom em cada camada</span></div></div>
          <nav class="nav">${nav}</nav>
          <div class="usuario"><b>${esc(S.perfil.nome)}</b><span class="muted">${ehGestor() ? 'Gestor' : 'Operador'} · ${esc(S.perfil.email || '')}</span>
            <div style="margin-top:8px"><button class="btn sec mini" id="b-sair">${ic('sair')} Sair</button></div></div>
        </aside>
        <div class="principal">
          <header class="topo"><div class="barra">
            <button class="icone-btn menu-btn" id="b-menu" aria-label="Menu">${ic('menu')}</button>
            <div class="gavetas" role="tablist" aria-label="Unidade">${S.unidades.map((u) => `<button role="tab" data-un="${u.id}">${esc(nomeCurto(u))}</button>`).join('')}</div>
            <div class="direita"><span class="badge dourado" title="Contagem semanal">Contagem: ${dataCurta(proximaContagem())}</span></div>
          </div></header>
          <main class="conteudo" id="conteudo"></main>
        </div>
      </div>`;
    $('#b-sair').onclick = async () => { await sb.auth.signOut(); };
    $('#b-menu').onclick = () => $('#app').classList.toggle('menu-aberto');
    $('#app').addEventListener('click', (e) => {
      if (e.target.closest('.nav a')) $('#app').classList.remove('menu-aberto');
      else if (e.target === $('#app') ) $('#app').classList.remove('menu-aberto');
    });
    $$('.gavetas button').forEach((b) => {
      b.onclick = async () => {
        S.un = b.dataset.un; store.set('gc_un', S.un);
        await carregarEstoqueIns().catch(falha);
        renderRota();
      };
    });
    renderRota();
  }

  // fecha o menu ao tocar fora (celular)
  document.addEventListener('click', (e) => {
    const app = $('#app');
    if (app?.classList.contains('menu-aberto') && !e.target.closest('.lateral') && !e.target.closest('#b-menu')) app.classList.remove('menu-aberto');
  });

  let renderToken = 0;
  async function renderRota() {
    const r = rotaAtual();
    $$('.nav a').forEach((a) => a.classList.toggle('ativo', a.dataset.rota === r));
    $$('.gavetas button').forEach((b) => b.classList.toggle('ativo', b.dataset.un === S.un));
    S.charts.forEach((c) => c.destroy()); S.charts = [];
    const el = $('#conteudo');
    if (!el) return;
    const token = ++renderToken;
    el.innerHTML = '<div class="carregando"><div class="spinner"></div></div>';
    const fn = VIEWS[r];
    try {
      const frag = document.createElement('div');
      await fn(frag);
      if (token !== renderToken) return;
      el.innerHTML = ''; el.appendChild(frag);
      window.scrollTo({ top: 0 });
    } catch (e) {
      if (token !== renderToken) return;
      falha(e);
      el.innerHTML = `<div class="card vazio">Não foi possível carregar esta tela.<br><span class="small">${esc(msgErro(e))}</span></div>`;
    }
  }
  const recarregar = () => renderRota();

  const cabecalho = (titulo, sub, acoes = '') => `<div class="cabecalho"><div class="titulo"><h1>${esc(titulo)}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="acoes">${acoes}</div></div>`;

  // ================================================================== PAINEL
  async function vPainel(el) {
    S.periodo = S.periodo || { de: inicioMes(), ate: hoje(), preset: 'mes' };
    const { de, ate } = S.periodo;
    const [p, estIns, reservas, contAberta] = await Promise.all([
      rpc('rpc_painel', { p_unidade: S.un, p_de: de, p_ate: ate }),
      carregarEstoqueIns(),
      dados(sb.from('reservas').select('*').eq('unidade_id', S.un).in('status', ['pendente', 'confirmada']).order('data_entrega').limit(50)),
      dados(sb.from('contagens').select('id,data').eq('unidade_id', S.un).eq('status', 'aberta').limit(1)),
    ]);
    const fat = n(p.faturamento), cmvTeo = fat > 0 ? n(p.custo_vendido) / fat : null;
    const uc = p.ultima_contagem;
    const baixos = insumosAtivos().filter((i) => n(i.estoque_minimo) > 0 && n(S.estoqueIns[i.id]?.quantidade) < n(i.estoque_minimo));
    const prox = proximaContagem();
    const ehHojeContagem = prox === hoje();

    el.innerHTML = cabecalho('Painel', `${esc(unAtual()?.nome)} · ${dataBR(de)} a ${dataBR(ate)}`, '<div id="periodo"></div>') + `
      ${contAberta.length ? `<div class="aviso rosa"><b>Contagem em andamento</b> desde ${dataBR(contAberta[0].data)}. <a href="#/contagem">Continuar contagem →</a></div>`
        : ehHojeContagem ? `<div class="aviso"><b>Hoje é dia de contagem!</b> Conte o estoque pela manhã para calcular o CMV da semana. <a href="#/contagem">Abrir contagem →</a></div>`
        : `<div class="aviso"><span>Próxima contagem semanal: <b>${diaSemana(prox)}, ${dataBR(prox)}</b>, de manhã.</span></div>`}
      <div class="grade k4 mt">
        <div class="kpi"><div class="rotulo">Faturamento</div><div class="valor">${brl(fat)}</div><div class="det">${fmt(p.num_vendas)} vendas</div></div>
        <div class="kpi dourado"><div class="rotulo">Potes vendidos</div><div class="valor">${fmtAuto(p.potes)}</div><div class="det">ticket médio ${brl(p.num_vendas ? fat / p.num_vendas : 0)}</div></div>
        <div class="kpi cacau"><div class="rotulo">CMV teórico</div><div class="valor">${pct(cmvTeo)}</div><div class="det">pelas fichas · meta ${pct(metaCmv(), 0)}</div></div>
        <div class="kpi"><div class="rotulo">CMV real</div><div class="valor">${uc ? pct(uc.cmv_percentual) : '—'}</div><div class="det">${!uc ? 'sem contagem fechada' : uc.cmv_valor == null ? 'a partir da 2ª contagem' : 'contagem de ' + dataBR(uc.data)}</div></div>
      </div>
      <div class="grade k4 mt">
        <div class="kpi dourado"><div class="rotulo">Rendimento</div><div class="valor">${p.rendimento_medio == null ? '—' : fmt(n(p.rendimento_medio) * potesPorReceita(), 1)}</div><div class="det">potes por receita (padrão ${potesPorReceita()}) · ${fmt(p.producoes)} produções</div></div>
        <div class="kpi"><div class="rotulo">Lucro bruto</div><div class="valor">${brl(fat - n(p.custo_vendido))}</div><div class="det">faturamento − custo das fichas</div></div>
        <div class="kpi cacau"><div class="rotulo">Perdas</div><div class="valor">${brl(p.perdas)}</div><div class="det">vencidos, quebras etc.</div></div>
        <div class="kpi"><div class="rotulo">Reservas abertas</div><div class="valor">${fmt(p.reservas_abertas)}</div><div class="det"><a href="#/reservas">ver reservas</a></div></div>
      </div>
      <div class="grade k2 mt">
        <div class="card"><h2>Faturamento por dia</h2>${fat > 0 ? '<div class="chart-box"><canvas id="ch-dia"></canvas></div>' : '<div class="vazio">Sem vendas no período.</div>'}</div>
        <div class="card"><h2>Sabores mais vendidos</h2>${(p.top || []).length ? '<div class="chart-box"><canvas id="ch-top"></canvas></div>' : '<div class="vazio">Sem vendas no período.</div>'}</div>
      </div>
      <div class="grade k3 mt">
        <div class="card"><h2>Próximas reservas</h2>${reservas.length ? `<ul class="lista-simples">${reservas.slice(0, 6).map((r) => `
          <li><div class="grow"><b>${esc(r.cliente)}</b><div class="small muted">${dataBR(r.data_entrega)}${r.hora ? ' · ' + esc(r.hora) : ''}</div></div>${badgeStatus(r.status)}</li>`).join('')}</ul>` : '<div class="vazio">Nenhuma reserva aberta.</div>'}</div>
        <div class="card"><h2>Estoque baixo</h2>${baixos.length ? `<ul class="lista-simples">${baixos.slice(0, 8).map((i) => `
          <li><div class="grow">${esc(i.nome)}<div class="small muted">mínimo ${qtdFmt(i.estoque_minimo, i.unidade)}</div></div><span class="badge vermelho">${qtdFmt(S.estoqueIns[i.id]?.quantidade || 0, i.unidade)}</span></li>`).join('')}</ul>` : '<div class="vazio">Tudo acima do mínimo. 👌</div>'}</div>
        <div class="card"><h2>Vendas por canal</h2>${(p.por_canal || []).length ? `<ul class="lista-simples">${p.por_canal.map((c) => `
          <li><div class="grow">${esc(c.canal)}<div class="barra-prog"><i style="width:${fat ? (n(c.total) / fat * 100).toFixed(1) : 0}%"></i></div></div><b class="num">${brl(c.total)}</b></li>`).join('')}</ul>` : '<div class="vazio">Sem vendas no período.</div>'}</div>
      </div>`;
    seletorPeriodo($('#periodo', el), (np) => { S.periodo = np; recarregar(); }, S.periodo);

    // gráficos (depois de o fragmento entrar na página)
    queueMicrotask(() => setTimeout(() => {
      if (!window.Chart || !document.getElementById('ch-dia') || !document.getElementById('ch-top')) return;
      Chart.defaults.font.family = '"DM Sans", system-ui, sans-serif';
      Chart.defaults.color = '#6B5A52';
      const dias = []; for (let d = de; d <= ate && dias.length < 400; d = addDias(d, 1)) dias.push(d);
      const mapa = Object.fromEntries((p.por_dia || []).map((x) => [String(x.data).slice(0, 10), n(x.total)]));
      S.charts.push(new Chart(document.getElementById('ch-dia'), {
        type: 'bar',
        data: { labels: dias.map(dataCurta), datasets: [{ data: dias.map((d) => mapa[d] || 0), backgroundColor: '#E85D75', borderRadius: 6, maxBarThickness: 28 }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => brl(c.parsed.y) } } },
          scales: { y: { beginAtZero: true, ticks: { callback: (v) => 'R$ ' + fmt(v) }, grid: { color: '#f3e4df' } }, x: { grid: { display: false } } } },
      }));
      const top = (p.top || []).slice(0, 7);
      S.charts.push(new Chart(document.getElementById('ch-top'), {
        type: 'bar',
        data: { labels: top.map((t) => t.nome), datasets: [{ data: top.map((t) => n(t.qtd)), backgroundColor: top.map((_, i) => ['#3B2318', '#E85D75', '#E8A23A'][i % 3]), borderRadius: 6, maxBarThickness: 22 }] },
        options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtAuto(c.parsed.x) + ' potes' } } },
          scales: { x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#f3e4df' } }, y: { grid: { display: false } } } },
      }));
    }, 0));
  }

  // ================================================================== VENDAS
  const CANAIS = ['Trabalho', 'Instagram', 'WhatsApp', 'Indicação', 'Evento', 'Pronta-entrega', 'Outro'];
  const PAGAMENTOS = ['Pix', 'Dinheiro', 'Cartão de crédito', 'Cartão de débito', 'Fiado'];

  async function vVendas(el) {
    S.pVendas = S.pVendas || { de: inicioMes(), ate: hoje(), preset: 'mes' };
    const { de, ate } = S.pVendas;
    const vendas = await dados(sb.from('vendas').select('*').eq('unidade_id', S.un).gte('data', de).lte('data', ate)
      .order('data', { ascending: false }).order('criado_em', { ascending: false }).limit(500));
    const itens = vendas.length ? await dados(sb.from('venda_itens').select('*').in('venda_id', vendas.map((v) => v.id))) : [];
    const porVenda = {}; itens.forEach((i) => { (porVenda[i.venda_id] = porVenda[i.venda_id] || []).push(i); });
    const ativas = vendas.filter((v) => v.status === 'ativa');
    const tot = ativas.reduce((s, v) => s + n(v.total), 0);
    const potes = itens.filter((i) => ativas.some((v) => v.id === i.venda_id)).reduce((s, i) => s + n(i.quantidade), 0);

    el.innerHTML = cabecalho('Vendas', `${esc(nomeCurto(unAtual()))} · ${fmt(ativas.length)} vendas · ${fmtAuto(potes)} potes · ${brl(tot)}`,
      `<div id="periodo"></div><button class="btn" id="b-nova">${ic('mais')} Nova venda</button>`) + `
      <div class="card">${tabela(['Data', 'Cliente', 'Sabores', 'Canal', 'Pagamento', '#Total', 'Status', ''],
        vendas.map((v) => `<tr class="${v.status === 'cancelada' ? 'riscado' : ''}">
          <td>${dataCurta(v.data)}</td><td>${esc(v.cliente || '—')}${v.reserva_id ? ' <span class="badge rosa">reserva</span>' : ''}</td>
          <td class="small">${resumoItens(porVenda[v.id] || [])}</td><td>${esc(v.canal || '—')}</td><td>${esc(v.pagamento || '—')}</td>
          <td class="num">${brl(v.total)}${n(v.desconto) ? `<div class="small muted">desc. ${brl(v.desconto)}</div>` : ''}</td>
          <td>${badgeStatus(v.status)}</td>
          <td>${v.status === 'ativa' ? `<button class="btn perigo mini" data-cancelar="${v.id}">Cancelar</button>` : ''}</td></tr>`),
        { vazio: 'Nenhuma venda no período.', rodape: vendas.length ? `<tr><td colspan="5">Total (vendas ativas)</td><td class="num">${brl(tot)}</td><td colspan="2"></td></tr>` : '' })}</div>`;
    seletorPeriodo($('#periodo', el), (np) => { S.pVendas = np; recarregar(); }, S.pVendas);
    $('#b-nova', el).onclick = () => formVenda();
    $$('[data-cancelar]', el).forEach((b) => {
      b.onclick = async () => {
        if (!await confirmar('Cancelar esta venda? Os potes voltam para o estoque.', { ok: 'Cancelar venda', perigo: true })) return;
        try { await rpc('rpc_cancelar_venda', { p_id: b.dataset.cancelar }); toast('Venda cancelada.', 'ok'); recarregar(); } catch (e) { falha(e); }
      };
    });
  }

  async function formVenda({ reserva = null, itensReserva = [] } = {}) {
    let estoque = {};
    try { estoque = await estoqueProdutos(); } catch (e) { falha(e); }
    const qtds = {}; itensReserva.forEach((i) => { qtds[i.produto_id] = n(i.quantidade); });
    const d = abrirModal({
      titulo: reserva ? `Entregar reserva · ${reserva.cliente}` : 'Nova venda', classe: 'largo',
      corpo: `
        <div class="linha-campos">
          <div class="campo"><label>Data</label><input type="date" id="v-data" value="${hoje()}"></div>
          <div class="campo"><label>Cliente</label><input type="text" id="v-cliente" value="${esc(reserva?.cliente || '')}" placeholder="Opcional"></div>
          <div class="campo"><label>Canal</label><select id="v-canal">${opcoes(CANAIS.map((c) => ({ id: c, nome: c })), reserva ? 'WhatsApp' : 'Trabalho')}</select></div>
          <div class="campo"><label>Pagamento</label><select id="v-pag">${opcoes(PAGAMENTOS.map((c) => ({ id: c, nome: c })), 'Pix')}</select></div>
        </div>
        <div class="campo"><label>Sabores</label><div id="v-sabores"></div></div>
        <div class="linha-campos">
          <div class="campo"><label>Desconto (R$)</label><input type="number" id="v-desc" min="0" step="0.01" value="0"></div>
          <div class="campo" style="grid-column: span 2"><label>Observação</label><input type="text" id="v-obs" value="${reserva && n(reserva.sinal) ? `Sinal de ${brl(reserva.sinal)} recebido na reserva` : ''}"></div>
        </div>
        <div id="v-alerta"></div>
        <div class="total-box"><span id="v-resumo" class="muted">Nenhum sabor</span><b id="v-total">${brl(0)}</b></div>`,
      rodape: `<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="v-salvar">Registrar venda</button>`,
    });
    const atualizar = () => {
      const q = ler();
      const potes = Object.values(q).reduce((s, x) => s + x, 0);
      const bruto = Object.entries(q).reduce((s, [id, x]) => s + x * n(prodPorId(id)?.preco_venda), 0);
      d.$('#v-total').textContent = brl(Math.max(0, bruto - n(d.$('#v-desc').value)));
      d.$('#v-resumo').textContent = potes ? `${fmtAuto(potes)} pote(s) · ${brl(bruto)} bruto` : 'Nenhum sabor';
      const faltam = Object.entries(q).filter(([id, x]) => x > (estoque[id] || 0));
      d.$('#v-alerta').innerHTML = faltam.length ? `<div class="aviso small mt">Estoque do sistema menor que a venda: ${faltam.map(([id]) => esc(prodPorId(id)?.nome)).join(', ')}. A venda será registrada e a diferença aparece na contagem.</div>` : '';
    };
    const ler = saboresUI(d.$('#v-sabores'), { qtds, precos: true, estoque, onChange: atualizar });
    d.$('#v-desc').oninput = atualizar;
    atualizar();
    d.$('#v-salvar').onclick = (e) => ocupado(e.currentTarget, async () => {
      const q = ler();
      if (!Object.keys(q).length) throw new Error('Escolha ao menos um sabor.');
      await rpc('rpc_registrar_venda', { p: {
        unidade_id: S.un, data: d.$('#v-data').value, cliente: d.$('#v-cliente').value.trim(), canal: d.$('#v-canal').value,
        pagamento: d.$('#v-pag').value, desconto: n(d.$('#v-desc').value), obs: d.$('#v-obs').value.trim(), reserva_id: reserva?.id || null,
        itens: Object.entries(q).map(([produto_id, quantidade]) => ({ produto_id, quantidade, preco_unitario: n(prodPorId(produto_id)?.preco_venda) })),
      } });
      d.fechar(); toast('Venda registrada!', 'ok'); recarregar();
    });
  }

  // ================================================================== RESERVAS
  async function vReservas(el) {
    S.abaRes = S.abaRes || 'abertas';
    const filtro = { abertas: ['pendente', 'confirmada'], entregues: ['entregue'], canceladas: ['cancelada'] }[S.abaRes];
    const [reservas, estoque] = await Promise.all([
      dados(sb.from('reservas').select('*').eq('unidade_id', S.un).in('status', filtro)
        .order('data_entrega', { ascending: S.abaRes === 'abertas' }).limit(300)),
      estoqueProdutos(),
    ]);
    const itens = reservas.length ? await dados(sb.from('reserva_itens').select('*').in('reserva_id', reservas.map((r) => r.id))) : [];
    const porRes = {}; itens.forEach((i) => { (porRes[i.reserva_id] = porRes[i.reserva_id] || []).push(i); });

    // demanda de sabores reservados x estoque
    let demanda = '';
    if (S.abaRes === 'abertas') {
      const tot = {}; itens.forEach((i) => { tot[i.produto_id] = (tot[i.produto_id] || 0) + n(i.quantidade); });
      const linhas = Object.entries(tot).sort((a, b) => b[1] - a[1]).map(([id, q]) => {
        const est = estoque[id] || 0, falta = Math.max(0, q - est);
        return `<tr><td><span class="ponto ${esc(prodPorId(id)?.linha)}"></span> ${esc(prodPorId(id)?.nome)}</td><td class="num">${fmtAuto(q)}</td><td class="num">${fmtAuto(est)}</td>
          <td class="num">${falta ? `<span class="badge vermelho">produzir ${fmtAuto(falta)}</span>` : '<span class="badge verde">ok</span>'}</td></tr>`;
      });
      const faltaTotal = Object.entries(tot).reduce((s, [id, q]) => s + Math.max(0, q - (estoque[id] || 0)), 0);
      demanda = `<div class="card"><div class="card-topo"><h2>Sabores reservados</h2>${faltaTotal ? `<span class="badge dourado">faltam ${fmtAuto(faltaTotal)} potes ≈ ${fmt(faltaTotal / potesPorReceita(), 1)} receita(s)</span>` : ''}</div>
        ${tabela(['Sabor', '#Reservado', '#Em estoque', '#Situação'], linhas, { vazio: 'Nenhum sabor reservado.' })}</div>`;
    }

    el.innerHTML = cabecalho('Reservas', `${esc(nomeCurto(unAtual()))} · reserve sabores para entregar depois`, `<button class="btn" id="b-nova">${ic('mais')} Nova reserva</button>`) + `
      <div class="abas">${['abertas', 'entregues', 'canceladas'].map((a) => `<button data-aba="${a}" class="${S.abaRes === a ? 'ativo' : ''}">${a[0].toUpperCase() + a.slice(1)}</button>`).join('')}</div>
      ${demanda}
      <div class="card">${tabela(['Entrega', 'Cliente', 'Sabores', '#Sinal', 'Status', ''],
        reservas.map((r) => {
          const atrasada = S.abaRes === 'abertas' && r.data_entrega < hoje();
          const link = wa(r.telefone, `Oi, ${r.cliente}! Aqui é da Good Cake 🍰`);
          return `<tr>
            <td><b>${dataCurta(r.data_entrega)}</b>${r.hora ? ' ' + esc(r.hora) : ''}${atrasada ? ' <span class="badge vermelho">atrasada</span>' : r.data_entrega === hoje() ? ' <span class="badge dourado">hoje</span>' : ''}</td>
            <td>${esc(r.cliente)}${r.telefone ? `<div class="small">${link ? `<a href="${link}" target="_blank" rel="noopener">${esc(r.telefone)}</a>` : esc(r.telefone)}</div>` : ''}${r.obs ? `<div class="small muted">${esc(r.obs)}</div>` : ''}</td>
            <td class="small">${resumoItens(porRes[r.id] || [])}</td>
            <td class="num">${n(r.sinal) ? brl(r.sinal) : '—'}</td>
            <td>${badgeStatus(r.status)}</td>
            <td><div class="acoes">${S.abaRes === 'abertas' ? `
              ${r.status === 'pendente' ? `<button class="btn sec mini" data-conf="${r.id}">Confirmar</button>` : ''}
              <button class="btn mini" data-entregar="${r.id}">Entregar</button>
              <button class="icone-btn" title="Editar" data-editar="${r.id}">${ic('lapis')}</button>
              <button class="icone-btn" title="Cancelar" data-canc="${r.id}">${ic('x')}</button>` : ''}</div></td></tr>`;
        }), { vazio: 'Nenhuma reserva aqui.' })}</div>`;
    $$('[data-aba]', el).forEach((b) => { b.onclick = () => { S.abaRes = b.dataset.aba; recarregar(); }; });
    $('#b-nova', el).onclick = () => formReserva();
    const achar = (id) => reservas.find((r) => r.id === id);
    $$('[data-editar]', el).forEach((b) => { b.onclick = () => formReserva(achar(b.dataset.editar), porRes[b.dataset.editar] || []); });
    $$('[data-entregar]', el).forEach((b) => { b.onclick = () => formVenda({ reserva: achar(b.dataset.entregar), itensReserva: porRes[b.dataset.entregar] || [] }); });
    const mudarStatus = async (id, status, msg) => {
      try { await dados(sb.from('reservas').update({ status }).eq('id', id)); toast(msg, 'ok'); recarregar(); } catch (e) { falha(e); }
    };
    $$('[data-conf]', el).forEach((b) => { b.onclick = () => mudarStatus(b.dataset.conf, 'confirmada', 'Reserva confirmada.'); });
    $$('[data-canc]', el).forEach((b) => {
      b.onclick = async () => { if (await confirmar('Cancelar esta reserva?', { ok: 'Cancelar reserva', perigo: true })) mudarStatus(b.dataset.canc, 'cancelada', 'Reserva cancelada.'); };
    });
  }

  function formReserva(r = null, itens = []) {
    const qtds = {}; itens.forEach((i) => { qtds[i.produto_id] = n(i.quantidade); });
    const d = abrirModal({
      titulo: r ? 'Editar reserva' : 'Nova reserva', classe: 'largo',
      corpo: `
        <div class="linha-campos">
          <div class="campo"><label>Cliente *</label><input type="text" id="r-cli" value="${esc(r?.cliente || '')}"></div>
          <div class="campo"><label>WhatsApp</label><input type="tel" id="r-tel" value="${esc(r?.telefone || '')}" placeholder="(27) 99999-9999"></div>
          <div class="campo"><label>Entrega *</label><input type="date" id="r-data" value="${r?.data_entrega || addDias(hoje(), 1)}"></div>
          <div class="campo"><label>Horário</label><input type="time" id="r-hora" value="${esc(r?.hora || '')}"></div>
        </div>
        <div class="campo"><label>Sabores reservados</label><div id="r-sabores"></div></div>
        <div class="linha-campos">
          <div class="campo"><label>Sinal recebido (R$)</label><input type="number" id="r-sinal" min="0" step="0.01" value="${n(r?.sinal)}"></div>
          <div class="campo"><label>Status</label><select id="r-status">${opcoes([{ id: 'pendente', nome: 'Pendente' }, { id: 'confirmada', nome: 'Confirmada' }], r?.status || 'pendente')}</select></div>
          <div class="campo" style="grid-column: span 2"><label>Observação</label><input type="text" id="r-obs" value="${esc(r?.obs || '')}" placeholder="Endereço, retirada, etc."></div>
        </div>
        <div class="total-box"><span class="muted" id="r-resumo"></span><b id="r-total"></b></div>`,
      rodape: `<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="r-salvar">Salvar reserva</button>`,
    });
    const atualizar = () => {
      const q = ler(); const potes = Object.values(q).reduce((s, x) => s + x, 0);
      d.$('#r-resumo').textContent = `${fmtAuto(potes)} pote(s)`;
      d.$('#r-total').textContent = brl(Object.entries(q).reduce((s, [id, x]) => s + x * n(prodPorId(id)?.preco_venda), 0));
    };
    const ler = saboresUI(d.$('#r-sabores'), { qtds, precos: true, onChange: atualizar });
    atualizar();
    d.$('#r-salvar').onclick = (e) => ocupado(e.currentTarget, async () => {
      const q = ler();
      if (!d.$('#r-cli').value.trim()) throw new Error('Informe o nome do cliente.');
      if (!Object.keys(q).length) throw new Error('Escolha ao menos um sabor.');
      await rpc('rpc_salvar_reserva', { p: {
        id: r?.id || null, unidade_id: S.un, cliente: d.$('#r-cli').value.trim(), telefone: d.$('#r-tel').value.trim(),
        data_entrega: d.$('#r-data').value, hora: d.$('#r-hora').value, sinal: n(d.$('#r-sinal').value), status: d.$('#r-status').value,
        obs: d.$('#r-obs').value.trim(), itens: Object.entries(q).map(([produto_id, quantidade]) => ({ produto_id, quantidade })),
      } });
      d.fechar(); toast('Reserva salva!', 'ok'); recarregar();
    });
  }

  // ================================================================== PRODUÇÃO
  async function vProducao(el) {
    const prods = await dados(sb.from('producoes').select('*').eq('unidade_id', S.un).order('data', { ascending: false }).order('criado_em', { ascending: false }).limit(200));
    const itens = prods.length ? await dados(sb.from('producao_itens').select('*').in('producao_id', prods.map((p) => p.id))) : [];
    const porProd = {}; itens.forEach((i) => { (porProd[i.producao_id] = porProd[i.producao_id] || []).push(i); });
    const ult30 = prods.filter((p) => p.data >= addDias(hoje(), -29));
    const esp = ult30.reduce((s, p) => s + n(p.potes_esperados), 0), feitos = ult30.reduce((s, p) => s + n(p.potes_produzidos), 0);
    const rec = ult30.reduce((s, p) => s + n(p.receitas), 0);
    const pr = potesPorReceita();

    el.innerHTML = cabecalho('Produção', `${esc(nomeCurto(unAtual()))} · receita padrão = 1 massa + 1 recheio base = <b>${pr} potes de 220 ml</b>`,
      `<button class="btn" id="b-nova">${ic('mais')} Registrar produção</button>`) + `
      <div class="grade k4">
        <div class="kpi"><div class="rotulo">Receitas (30 dias)</div><div class="valor">${fmtAuto(rec)}</div><div class="det">${fmt(ult30.length)} produções</div></div>
        <div class="kpi dourado"><div class="rotulo">Potes produzidos</div><div class="valor">${fmtAuto(feitos)}</div><div class="det">esperado ${fmtAuto(esp)}</div></div>
        <div class="kpi cacau"><div class="rotulo">Potes por receita</div><div class="valor">${rec ? fmt(feitos / rec, 1) : '—'}</div><div class="det">padrão ${pr}</div></div>
        <div class="kpi"><div class="rotulo">Rendimento</div><div class="valor">${esp ? pct(feitos / esp, 0) : '—'}</div><div class="det">produzido ÷ esperado</div></div>
      </div>
      <div class="card mt">${tabela(['Data', '#Receitas', '#Esperado', '#Produzido', 'Rendimento', 'Sabores', 'Obs.'],
        prods.map((p) => `<tr><td>${dataBR(p.data)}</td><td class="num">${fmtAuto(p.receitas)}</td><td class="num">${fmtAuto(p.potes_esperados)}</td>
          <td class="num"><b>${fmtAuto(p.potes_produzidos)}</b></td><td>${badgeRend(p.rendimento)}</td>
          <td class="small">${resumoItens(porProd[p.id] || [])}</td><td class="small muted">${esc(p.obs || '')}</td></tr>`),
        { vazio: 'Nenhuma produção registrada.' })}</div>`;
    $('#b-nova', el).onclick = () => formProducao();
  }

  function formProducao() {
    const pr = potesPorReceita();
    const d = abrirModal({
      titulo: 'Registrar produção', classe: 'largo',
      corpo: `
        <div class="linha-campos">
          <div class="campo"><label>Data</label><input type="date" id="p-data" value="${hoje()}"></div>
          <div class="campo"><label>Receitas feitas</label><input type="number" id="p-rec" min="0.5" step="0.5" value="1"><span class="ajuda">1 receita = 1 massa + 1 recheio base</span></div>
          <div class="campo"><label>Validade dos potes</label><input type="date" id="p-val" value="${addDias(hoje(), 3)}"><span class="ajuda">padrão: 3 dias</span></div>
        </div>
        <div class="campo"><label>Potes montados por sabor</label><div id="p-sabores"></div></div>
        <div class="campo"><label>Observação</label><input type="text" id="p-obs" placeholder="Ex.: creme ficou mole, massa assou demais…"></div>
        <div class="total-box"><span id="p-resumo"></span><b id="p-rend">—</b></div>
        <details class="mt"><summary class="small" style="cursor:pointer">Ver consumo de insumos pela ficha técnica</summary><div id="p-consumo" class="mt"></div></details>`,
      rodape: `<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="p-salvar">Registrar produção</button>`,
    });
    const atualizar = () => {
      const q = ler(); const potes = Object.values(q).reduce((s, x) => s + x, 0);
      const esp = n(d.$('#p-rec').value) * pr;
      d.$('#p-resumo').innerHTML = `Esperado <b>${fmtAuto(esp)}</b> · produzido <b>${fmtAuto(potes)}</b> potes`;
      d.$('#p-rend').innerHTML = esp ? badgeRend(potes / esp) : '—';
      const cons = explodir(q);
      const linhas = Object.entries(cons).sort((a, b) => (insPorId(a[0])?.nome || '').localeCompare(insPorId(b[0])?.nome || '')).map(([id, qq]) => {
        const i = insPorId(id); const est = n(S.estoqueIns[id]?.quantidade);
        return `<tr><td>${esc(i?.nome)}</td><td class="num">${qtdFmt(qq, i?.unidade)}</td><td class="num">${qtdFmt(est, i?.unidade)}</td>
          <td>${est < qq - 1e-6 ? '<span class="badge vermelho">insuficiente</span>' : '<span class="badge verde">ok</span>'}</td></tr>`;
      });
      d.$('#p-consumo').innerHTML = tabela(['Insumo', '#Consumo', '#Em estoque', ''], linhas, { vazio: 'Escolha os sabores.' });
    };
    const ler = saboresUI(d.$('#p-sabores'), { onChange: atualizar });
    d.$('#p-rec').oninput = atualizar;
    atualizar();
    d.$('#p-salvar').onclick = (e) => ocupado(e.currentTarget, async () => {
      const q = ler();
      if (!Object.keys(q).length) throw new Error('Informe os potes montados.');
      const val = d.$('#p-val').value;
      await rpc('rpc_registrar_producao', { p: {
        unidade_id: S.un, data: d.$('#p-data').value, receitas: n(d.$('#p-rec').value), obs: d.$('#p-obs').value.trim(),
        itens: Object.entries(q).map(([produto_id, quantidade]) => ({ produto_id, quantidade, validade: val })),
      } });
      await carregarEstoqueIns();
      d.fechar(); toast('Produção registrada! Insumos baixados pela ficha técnica.', 'ok'); recarregar();
    });
  }

  // ================================================================== ESTOQUE
  async function vEstoque(el) {
    S.abaEst = S.abaEst || 'potes';
    const [estP, estI] = await Promise.all([estoqueProdutos(), carregarEstoqueIns()]);
    let corpo = '';
    if (S.abaEst === 'potes') {
      const res = await dados(sb.from('reservas').select('id').eq('unidade_id', S.un).in('status', ['pendente', 'confirmada']));
      const ri = res.length ? await dados(sb.from('reserva_itens').select('*').in('reserva_id', res.map((r) => r.id))) : [];
      const reservado = {}; ri.forEach((i) => { reservado[i.produto_id] = (reservado[i.produto_id] || 0) + n(i.quantidade); });
      let totQ = 0, totV = 0;
      const linhas = produtosAtivos().map((p) => {
        const q = estP[p.id] || 0, c = custoProduto(p.id), r = reservado[p.id] || 0; totQ += q; totV += Math.max(q, 0) * c;
        return `<tr><td><span class="ponto ${esc(p.linha)}"></span> <b>${esc(p.nome)}</b> <span class="small muted">${esc(p.codigo)}</span></td>
          <td class="num"><b>${fmtAuto(q)}</b></td><td class="num">${r ? fmtAuto(r) : '—'}</td>
          <td class="num">${q - r < 0 ? `<span class="badge vermelho">${fmtAuto(q - r)}</span>` : fmtAuto(q - r)}</td>
          <td class="num">${brl(c)}</td><td class="num">${brl(Math.max(q, 0) * c)}</td></tr>`;
      });
      corpo = `<div class="card">${tabela(['Sabor', '#Em estoque', '#Reservado', '#Disponível', '#Custo/pote', '#Valor'], linhas,
        { rodape: `<tr><td>Total</td><td class="num">${fmtAuto(totQ)}</td><td colspan="3"></td><td class="num">${brl(totV)}</td></tr>` })}</div>`;
    } else if (S.abaEst === 'insumos') {
      const busca = (S.buscaIns || '').toLowerCase(), cat = S.catIns || '';
      let totV = 0;
      const lista = insumosAtivos().filter((i) => (!cat || i.categoria === cat) && (!busca || i.nome.toLowerCase().includes(busca)));
      const linhas = lista.map((i) => {
        const e = S.estoqueIns[i.id] || {}; const q = n(e.quantidade); const c = custoInsumo(i.id); totV += Math.max(q, 0) * c;
        const st = q < 0 ? '<span class="badge vermelho">negativo</span>' : (n(i.estoque_minimo) > 0 && q < n(i.estoque_minimo)) ? '<span class="badge dourado">baixo</span>' : '<span class="badge verde">ok</span>';
        return `<tr><td><b>${esc(i.nome)}</b><div class="small muted">${esc(i.categoria)}</div></td><td class="num"><b>${qtdFmt(q, i.unidade)}</b></td>
          <td class="num">${n(i.estoque_minimo) ? qtdFmt(i.estoque_minimo, i.unidade) : '—'}</td><td class="num">${custoUnFmt(c, i.unidade)}</td>
          <td class="num">${brl(Math.max(q, 0) * c)}</td><td>${st}</td></tr>`;
      });
      corpo = `<div class="card"><div class="card-topo"><div class="filtros" style="flex:1">
          <input type="search" id="f-busca" placeholder="Buscar insumo…" value="${esc(S.buscaIns || '')}" style="max-width:260px">
          <select id="f-cat"><option value="">Todas as categorias</option>${['Ingrediente', 'Embalagem', 'Outros'].map((c) => `<option ${c === cat ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div>
        ${tabela(['Insumo', '#Em estoque', '#Mínimo', '#Custo médio', '#Valor', 'Situação'], linhas,
          { rodape: `<tr><td colspan="4">Valor em estoque</td><td class="num">${brl(totV)}</td><td></td></tr>` })}</div>`;
    } else {
      const tipo = S.tipoMov || '';
      let qb = sb.from('movimentos').select('*').eq('unidade_id', S.un);
      if (tipo) qb = qb.eq('tipo', tipo);
      const movs = await dados(qb.order('criado_em', { ascending: false }).limit(300));
      const linhas = movs.map((m) => {
        const i = m.insumo_id ? insPorId(m.insumo_id) : null;
        return `<tr><td>${dataCurta(m.data)}</td><td>${badgeMov(m.tipo)}</td><td>${esc(nomeItem(m))}</td>
          <td class="num ${n(m.quantidade) < 0 ? '' : ''}">${n(m.quantidade) > 0 ? '+' : ''}${i ? qtdFmt(m.quantidade, i.unidade) : fmtAuto(m.quantidade) + ' pote(s)'}</td>
          <td class="num">${brl(m.valor)}</td><td class="small muted">${esc(m.obs || '')}</td></tr>`;
      });
      corpo = `<div class="card"><div class="card-topo"><div class="filtros"><select id="f-tipo"><option value="">Todos os movimentos</option>
          ${Object.entries(TIPOS_MOV).map(([k, v]) => `<option value="${k}" ${k === tipo ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></div>
          <span class="small muted">últimos 300</span></div>
        ${tabela(['Data', 'Tipo', 'Item', '#Quantidade', '#Valor', 'Obs.'], linhas, { vazio: 'Sem movimentos.' })}</div>`;
    }
    el.innerHTML = cabecalho('Estoque', `${esc(nomeCurto(unAtual()))} · saldo atualizado a cada movimento`,
      `<button class="btn sec" id="b-perda">${ic('perda')} Registrar perda</button><a class="btn" href="#/entradas">${ic('entrada')} Entrada</a>`) + `
      <div class="abas">${[['potes', 'Potes prontos'], ['insumos', 'Ingredientes e embalagens'], ['extrato', 'Extrato']].map(([k, t]) => `<button data-aba="${k}" class="${S.abaEst === k ? 'ativo' : ''}">${t}</button>`).join('')}</div>
      ${corpo}`;
    $$('[data-aba]', el).forEach((b) => { b.onclick = () => { S.abaEst = b.dataset.aba; recarregar(); }; });
    $('#b-perda', el).onclick = () => formPerda();
    const fb = $('#f-busca', el);
    if (fb) {
      let t; fb.oninput = () => { clearTimeout(t); t = setTimeout(() => { S.buscaIns = fb.value; recarregar().then(() => { const x = $('#f-busca'); if (x) { x.focus(); x.setSelectionRange(x.value.length, x.value.length); } }); }, 300); };
      $('#f-cat', el).onchange = (e) => { S.catIns = e.target.value; recarregar(); };
    }
    const ft = $('#f-tipo', el); if (ft) ft.onchange = () => { S.tipoMov = ft.value; recarregar(); };
  }

  function formPerda() {
    const d = abrirModal({
      titulo: 'Registrar perda', classe: 'estreito',
      corpo: `
        <div class="campo"><label>O que foi perdido?</label><select id="l-tipo"><option value="produto">Pote pronto</option><option value="insumo">Ingrediente / embalagem</option></select></div>
        <div class="campo"><label>Item</label><select id="l-item"></select></div>
        <div class="linha-campos">
          <div class="campo"><label>Quantidade <span id="l-un" class="muted"></span></label><input type="number" id="l-q" min="0" step="any" value="1"></div>
          <div class="campo"><label>Data</label><input type="date" id="l-data" value="${hoje()}"></div>
        </div>
        <div class="campo"><label>Motivo</label><select id="l-mot">${['Vencido', 'Quebrado / derramado', 'Sem refrigeração', 'Degustação / cortesia', 'Erro de produção', 'Outro'].map((m) => `<option>${m}</option>`).join('')}</select></div>
        <div class="campo"><label>Detalhe</label><input type="text" id="l-obs" placeholder="Opcional"></div>`,
      rodape: `<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="l-salvar">Registrar perda</button>`,
    });
    const preencher = () => {
      const t = d.$('#l-tipo').value;
      d.$('#l-item').innerHTML = t === 'produto' ? opcoes(produtosAtivos(), null) : selInsumoOpcoes();
      unid();
    };
    const unid = () => {
      const t = d.$('#l-tipo').value;
      d.$('#l-un').textContent = t === 'produto' ? '(potes)' : `(${insPorId(d.$('#l-item').value)?.unidade || ''})`;
    };
    d.$('#l-tipo').onchange = preencher; d.$('#l-item').onchange = unid; preencher();
    d.$('#l-salvar').onclick = (e) => ocupado(e.currentTarget, async () => {
      const t = d.$('#l-tipo').value, id = d.$('#l-item').value;
      if (!id) throw new Error('Escolha o item.');
      await rpc('rpc_registrar_perda', { p: { unidade_id: S.un, data: d.$('#l-data').value, quantidade: n(d.$('#l-q').value),
        [t === 'produto' ? 'produto_id' : 'insumo_id']: id, obs: [d.$('#l-mot').value, d.$('#l-obs').value.trim()].filter(Boolean).join(' · ') } });
      d.fechar(); toast('Perda registrada.', 'ok'); recarregar();
    });
  }

  // ================================================================== ENTRADAS
  async function vEntradas(el) {
    S.pEnt = S.pEnt || { de: addDias(hoje(), -29), ate: hoje(), preset: '30' };
    const ents = await dados(sb.from('entradas').select('*').eq('unidade_id', S.un).gte('data', S.pEnt.de).lte('data', S.pEnt.ate)
      .order('data', { ascending: false }).order('criado_em', { ascending: false }).limit(300));
    const tot = ents.filter((e) => e.status === 'ativa').reduce((s, e) => s + n(e.valor_total), 0);
    el.innerHTML = cabecalho('Entradas de produtos', `${esc(nomeCurto(unAtual()))} · compras com data, quantidade, fornecedor e preço`,
      `<div id="periodo"></div><button class="btn" id="b-nova">${ic('mais')} Nova entrada</button>`) + `
      <div class="card">${tabela(['Data', 'Fornecedor', 'Documento', '#Valor', 'Status', ''],
        ents.map((e) => `<tr class="clicavel ${e.status === 'estornada' ? 'riscado' : ''}" data-ver="${e.id}">
          <td>${dataBR(e.data)}</td><td>${esc(fornPorId(e.fornecedor_id)?.nome || '—')}</td><td>${esc(e.documento || '—')}</td>
          <td class="num">${brl(e.valor_total)}</td><td>${badgeStatus(e.status)}</td><td class="small muted">ver itens →</td></tr>`),
        { vazio: 'Nenhuma entrada no período.', rodape: ents.length ? `<tr><td colspan="3">Total de compras</td><td class="num">${brl(tot)}</td><td colspan="2"></td></tr>` : '' })}</div>`;
    seletorPeriodo($('#periodo', el), (np) => { S.pEnt = np; recarregar(); }, S.pEnt);
    $('#b-nova', el).onclick = () => formEntrada();
    $$('[data-ver]', el).forEach((tr) => { tr.onclick = () => verEntrada(ents.find((e) => e.id === tr.dataset.ver)); });
  }

  async function verEntrada(ent) {
    try {
      const movs = await dados(sb.from('movimentos').select('*').eq('documento_id', ent.id).eq('tipo', 'entrada'));
      const d = abrirModal({
        titulo: `Entrada de ${dataBR(ent.data)}`,
        corpo: `<p class="muted" style="margin-top:0">${esc(fornPorId(ent.fornecedor_id)?.nome || 'Sem fornecedor')} · ${esc(ent.documento || 'sem documento')} ${badgeStatus(ent.status)}</p>
          ${tabela(['Insumo', '#Quantidade', '#Custo', '#Valor', 'Validade'], movs.map((m) => {
            const i = insPorId(m.insumo_id);
            return `<tr><td>${esc(i?.nome)}</td><td class="num">${qtdFmt(m.quantidade, i?.unidade)}</td><td class="num">${custoUnFmt(m.custo_unitario, i?.unidade)}</td>
              <td class="num">${brl(m.valor)}</td><td>${m.validade ? dataBR(m.validade) : '—'}</td></tr>`;
          }), { rodape: `<tr><td colspan="3">Total</td><td class="num">${brl(ent.valor_total)}</td><td></td></tr>` })}
          ${ent.obs ? `<p class="small muted">${esc(ent.obs)}</p>` : ''}`,
        rodape: `${ehGestor() && ent.status === 'ativa' ? '<button class="btn perigo esq" id="e-estornar">Estornar entrada</button>' : ''}<button class="btn sec" data-fechar>Fechar</button>`,
      });
      const b = d.$('#e-estornar');
      if (b) b.onclick = async () => {
        if (!await confirmar('Estornar esta entrada? As quantidades saem do estoque.', { ok: 'Estornar', perigo: true })) return;
        try { await rpc('rpc_estornar_entrada', { p_id: ent.id }); d.fechar(); toast('Entrada estornada.', 'ok'); recarregar(); } catch (e) { falha(e); }
      };
    } catch (e) { falha(e); }
  }

  function formEntrada() {
    const d = abrirModal({
      titulo: 'Nova entrada', classe: 'largo',
      corpo: `
        <div class="linha-campos">
          <div class="campo"><label>Data da compra</label><input type="date" id="e-data" value="${hoje()}"></div>
          <div class="campo"><label>Fornecedor</label><div style="display:flex;gap:6px"><select id="e-forn">${opcoes(S.cat.fornecedores.filter((f) => f.ativo), null, { vazio: 'Sem fornecedor' })}</select>
            <button type="button" class="btn sec" id="e-novo-forn" title="Novo fornecedor">${ic('mais')}</button></div></div>
          <div class="campo"><label>Nota / cupom</label><input type="text" id="e-doc" placeholder="Opcional"></div>
        </div>
        <div class="campo"><label>Itens</label><div class="itens-lista" id="e-itens"></div>
          <div><button type="button" class="btn sec mini mt" id="e-add">${ic('mais')} Adicionar item</button></div></div>
        <div class="campo"><label>Observação</label><input type="text" id="e-obs"></div>
        <div class="total-box"><span class="muted" id="e-qtd"></span><b id="e-total">${brl(0)}</b></div>`,
      rodape: `<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="e-salvar">Dar entrada</button>`,
    });
    const lista = d.$('#e-itens');
    const total = () => {
      const linhas = d.$$('.item-linha');
      d.$('#e-total').textContent = brl(linhas.reduce((s, l) => s + n(l.querySelector('[data-v]').value), 0));
      d.$('#e-qtd').textContent = `${linhas.length} item(ns)`;
    };
    const addLinha = () => {
      const l = document.createElement('div');
      l.className = 'item-linha';
      l.innerHTML = `
        <div class="campo"><label>Insumo</label><select data-i>${selInsumoOpcoes()}</select></div>
        <div class="campo"><label>Embalagens</label><input type="number" data-e min="0" step="any" value="1"></div>
        <div class="campo"><label>Conteúdo/emb. <span data-u class="muted"></span></label><input type="number" data-c min="0" step="any"></div>
        <div class="campo"><label>Valor total (R$)</label><input type="number" data-v min="0" step="0.01"></div>
        <div class="campo"><label>Validade</label><input type="date" data-val></div>
        <div><button type="button" class="icone-btn" data-rm title="Remover">${ic('lixo')}</button></div>
        <div class="small muted" data-info style="grid-column:1/-1;margin-top:-4px"></div>`;
      lista.appendChild(l);
      const sel = l.querySelector('[data-i]'), emb = l.querySelector('[data-e]'), cont = l.querySelector('[data-c]'), val = l.querySelector('[data-v]');
      const info = () => {
        const i = insPorId(sel.value); const q = n(emb.value) * n(cont.value);
        l.querySelector('[data-u]').textContent = i ? `(${i.unidade})` : '';
        l.querySelector('[data-info]').textContent = i && q > 0 ? `${qtdFmt(q, i.unidade)} · ${n(val.value) ? custoUnFmt(n(val.value) / q, i.unidade) : ''}` : '';
        total();
      };
      sel.onchange = () => {
        const i = insPorId(sel.value);
        if (i) { cont.value = n(i.embalagem_padrao) || 1; if (!val.value) val.value = (n(i.custo_referencia) * (n(i.embalagem_padrao) || 1) * n(emb.value)).toFixed(2); }
        info();
      };
      emb.oninput = cont.oninput = val.oninput = info;
      l.querySelector('[data-rm]').onclick = () => { l.remove(); total(); };
      total();
    };
    d.$('#e-add').onclick = addLinha; addLinha();
    d.$('#e-novo-forn').onclick = () => formFornecedor(null, (f) => { d.$('#e-forn').innerHTML = opcoes(S.cat.fornecedores.filter((x) => x.ativo), f.id, { vazio: 'Sem fornecedor' }); });
    d.$('#e-salvar').onclick = (e) => ocupado(e.currentTarget, async () => {
      const itens = d.$$('.item-linha').map((l) => ({
        insumo_id: l.querySelector('[data-i]').value,
        quantidade: n(l.querySelector('[data-e]').value) * n(l.querySelector('[data-c]').value),
        valor_total: n(l.querySelector('[data-v]').value), validade: l.querySelector('[data-val]').value || null,
      })).filter((i) => i.insumo_id);
      if (!itens.length) throw new Error('Adicione ao menos um item.');
      if (itens.some((i) => i.quantidade <= 0)) throw new Error('Confira as quantidades.');
      await rpc('rpc_registrar_entrada', { p: { unidade_id: S.un, data: d.$('#e-data').value, fornecedor_id: d.$('#e-forn').value || null,
        documento: d.$('#e-doc').value.trim(), obs: d.$('#e-obs').value.trim(), itens } });
      await Promise.all([carregarCatalogo(), carregarEstoqueIns()]);
      d.fechar(); toast('Entrada registrada!', 'ok'); recarregar();
    });
  }

  // ================================================================== TRANSFERÊNCIAS
  async function vTransferencias(el) {
    const todas = await dados(sb.from('transferencias').select('*').order('data', { ascending: false }).order('criado_em', { ascending: false }).limit(300));
    const trs = todas.filter((t) => t.origem_id === S.un || t.destino_id === S.un);
    const itens = trs.length ? await dados(sb.from('transferencia_itens').select('*').in('transferencia_id', trs.map((t) => t.id))) : [];
    const porT = {}; itens.forEach((i) => { (porT[i.transferencia_id] = porT[i.transferencia_id] || []).push(i); });
    const nomeUn = (id) => nomeCurto(S.unidades.find((u) => u.id === id)) || 'outra unidade';
    const desc = (i) => { const x = i.insumo_id ? insPorId(i.insumo_id) : null; return `${x ? qtdFmt(i.quantidade, x.unidade) : fmtAuto(i.quantidade) + '×'} ${esc(nomeItem(i))}`; };
    el.innerHTML = cabecalho('Transferências', 'Mova potes e insumos entre as unidades. O custo vai junto.',
      S.unidades.length > 1 ? `<button class="btn" id="b-nova">${ic('transf')} Nova transferência</button>` : '') + `
      <div class="card">${tabela(['Data', 'Direção', 'Itens', 'Obs.'],
        trs.map((t) => `<tr><td>${dataBR(t.data)}</td>
          <td>${t.origem_id === S.un ? `<span class="badge dourado">enviada</span> para ${esc(nomeUn(t.destino_id))}` : `<span class="badge verde">recebida</span> de ${esc(nomeUn(t.origem_id))}`}</td>
          <td class="small">${(porT[t.id] || []).map(desc).join(', ')}</td><td class="small muted">${esc(t.obs || '')}</td></tr>`),
        { vazio: 'Nenhuma transferência.' })}</div>`;
    const b = $('#b-nova', el); if (b) b.onclick = () => formTransferencia();
  }

  async function formTransferencia() {
    let estP = {};
    try { estP = await estoqueProdutos(); } catch (e) { falha(e); }
    const outras = S.unidades.filter((u) => u.id !== S.un);
    const d = abrirModal({
      titulo: 'Nova transferência', classe: 'largo',
      corpo: `
        <div class="linha-campos">
          <div class="campo"><label>De</label><input type="text" value="${esc(nomeCurto(unAtual()))}" disabled></div>
          <div class="campo"><label>Para</label><select id="t-dest">${opcoes(outras, outras[0]?.id, { rot: nomeCurto })}</select></div>
          <div class="campo"><label>Data</label><input type="date" id="t-data" value="${hoje()}"></div>
        </div>
        <div class="campo"><label>Itens</label><div class="itens-lista" id="t-itens"></div><div><button type="button" class="btn sec mini mt" id="t-add">${ic('mais')} Adicionar item</button></div></div>
        <div class="campo"><label>Observação</label><input type="text" id="t-obs" placeholder="Ex.: levado pela Ana no sábado"></div>`,
      rodape: `<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="t-salvar">Transferir</button>`,
    });
    const addLinha = () => {
      const l = document.createElement('div'); l.className = 'item-linha f3';
      l.innerHTML = `<div class="campo"><label>Tipo</label><select data-t><option value="produto">Pote pronto</option><option value="insumo">Insumo</option></select></div>
        <div class="campo"><label>Item</label><select data-i></select></div>
        <div class="campo"><label>Quantidade <span data-u class="muted"></span></label><input type="number" data-q min="0" step="any" value="1"></div>
        <div><button type="button" class="icone-btn" data-rm>${ic('lixo')}</button></div>`;
      d.$('#t-itens').appendChild(l);
      const t = l.querySelector('[data-t]'), i = l.querySelector('[data-i]');
      const un = () => {
        const x = t.value === 'produto' ? null : insPorId(i.value);
        l.querySelector('[data-u]').textContent = t.value === 'produto' ? `(tem ${fmtAuto(estP[i.value] || 0)})` : x ? `(${x.unidade}, tem ${qtdFmt(S.estoqueIns[x.id]?.quantidade || 0, x.unidade)})` : '';
      };
      const fill = () => { i.innerHTML = t.value === 'produto' ? opcoes(produtosAtivos(), null) : selInsumoOpcoes(); un(); };
      t.onchange = fill; i.onchange = un; fill();
      l.querySelector('[data-rm]').onclick = () => l.remove();
    };
    d.$('#t-add').onclick = addLinha; addLinha();
    d.$('#t-salvar').onclick = (e) => ocupado(e.currentTarget, async () => {
      const itens = d.$$('.item-linha').map((l) => {
        const t = l.querySelector('[data-t]').value, id = l.querySelector('[data-i]').value;
        return { [t === 'produto' ? 'produto_id' : 'insumo_id']: id, quantidade: n(l.querySelector('[data-q]').value), _id: id };
      }).filter((x) => x._id && x.quantidade > 0).map(({ _id, ...x }) => x);
      if (!itens.length) throw new Error('Adicione ao menos um item.');
      await rpc('rpc_transferir', { p: { origem_id: S.un, destino_id: d.$('#t-dest').value, data: d.$('#t-data').value, obs: d.$('#t-obs').value.trim(), itens } });
      await carregarEstoqueIns();
      d.fechar(); toast('Transferência registrada!', 'ok'); recarregar();
    });
  }

  // ================================================================== CONTAGEM SEMANAL
  async function vContagem(el) {
    const conts = await dados(sb.from('contagens').select('*').eq('unidade_id', S.un).order('data', { ascending: false }).limit(60));
    const aberta = conts.find((c) => c.status === 'aberta');
    const fechadas = conts.filter((c) => c.status === 'fechada');
    const prox = proximaContagem();
    let corpo = '';
    if (aberta) {
      const itens = await dados(sb.from('contagem_itens').select('*').eq('contagem_id', aberta.id));
      const grupos = [
        ['Potes prontos', itens.filter((i) => i.produto_id)],
        ['Ingredientes', itens.filter((i) => i.insumo_id && insPorId(i.insumo_id)?.categoria === 'Ingrediente')],
        ['Embalagens', itens.filter((i) => i.insumo_id && insPorId(i.insumo_id)?.categoria === 'Embalagem')],
        ['Outros', itens.filter((i) => i.insumo_id && insPorId(i.insumo_id)?.categoria === 'Outros')],
      ].filter((g) => g[1].length);
      grupos.forEach((g) => g[1].sort((a, b) => nomeItem(a).localeCompare(nomeItem(b), 'pt-BR')));
      const feitos = itens.filter((i) => i.quantidade_contada !== null).length;
      const linha = (i) => {
        const x = i.insumo_id ? insPorId(i.insumo_id) : null; const u = x ? x.unidade : 'potes';
        const dif = i.quantidade_contada === null ? null : n(i.quantidade_contada) - n(i.quantidade_sistema);
        return `<div class="contagem-item ${i.quantidade_contada !== null ? 'feito' : ''}" data-id="${i.id}">
          <div><b>${esc(nomeItem(i))}</b><div class="small muted">${u}${x?.embalagem_padrao ? ` · emb. ${qtdFmt(x.embalagem_padrao, x.unidade)}` : ''}</div></div>
          <div class="sis small muted num">sistema: ${x ? qtdFmt(i.quantidade_sistema, u) : fmtAuto(i.quantidade_sistema)}</div>
          <input type="number" min="0" step="any" inputmode="decimal" placeholder="contado" value="${i.quantidade_contada ?? ''}" aria-label="${esc(nomeItem(i))}">
          <div class="dif small num">${dif === null ? '' : dif === 0 ? '<span class="badge verde">ok</span>' : `<span class="badge ${dif < 0 ? 'vermelho' : 'dourado'}">${dif > 0 ? '+' : ''}${x ? qtdFmt(dif, u) : fmtAuto(dif)}</span>`}</div></div>`;
      };
      corpo = `<div class="card">
          <div class="card-topo"><h2>Contagem de ${dataBR(aberta.data)}</h2><span class="small muted" id="c-prog">${feitos} de ${itens.length} contados</span></div>
          <div class="barra-prog dourado"><i id="c-barra" style="width:${itens.length ? feitos / itens.length * 100 : 0}%"></i></div>
          <p class="small muted">Conte o que existe fisicamente e digite na unidade indicada (g, ml, un ou potes). Salva sozinho. Itens deixados em branco ficam com a quantidade do sistema.</p>
          ${grupos.map(([t, l]) => `<div class="contagem-grupo"><h3>${t}</h3>${l.map(linha).join('')}</div>`).join('')}
          <div class="acoes mt" style="justify-content:flex-end">
            ${ehGestor() ? '<button class="btn perigo" id="c-excluir">Descartar contagem</button>' : ''}
            <button class="btn escuro" id="c-fechar">Fechar contagem e calcular CMV</button></div>
        </div>`;
      el.innerHTML = cabecalho('Contagem semanal', `${esc(nomeCurto(unAtual()))} · todo ${diaSemana(prox)} de manhã`) + corpo + historicoContagens(fechadas);
      // salva cada item ao sair do campo (delegação: vale também para as linhas redesenhadas)
      el.addEventListener('change', async (ev) => {
        const inp = ev.target.closest('.contagem-item input'); if (!inp) return;
        const row = inp.closest('.contagem-item'); const id = row.dataset.id;
        const v = inp.value === '' ? null : n(inp.value);
        try {
          await dados(sb.from('contagem_itens').update({ quantidade_contada: v }).eq('id', id));
          const it = itens.find((x) => x.id === id); it.quantidade_contada = v;
          const ativo = document.activeElement;
          row.outerHTML = linha(it);
          if (ativo && ativo !== inp && ativo.isConnected) ativo.focus();
          const f = itens.filter((i) => i.quantidade_contada !== null).length;
          $('#c-prog').textContent = `${f} de ${itens.length} contados`; $('#c-barra').style.width = (f / itens.length * 100) + '%';
        } catch (e) { falha(e); }
      });
      $('#c-fechar', el).onclick = async (e) => {
        const faltam = itens.filter((i) => i.quantidade_contada === null).length;
        if (!await confirmar(`Fechar a contagem${faltam ? ` (${faltam} item(ns) sem contagem ficarão com o saldo do sistema)` : ''}? Os ajustes serão lançados no estoque e o CMV da semana será calculado.`, { ok: 'Fechar contagem' })) return;
        await ocupado(e.currentTarget || e.target, async () => {
          const r = await rpc('rpc_fechar_contagem', { p_id: aberta.id });
          await carregarEstoqueIns();
          mostrarResultadoCmv(r);
          recarregar();
        });
      };
      const bx = $('#c-excluir', el);
      if (bx) bx.onclick = async () => {
        if (!await confirmar('Descartar esta contagem? Nada será lançado no estoque.', { ok: 'Descartar', perigo: true })) return;
        try { await dados(sb.from('contagens').delete().eq('id', aberta.id)); toast('Contagem descartada.'); recarregar(); } catch (er) { falha(er); }
      };
    } else {
      el.innerHTML = cabecalho('Contagem semanal', `${esc(nomeCurto(unAtual()))} · todo ${diaSemana(prox)} de manhã`) + `
        <div class="card"><div class="card-topo"><h2>${prox === hoje() ? 'Hoje é dia de contagem' : `Próxima contagem: ${diaSemana(prox)}, ${dataBR(prox)}`}</h2></div>
          <p class="muted" style="margin-top:0">A contagem tira uma foto do estoque. Com ela o sistema ajusta os saldos e calcula o <b>CMV real</b> da semana:
          estoque inicial + compras − estoque final, dividido pelo faturamento.</p>
          <div class="filtros"><input type="date" id="c-data" value="${hoje()}"><button class="btn" id="c-abrir">${ic('contagem')} Abrir contagem</button></div></div>` + historicoContagens(fechadas);
      $('#c-abrir', el).onclick = (e) => ocupado(e.currentTarget, async () => {
        await rpc('rpc_abrir_contagem', { p_unidade: S.un, p_data: $('#c-data').value });
        recarregar();
      });
    }
    $$('[data-cont]', el).forEach((tr) => { tr.onclick = () => verContagem(fechadas.find((c) => c.id === tr.dataset.cont)); });
  }

  function historicoContagens(fechadas) {
    return `<div class="card"><h2>Histórico de CMV</h2>${tabela(['Contagem', 'Período', '#Estoque inicial', '#Compras', '#Estoque final', '#CMV', '#Faturamento', 'CMV %'],
      fechadas.map((c) => `<tr class="clicavel" data-cont="${c.id}"><td><b>${dataBR(c.data)}</b></td><td class="small">${dataCurta(c.periodo_inicio)} a ${dataCurta(c.data)}</td>
        <td class="num">${brl(c.estoque_inicial_valor)}</td><td class="num">${brl(c.compras_valor)}</td><td class="num">${brl(c.estoque_final_valor)}</td>
        <td class="num"><b>${c.cmv_valor == null ? 'ponto de partida' : brl(c.cmv_valor)}</b></td><td class="num">${brl(c.faturamento)}</td><td>${badgeCmv(c.cmv_percentual)}</td></tr>`),
      { vazio: 'Nenhuma contagem fechada ainda. A primeira serve de ponto de partida (estoque inicial).' })}
      <p class="small muted">Meta de CMV: ${pct(metaCmv(), 0)}. A primeira contagem não tem estoque inicial, então o CMV real começa a valer a partir da segunda.</p></div>`;
  }

  function mostrarResultadoCmv(r) {
    abrirModal({
      titulo: 'Contagem fechada', classe: 'estreito',
      corpo: `<div class="lista-simples">
        <ul class="lista-simples">
          <li><span class="grow">Estoque inicial</span><b class="num">${brl(r.estoque_inicial)}</b></li>
          <li><span class="grow">+ Compras e transferências</span><b class="num">${brl(r.compras)}</b></li>
          <li><span class="grow">− Estoque final (contado)</span><b class="num">${brl(r.estoque_final)}</b></li>
          <li><span class="grow"><b>= CMV</b></span><b class="num">${r.cmv == null ? '—' : brl(r.cmv)}</b></li>
          ${r.cmv == null ? '<li class="small muted">Primeira contagem: ela vira o estoque inicial. O CMV real aparece a partir da próxima.</li>' : ''}
          <li><span class="grow">Faturamento do período</span><b class="num">${brl(r.faturamento)}</b></li>
          <li><span class="grow"><b>CMV %</b></span>${badgeCmv(r.cmv_percentual)}</li>
        </ul></div>`,
      rodape: '<button class="btn" data-fechar>Ok</button>',
    });
  }

  async function verContagem(c) {
    try {
      const itens = await dados(sb.from('contagem_itens').select('*').eq('contagem_id', c.id));
      const difs = itens.filter((i) => i.quantidade_contada !== null && n(i.quantidade_contada) !== n(i.quantidade_sistema));
      abrirModal({
        titulo: `Contagem de ${dataBR(c.data)}`,
        corpo: `<div class="grade k3">
            <div class="kpi"><div class="rotulo">CMV</div><div class="valor">${c.cmv_valor == null ? '—' : brl(c.cmv_valor)}</div></div>
            <div class="kpi dourado"><div class="rotulo">Faturamento</div><div class="valor">${brl(c.faturamento)}</div></div>
            <div class="kpi cacau"><div class="rotulo">CMV %</div><div class="valor">${pct(c.cmv_percentual)}</div></div></div>
          <h3 class="mt">Diferenças encontradas</h3>
          ${tabela(['Item', '#Sistema', '#Contado', '#Diferença', '#Valor'], difs.map((i) => {
            const x = i.insumo_id ? insPorId(i.insumo_id) : null; const f = (v) => x ? qtdFmt(v, x.unidade) : fmtAuto(v);
            const dif = n(i.quantidade_contada) - n(i.quantidade_sistema);
            return `<tr><td>${esc(nomeItem(i))}</td><td class="num">${f(i.quantidade_sistema)}</td><td class="num">${f(i.quantidade_contada)}</td>
              <td class="num"><span class="badge ${dif < 0 ? 'vermelho' : 'dourado'}">${dif > 0 ? '+' : ''}${f(dif)}</span></td><td class="num">${brl(dif * n(i.custo_unitario))}</td></tr>`;
          }), { vazio: 'Nenhuma diferença: estoque batido. 👏' })}`,
        rodape: '<button class="btn sec" data-fechar>Fechar</button>',
      });
    } catch (e) { falha(e); }
  }

  // ================================================================== FICHAS TÉCNICAS
  async function vFichas(el) {
    S.abaFic = S.abaFic || 'produtos';
    await carregarEstoqueIns();
    const pr = potesPorReceita(), meta = metaCmv();
    let corpo = '';
    if (S.abaFic === 'produtos') {
      corpo = `<div class="fichas">${S.cat.produtos.map((p) => {
        const c = custoProduto(p.id), cmv = n(p.preco_venda) > 0 ? c / n(p.preco_venda) : null;
        return `<div class="ficha" data-prod="${p.id}" tabindex="0">
          <div class="cod">${esc(p.codigo)} ${p.ativo ? '' : '<span class="badge cinza">inativo</span>'}</div>
          <h3>${esc(p.nome)}</h3>
          <div class="linhas"><span class="muted">Linha</span><span><span class="badge ${p.linha === 'Premium' ? 'dourado' : 'rosa'}">${esc(p.linha)}</span></span>
            <span class="muted">Preço</span><b class="num">${brl(p.preco_venda)}</b>
            <span class="muted">Custo do pote</span><span class="num">${brl(c)}</span>
            <span class="muted">Margem</span><span class="num">${brl(n(p.preco_venda) - c)}</span>
            <span class="muted">CMV</span><span>${badgeCmv(cmv)}</span></div></div>`;
      }).join('')}</div>`;
    } else {
      corpo = `<div class="card">${tabela(['Código', 'Preparo', '#Rendimento', '#Custo da receita', '#Custo/kg', '#Por pote*'],
        S.cat.preparos.map((p) => {
          const cg = custoPreparoG(p.id);
          return `<tr class="clicavel" data-prep="${p.id}"><td>${esc(p.codigo)}</td><td><b>${esc(p.nome)}</b>${p.ativo ? '' : ' <span class="badge cinza">inativo</span>'}</td>
            <td class="num">${qtdFmt(p.rendimento, 'g')}</td><td class="num">${brl(cg * n(p.rendimento))}</td><td class="num">${brl(cg * 1000)}</td>
            <td class="num">${qtdFmt(n(p.rendimento) / pr, 'g')}</td></tr>`;
        }))}<p class="small muted">* rendimento ÷ ${pr}: quanto de cada preparo vai num pote quando a receita inteira vira ${pr} potes.</p></div>`;
    }
    el.innerHTML = cabecalho('Fichas técnicas', `Custos calculados com o custo médio de <b>${esc(nomeCurto(unAtual()))}</b> · meta de CMV ${pct(meta, 0)}`,
      ehGestor() ? `<button class="btn" id="b-novo">${ic('mais')} ${S.abaFic === 'produtos' ? 'Novo sabor' : 'Novo preparo'}</button>` : '') + `
      <div class="aviso rosa"><span><b>Receita padrão:</b> 1 massa + 1 recheio base = <b>${pr} potes de 220 ml</b>. As quantidades por pote são 1/${pr} da receita.</span></div>
      <div class="abas mt">${[['produtos', 'Sabores (potes)'], ['preparos', 'Preparos (massa, cremes, geleia)']].map(([k, t]) => `<button data-aba="${k}" class="${S.abaFic === k ? 'ativo' : ''}">${t}</button>`).join('')}</div>
      ${corpo}`;
    $$('[data-aba]', el).forEach((b) => { b.onclick = () => { S.abaFic = b.dataset.aba; recarregar(); }; });
    $$('[data-prod]', el).forEach((c) => { c.onclick = () => fichaProduto(prodPorId(c.dataset.prod)); c.onkeydown = (e) => { if (e.key === 'Enter') c.click(); }; });
    $$('[data-prep]', el).forEach((c) => { c.onclick = () => fichaPreparo(prepPorId(c.dataset.prep)); });
    const bn = $('#b-novo', el); if (bn) bn.onclick = () => (S.abaFic === 'produtos' ? fichaProduto(null) : fichaPreparo(null));
  }

  // opções de componente: preparos + insumos (valor "p:<id>" ou "i:<id>" ou "s:<id>" para sub-preparo)
  function opcoesComponente(sel, prefixoPrep = 'p', excluir = null) {
    const preps = S.cat.preparos.filter((p) => p.id !== excluir);
    return '<option value="">Selecione…</option>' +
      `<optgroup label="Preparos">${preps.map((p) => `<option value="${prefixoPrep}:${p.id}" ${sel === prefixoPrep + ':' + p.id ? 'selected' : ''}>${esc(p.codigo + ' · ' + p.nome)}</option>`).join('')}</optgroup>` +
      ['Ingrediente', 'Embalagem', 'Outros'].map((c) => {
        const l = S.cat.insumos.filter((i) => i.categoria === c && (i.ativo || sel === 'i:' + i.id));
        return l.length ? `<optgroup label="${c}">${l.map((i) => `<option value="i:${i.id}" ${sel === 'i:' + i.id ? 'selected' : ''}>${esc(i.nome)}</option>`).join('')}</optgroup>` : '';
      }).join('');
  }
  const custoComp = (val, q) => {
    const [t, id] = (val || ':').split(':');
    if (!id) return 0;
    return n(q) * (t === 'i' ? custoInsumo(id) : custoPreparoG(id));
  };
  const unidComp = (val) => { const [t, id] = (val || ':').split(':'); return t === 'i' ? (insPorId(id)?.unidade || '') : 'g'; };

  async function fichaProduto(p) {
    const ed = ehGestor();
    const ordem = (i) => i.preparo_id ? '0' + (prepPorId(i.preparo_id)?.codigo || '') : ({ Ingrediente: '1', Embalagem: '2' }[insPorId(i.insumo_id)?.categoria] || '3') + (insPorId(i.insumo_id)?.nome || '');
    const itens = p ? S.cat.produtoItens.filter((i) => i.produto_id === p.id).sort((a, b) => ordem(a).localeCompare(ordem(b))) : [];
    let hist = [];
    if (p) { try { hist = await dados(sb.from('historico_precos').select('*').eq('produto_id', p.id).order('alterado_em', { ascending: false }).limit(20)); } catch { /* ok */ } }
    const dis = ed ? '' : 'disabled';
    const d = abrirModal({
      titulo: p ? `${p.codigo} · ${p.nome}` : 'Novo sabor', classe: 'largo',
      corpo: `
        <div class="linha-campos">
          <div class="campo"><label>Código</label><input type="text" id="f-cod" value="${esc(p?.codigo || '')}" ${dis} placeholder="BP-08"></div>
          <div class="campo" style="grid-column: span 2"><label>Nome do sabor</label><input type="text" id="f-nome" value="${esc(p?.nome || '')}" ${dis}></div>
          <div class="campo"><label>Linha</label><select id="f-linha" ${dis}>${opcoes([{ id: 'Comum', nome: 'Comum' }, { id: 'Premium', nome: 'Premium' }], p?.linha || 'Comum')}</select></div>
          <div class="campo"><label>Preço de venda (R$)</label><input type="number" id="f-preco" min="0" step="0.5" value="${n(p?.preco_venda)}" ${dis}></div>
        </div>
        <h3>Composição de 1 pote (220 ml)</h3>
        <div class="itens-lista mt" id="f-itens"></div>
        ${ed ? `<div><button type="button" class="btn sec mini mt" id="f-add">${ic('mais')} Adicionar componente</button></div>` : ''}
        <div class="grade k4 mt">
          <div class="kpi"><div class="rotulo">Custo do pote</div><div class="valor" id="k-custo">—</div></div>
          <div class="kpi dourado"><div class="rotulo">Preço</div><div class="valor" id="k-preco">—</div></div>
          <div class="kpi cacau"><div class="rotulo">Margem</div><div class="valor" id="k-margem">—</div></div>
          <div class="kpi"><div class="rotulo">CMV</div><div class="valor" id="k-cmv">—</div><div class="det" id="k-sug"></div></div>
        </div>
        <div class="linha-campos mt">
          <div class="campo"><label>Montagem</label><textarea id="f-mont" ${dis}>${esc(p?.montagem || '')}</textarea></div>
          <div class="campo"><label>Alergênicos (etiqueta)</label><textarea id="f-aler" ${dis}>${esc(p?.alergenos || 'Contém leite, ovo e glúten.')}</textarea></div>
        </div>
        <label class="check"><input type="checkbox" id="f-ativo" ${p?.ativo === false ? '' : 'checked'} ${dis}> Sabor ativo (aparece em vendas, produção e reservas)</label>
        ${hist.length ? `<h3 class="mt">Histórico de preço</h3><ul class="lista-simples">${hist.map((h) => `<li><span class="grow small">${new Date(h.alterado_em).toLocaleString('pt-BR')}</span><span class="small">${brl(h.preco_anterior)} → <b>${brl(h.preco_novo)}</b></span></li>`).join('')}</ul>` : ''}`,
      rodape: ed ? `<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="f-salvar">Salvar ficha</button>` : '<button class="btn sec" data-fechar>Fechar</button>',
    });
    const lista = d.$('#f-itens');
    const calc = () => {
      let tot = 0;
      d.$$('.item-linha').forEach((l) => {
        const v = l.querySelector('[data-c]').value, q = l.querySelector('[data-q]').value;
        const c = custoComp(v, q); tot += c;
        l.querySelector('[data-u]').textContent = unidComp(v) ? `(${unidComp(v)})` : '';
        l.querySelector('[data-custo]').textContent = brl(c);
      });
      const preco = n(d.$('#f-preco').value);
      d.$('#k-custo').textContent = brl(tot); d.$('#k-preco').textContent = brl(preco);
      d.$('#k-margem').textContent = brl(preco - tot);
      d.$('#k-cmv').innerHTML = preco > 0 ? badgeCmv(tot / preco) : '—';
      d.$('#k-sug').textContent = tot > 0 ? `preço p/ meta ${pct(metaCmv(), 0)}: ${brl(tot / metaCmv())}` : '';
    };
    const addLinha = (val = '', q = '') => {
      const l = document.createElement('div'); l.className = 'item-linha f4';
      l.innerHTML = `<div class="campo"><label>Componente</label><select data-c ${dis}>${opcoesComponente(val)}</select></div>
        <div class="campo"><label>Quantidade <span data-u class="muted"></span></label><input type="number" data-q min="0" step="any" value="${q}" ${dis}></div>
        <div class="campo"><label>Custo</label><input type="text" data-custo disabled></div>
        <div>${ed ? `<button type="button" class="icone-btn" data-rm>${ic('lixo')}</button>` : ''}</div>`;
      // custo como texto
      const custo = l.querySelector('[data-custo]'); const span = document.createElement('div');
      span.setAttribute('data-custo', ''); span.className = 'num'; span.style.padding = '9px 0'; custo.replaceWith(span);
      lista.appendChild(l);
      l.querySelector('[data-c]').onchange = calc; l.querySelector('[data-q]').oninput = calc;
      const rm = l.querySelector('[data-rm]'); if (rm) rm.onclick = () => { l.remove(); calc(); };
    };
    itens.forEach((i) => addLinha(i.insumo_id ? 'i:' + i.insumo_id : 'p:' + i.preparo_id, i.quantidade));
    if (!itens.length && ed) {
      const massa = S.cat.preparos.find((x) => x.codigo === 'PB-01');
      if (massa) addLinha('p:' + massa.id, n(massa.rendimento) / potesPorReceita()); else addLinha();
      ['Pote 220 ml com lacre', 'Colher descartável', 'Etiqueta Good Cake'].forEach((nm) => { const i = S.cat.insumos.find((x) => x.nome === nm); if (i) addLinha('i:' + i.id, 1); });
    }
    d.$('#f-preco').oninput = calc;
    const ba = d.$('#f-add'); if (ba) ba.onclick = () => addLinha();
    calc();
    const bs = d.$('#f-salvar');
    if (bs) bs.onclick = (e) => ocupado(e.currentTarget, async () => {
      const its = d.$$('.item-linha').map((l) => {
        const [t, id] = (l.querySelector('[data-c]').value || ':').split(':');
        return id ? { [t === 'i' ? 'insumo_id' : 'preparo_id']: id, quantidade: n(l.querySelector('[data-q]').value) } : null;
      }).filter((x) => x && x.quantidade > 0);
      await rpc('rpc_salvar_produto', { p: {
        id: p?.id || null, codigo: d.$('#f-cod').value, nome: d.$('#f-nome').value, linha: d.$('#f-linha').value,
        preco_venda: n(d.$('#f-preco').value), montagem: d.$('#f-mont').value, alergenos: d.$('#f-aler').value,
        ativo: d.$('#f-ativo').checked, itens: its } });
      await carregarCatalogo();
      d.fechar(); toast('Ficha técnica salva!', 'ok'); recarregar();
    });
  }

  function fichaPreparo(p) {
    const ed = ehGestor(); const dis = ed ? '' : 'disabled';
    const itens = p ? S.cat.preparoItens.filter((i) => i.preparo_id === p.id).sort((a, b) => (a.sub_preparo_id ? 0 : 1) - (b.sub_preparo_id ? 0 : 1) || n(b.quantidade) - n(a.quantidade)) : [];
    const pr = potesPorReceita();
    const d = abrirModal({
      titulo: p ? `${p.codigo} · ${p.nome}` : 'Novo preparo', classe: 'largo',
      corpo: `
        <div class="linha-campos">
          <div class="campo"><label>Código</label><input type="text" id="g-cod" value="${esc(p?.codigo || '')}" ${dis} placeholder="PB-06"></div>
          <div class="campo" style="grid-column: span 2"><label>Nome</label><input type="text" id="g-nome" value="${esc(p?.nome || '')}" ${dis}></div>
          <div class="campo"><label>Rendimento (g)</label><input type="number" id="g-rend" min="1" step="any" value="${n(p?.rendimento) || ''}" ${dis}><span class="ajuda">peso pronto, pesado na balança</span></div>
        </div>
        <h3>Ingredientes de 1 receita</h3>
        <div class="itens-lista mt" id="g-itens"></div>
        ${ed ? `<div><button type="button" class="btn sec mini mt" id="g-add">${ic('mais')} Adicionar ingrediente</button></div>` : ''}
        <div class="grade k3 mt">
          <div class="kpi"><div class="rotulo">Custo da receita</div><div class="valor" id="k-tot">—</div></div>
          <div class="kpi dourado"><div class="rotulo">Custo por kg</div><div class="valor" id="k-kg">—</div></div>
          <div class="kpi cacau"><div class="rotulo">Por pote (÷${pr})</div><div class="valor" id="k-pote">—</div><div class="det" id="k-pote-g"></div></div>
        </div>
        <div class="campo mt"><label>Modo de preparo</label><textarea id="g-modo" rows="4" ${dis}>${esc(p?.modo_preparo || '')}</textarea></div>
        <label class="check"><input type="checkbox" id="g-ativo" ${p?.ativo === false ? '' : 'checked'} ${dis}> Preparo ativo</label>`,
      rodape: ed ? `<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="g-salvar">Salvar preparo</button>` : '<button class="btn sec" data-fechar>Fechar</button>',
    });
    const calc = () => {
      let tot = 0;
      d.$$('.item-linha').forEach((l) => {
        const v = l.querySelector('[data-c]').value, q = l.querySelector('[data-q]').value;
        const c = custoComp(v.replace(/^s:/, 'p:'), q); tot += c;
        l.querySelector('[data-u]').textContent = unidComp(v) ? `(${unidComp(v)})` : '';
        l.querySelector('[data-custo]').textContent = brl(c);
      });
      const rend = n(d.$('#g-rend').value);
      d.$('#k-tot').textContent = brl(tot);
      d.$('#k-kg').textContent = rend ? brl(tot / rend * 1000) : '—';
      d.$('#k-pote').textContent = brl(tot / pr);
      d.$('#k-pote-g').textContent = rend ? `${qtdFmt(rend / pr, 'g')} por pote` : '';
    };
    const addLinha = (val = '', q = '') => {
      const l = document.createElement('div'); l.className = 'item-linha f4';
      l.innerHTML = `<div class="campo"><label>Ingrediente ou sub-preparo</label><select data-c ${dis}>${opcoesComponente(val, 's', p?.id)}</select></div>
        <div class="campo"><label>Quantidade <span data-u class="muted"></span></label><input type="number" data-q min="0" step="any" value="${q}" ${dis}></div>
        <div class="campo"><label>Custo</label><div data-custo class="num" style="padding:9px 0"></div></div>
        <div>${ed ? `<button type="button" class="icone-btn" data-rm>${ic('lixo')}</button>` : ''}</div>`;
      d.$('#g-itens').appendChild(l);
      l.querySelector('[data-c]').onchange = calc; l.querySelector('[data-q]').oninput = calc;
      const rm = l.querySelector('[data-rm]'); if (rm) rm.onclick = () => { l.remove(); calc(); };
    };
    itens.forEach((i) => addLinha(i.insumo_id ? 'i:' + i.insumo_id : 's:' + i.sub_preparo_id, i.quantidade));
    if (!itens.length && ed) addLinha();
    d.$('#g-rend').oninput = calc;
    const ba = d.$('#g-add'); if (ba) ba.onclick = () => addLinha();
    calc();
    const bs = d.$('#g-salvar');
    if (bs) bs.onclick = (e) => ocupado(e.currentTarget, async () => {
      const its = d.$$('.item-linha').map((l) => {
        const [t, id] = (l.querySelector('[data-c]').value || ':').split(':');
        return id ? { [t === 'i' ? 'insumo_id' : 'sub_preparo_id']: id, quantidade: n(l.querySelector('[data-q]').value) } : null;
      }).filter((x) => x && x.quantidade > 0);
      await rpc('rpc_salvar_preparo', { p: { id: p?.id || null, codigo: d.$('#g-cod').value, nome: d.$('#g-nome').value,
        rendimento: n(d.$('#g-rend').value), modo_preparo: d.$('#g-modo').value, ativo: d.$('#g-ativo').checked, itens: its } });
      await carregarCatalogo();
      d.fechar(); toast('Preparo salvo!', 'ok'); recarregar();
    });
  }

  // ================================================================== CADASTROS
  async function vCadastros(el) {
    S.abaCad = S.abaCad || 'insumos';
    const ed = ehGestor();
    let corpo = '', botao = '';
    if (S.abaCad === 'insumos') {
      botao = ed ? `<button class="btn" id="b-novo">${ic('mais')} Novo insumo</button>` : '';
      corpo = `<div class="card">${tabela(['Insumo', 'Categoria', 'Unid.', '#Embalagem', '#Último preço', '#Mínimo', 'Marca indicada', ''],
        S.cat.insumos.map((i) => `<tr class="clicavel" data-ins="${i.id}"><td><b>${esc(i.nome)}</b>${i.ativo ? '' : ' <span class="badge cinza">inativo</span>'}</td>
          <td>${esc(i.categoria)}</td><td>${esc(i.unidade)}</td><td class="num">${i.embalagem_padrao ? qtdFmt(i.embalagem_padrao, i.unidade) : '—'}</td>
          <td class="num">${custoUnFmt(i.custo_referencia, i.unidade)}${i.embalagem_padrao ? `<div class="small muted">${brl(n(i.custo_referencia) * n(i.embalagem_padrao))}/emb.</div>` : ''}</td>
          <td class="num">${n(i.estoque_minimo) ? qtdFmt(i.estoque_minimo, i.unidade) : '—'}</td><td class="small muted">${esc(i.marca_indicada || '')}</td>
          <td>${ed ? ic('lapis') : ''}</td></tr>`))}</div>`;
    } else if (S.abaCad === 'fornecedores') {
      botao = `<button class="btn" id="b-novo">${ic('mais')} Novo fornecedor</button>`;
      corpo = `<div class="card">${tabela(['Fornecedor', 'Telefone', 'Cidade', 'Obs.', ''],
        S.cat.fornecedores.map((f) => `<tr class="${ed ? 'clicavel' : ''}" data-forn="${f.id}"><td><b>${esc(f.nome)}</b>${f.ativo ? '' : ' <span class="badge cinza">inativo</span>'}</td>
          <td>${f.telefone ? `<a href="${wa(f.telefone)}" target="_blank" rel="noopener">${esc(f.telefone)}</a>` : '—'}</td><td>${esc(f.cidade || '—')}</td>
          <td class="small muted">${esc(f.obs || '')}</td><td>${ed ? ic('lapis') : ''}</td></tr>`), { vazio: 'Nenhum fornecedor cadastrado.' })}</div>`;
    } else {
      corpo = `<div class="grade k2">
        <div class="card"><h2>Parâmetros</h2>
          <div class="campo"><label>Potes por receita padrão</label><input type="number" id="cfg-potes" min="1" step="1" value="${potesPorReceita()}" ${ed ? '' : 'disabled'}><span class="ajuda">1 massa + 1 recheio base = 8 potes de 220 ml</span></div>
          <div class="campo"><label>Meta de CMV (%)</label><input type="number" id="cfg-meta" min="1" max="100" step="1" value="${fmt(metaCmv() * 100)}" ${ed ? '' : 'disabled'}></div>
          <div class="campo"><label>Dia da contagem</label><select id="cfg-dia" ${ed ? '' : 'disabled'}>${['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'].map((x, i) => `<option value="${i}" ${i === n(S.cat.config.dia_contagem ?? 6) ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
          ${ed ? '<button class="btn" id="cfg-salvar">Salvar parâmetros</button>' : ''}</div>
        <div class="card"><h2>Unidades</h2>${S.unidades.map((u) => `
          <div class="campo"><label>${esc(u.slug)}</label><input type="text" data-unome="${u.id}" value="${esc(u.nome)}" ${ed ? '' : 'disabled'}>
            <span class="ajuda">Responsável: <input type="text" data-uresp="${u.id}" value="${esc(u.responsavel || '')}" ${ed ? '' : 'disabled'} style="width:auto;padding:4px 8px"></span></div>`).join('')}
          ${ed ? '<button class="btn" id="un-salvar">Salvar unidades</button>' : ''}</div></div>`;
    }
    el.innerHTML = cabecalho('Cadastros', ed ? 'Insumos, fornecedores e parâmetros do sistema' : 'Somente leitura (fornecedores você pode cadastrar)', botao) + `
      <div class="abas">${[['insumos', 'Insumos'], ['fornecedores', 'Fornecedores'], ['parametros', 'Parâmetros e unidades']].map(([k, t]) => `<button data-aba="${k}" class="${S.abaCad === k ? 'ativo' : ''}">${t}</button>`).join('')}</div>
      ${corpo}`;
    $$('[data-aba]', el).forEach((b) => { b.onclick = () => { S.abaCad = b.dataset.aba; recarregar(); }; });
    const bn = $('#b-novo', el);
    if (bn) bn.onclick = () => (S.abaCad === 'insumos' ? formInsumo(null) : formFornecedor(null, () => recarregar()));
    if (ed) {
      $$('[data-ins]', el).forEach((tr) => { tr.onclick = () => formInsumo(insPorId(tr.dataset.ins)); });
      $$('[data-forn]', el).forEach((tr) => { tr.onclick = () => formFornecedor(fornPorId(tr.dataset.forn), () => recarregar()); });
      const cs = $('#cfg-salvar', el);
      if (cs) cs.onclick = (e) => ocupado(e.currentTarget, async () => {
        const upd = [['potes_por_receita', n($('#cfg-potes').value)], ['meta_cmv', n($('#cfg-meta').value) / 100], ['dia_contagem', n($('#cfg-dia').value)]];
        for (const [chave, valor] of upd) {
          if (!(valor >= 0)) continue;
          await dados(sb.from('config').upsert({ chave, valor }));
        }
        await carregarCatalogo(); toast('Parâmetros salvos.', 'ok'); montarApp();
      });
      const us = $('#un-salvar', el);
      if (us) us.onclick = (e) => ocupado(e.currentTarget, async () => {
        for (const u of S.unidades) {
          await dados(sb.from('unidades').update({ nome: $(`[data-unome="${u.id}"]`).value.trim(), responsavel: $(`[data-uresp="${u.id}"]`).value.trim() }).eq('id', u.id));
        }
        S.unidades = await dados(sb.from('unidades').select('*').eq('ativo', true).order('nome'));
        toast('Unidades salvas.', 'ok'); montarApp();
      });
    }
  }

  function formInsumo(i) {
    const d = abrirModal({
      titulo: i ? i.nome : 'Novo insumo',
      corpo: `
        <div class="linha-campos">
          <div class="campo" style="grid-column: span 2"><label>Nome</label><input type="text" id="i-nome" value="${esc(i?.nome || '')}"></div>
          <div class="campo"><label>Categoria</label><select id="i-cat">${opcoes(['Ingrediente', 'Embalagem', 'Outros'].map((x) => ({ id: x, nome: x })), i?.categoria || 'Ingrediente')}</select></div>
          <div class="campo"><label>Unidade de controle</label><select id="i-un">${opcoes([{ id: 'g', nome: 'gramas (g)' }, { id: 'ml', nome: 'mililitros (ml)' }, { id: 'un', nome: 'unidades (un)' }], i?.unidade || 'g')}</select></div>
        </div>
        <div class="linha-campos">
          <div class="campo"><label>Conteúdo da embalagem <span class="muted" data-u></span></label><input type="number" id="i-emb" min="0" step="any" value="${i?.embalagem_padrao ?? ''}" placeholder="ex.: 395"></div>
          <div class="campo"><label>Preço da embalagem (R$)</label><input type="number" id="i-preco" min="0" step="0.01" value="${i && n(i.embalagem_padrao) ? (n(i.custo_referencia) * n(i.embalagem_padrao)).toFixed(2) : ''}"><span class="ajuda" id="i-custo"></span></div>
          <div class="campo"><label>Estoque mínimo <span class="muted" data-u></span></label><input type="number" id="i-min" min="0" step="any" value="${n(i?.estoque_minimo)}"></div>
        </div>
        <div class="campo"><label>Marca / especificação indicada</label><input type="text" id="i-marca" value="${esc(i?.marca_indicada || '')}"></div>
        <label class="check"><input type="checkbox" id="i-ativo" ${i?.ativo === false ? '' : 'checked'}> Ativo</label>
        <p class="small muted">O preço é atualizado sozinho a cada entrada. Ele serve de referência para as fichas técnicas enquanto não há estoque na unidade.</p>`,
      rodape: `<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="i-salvar">Salvar</button>`,
    });
    const upd = () => {
      const u = d.$('#i-un').value; d.$$('[data-u]').forEach((s) => { s.textContent = `(${u})`; });
      const emb = n(d.$('#i-emb').value), pr = n(d.$('#i-preco').value);
      d.$('#i-custo').textContent = emb && pr ? custoUnFmt(pr / emb, u) : '';
    };
    d.$('#i-un').onchange = upd; d.$('#i-emb').oninput = upd; d.$('#i-preco').oninput = upd; upd();
    d.$('#i-salvar').onclick = (e) => ocupado(e.currentTarget, async () => {
      const emb = n(d.$('#i-emb').value), pr = n(d.$('#i-preco').value);
      const reg = { nome: d.$('#i-nome').value.trim(), categoria: d.$('#i-cat').value, unidade: d.$('#i-un').value,
        embalagem_padrao: emb || null, estoque_minimo: n(d.$('#i-min').value), marca_indicada: d.$('#i-marca').value.trim() || null,
        ativo: d.$('#i-ativo').checked };
      if (emb && pr) reg.custo_referencia = pr / emb;
      if (!reg.nome) throw new Error('Informe o nome.');
      if (i) await dados(sb.from('insumos').update(reg).eq('id', i.id)); else await dados(sb.from('insumos').insert(reg));
      await carregarCatalogo(); d.fechar(); toast('Insumo salvo.', 'ok'); recarregar();
    });
  }

  function formFornecedor(f, depois) {
    const d = abrirModal({
      titulo: f ? f.nome : 'Novo fornecedor', classe: 'estreito',
      corpo: `
        <div class="campo"><label>Nome</label><input type="text" id="o-nome" value="${esc(f?.nome || '')}" placeholder="Ex.: Atacadão Serra"></div>
        <div class="linha-campos">
          <div class="campo"><label>Telefone</label><input type="tel" id="o-tel" value="${esc(f?.telefone || '')}"></div>
          <div class="campo"><label>Cidade</label><input type="text" id="o-cid" value="${esc(f?.cidade || '')}"></div>
        </div>
        <div class="campo"><label>Observação</label><input type="text" id="o-obs" value="${esc(f?.obs || '')}"></div>
        ${f ? `<label class="check"><input type="checkbox" id="o-ativo" ${f.ativo ? 'checked' : ''}> Ativo</label>` : ''}`,
      rodape: `<button class="btn sec" data-fechar>Cancelar</button><button class="btn" id="o-salvar">Salvar</button>`,
    });
    d.$('#o-salvar').onclick = (e) => ocupado(e.currentTarget, async () => {
      const reg = { nome: d.$('#o-nome').value.trim(), telefone: d.$('#o-tel').value.trim() || null, cidade: d.$('#o-cid').value.trim() || null, obs: d.$('#o-obs').value.trim() || null };
      if (!reg.nome) throw new Error('Informe o nome.');
      if (f) { reg.ativo = d.$('#o-ativo').checked; await dados(sb.from('fornecedores').update(reg).eq('id', f.id)); }
      else await dados(sb.from('fornecedores').insert(reg));
      await carregarCatalogo();
      const novo = S.cat.fornecedores.find((x) => x.nome === reg.nome) || {};
      d.fechar(); toast('Fornecedor salvo.', 'ok'); depois && depois(novo);
    });
  }

  // ================================================================== USUÁRIOS
  async function vUsuarios(el) {
    if (!ehGestor()) { el.innerHTML = '<div class="card vazio">Apenas gestores.</div>'; return; }
    const [perfis, membros] = await Promise.all([dados(sb.from('perfis').select('*').order('created_at')), dados(sb.from('membros_unidade').select('*'))]);
    perfis.sort((a, b) => (a.papel === 'pendente' ? -1 : 0) - (b.papel === 'pendente' ? -1 : 0));
    S.pendentes = perfis.filter((p) => p.papel === 'pendente').length;
    el.innerHTML = cabecalho('Usuários', 'Libere acessos e escolha as unidades de cada operador. Gestores acessam todas as unidades.') + `
      <div class="aviso small"><span>Para criar um acesso, a pessoa entra no sistema e clica em <b>Criar acesso</b>. Depois ela aparece aqui como <b>pendente</b>.</span></div>
      <div class="card mt">${tabela(['Nome', 'Papel', 'Unidades', 'Ativo', ''],
        perfis.map((p) => {
          const meu = p.id === S.user.id;
          return `<tr data-u="${p.id}"><td><b>${esc(p.nome)}</b>${meu ? ' <span class="badge cacau">você</span>' : ''}<div class="small muted">${esc(p.email || '')}</div></td>
            <td><select data-papel ${meu ? 'disabled' : ''}>${opcoes([{ id: 'pendente', nome: 'Pendente' }, { id: 'operador', nome: 'Operador' }, { id: 'gestor', nome: 'Gestor' }], p.papel)}</select></td>
            <td>${S.unidades.map((u) => `<label class="check small"><input type="checkbox" data-un="${u.id}" ${membros.some((m) => m.user_id === p.id && m.unidade_id === u.id) ? 'checked' : ''}> ${esc(nomeCurto(u))}</label>`).join('')}</td>
            <td><input type="checkbox" data-ativo ${p.ativo ? 'checked' : ''} ${meu ? 'disabled' : ''} style="width:18px;height:18px;accent-color:var(--rosa)"></td>
            <td><button class="btn mini" data-salvar>Salvar</button></td></tr>`;
        }))}</div>`;
    $$('[data-salvar]', el).forEach((b) => {
      b.onclick = () => ocupado(b, async () => {
        const tr = b.closest('tr'); const id = tr.dataset.u;
        if (id !== S.user.id) await dados(sb.from('perfis').update({ papel: $('[data-papel]', tr).value, ativo: $('[data-ativo]', tr).checked }).eq('id', id));
        const marc = $$('[data-un]', tr).filter((c) => c.checked).map((c) => c.dataset.un);
        await dados(sb.from('membros_unidade').delete().eq('user_id', id));
        if (marc.length) await dados(sb.from('membros_unidade').insert(marc.map((unidade_id) => ({ user_id: id, unidade_id }))));
        toast('Usuário atualizado.', 'ok');
        await contarPendentes(); montarApp();
      });
    });
  }

  const VIEWS = { painel: vPainel, vendas: vVendas, reservas: vReservas, producao: vProducao, contagem: vContagem, estoque: vEstoque,
    entradas: vEntradas, transferencias: vTransferencias, fichas: vFichas, cadastros: vCadastros, usuarios: vUsuarios };

  // ------------------------------------------------------------------ início
  window.addEventListener('hashchange', () => { if ($('#conteudo')) renderRota(); });
  if (!sb) { telaConfig(); return; }
  sb.auth.onAuthStateChange((evento) => {
    if (evento === 'PASSWORD_RECOVERY') { telaAuth('nova'); return; }
    if (evento === 'SIGNED_IN' && !$('#conteudo')) iniciarSessao();
    if (evento === 'SIGNED_OUT') { S.user = null; S.perfil = null; telaAuth(); }
  });
  iniciarSessao();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
