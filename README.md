# Good Cake · Gestão

Sistema de gestão das unidades **GoodCake - Cachoeiro de Itapemirim** (Analanda) e **GoodCake - Grande Vitória** (Vinicius).

O sistema tem:

- **Vendas**: sabores, canal, pagamento, desconto e cancelamento.
- **Reservas de sabores**: mostra o que falta produzir e vira venda na entrega.
- **Produção**: baixa os insumos pela ficha técnica e calcula o rendimento contra o padrão de **8 potes por receita**.
- **Estoque**: potes, insumos e extrato.
- **Entradas**: data, quantidade, fornecedor, preço e validade.
- **Transferências entre unidades**.
- **Perdas**.
- **Contagem semanal (sábado de manhã)**: calcula o CMV real.
- **Fichas técnicas**: CMV teórico automático e histórico de preço.
- **Cadastros** e **usuários**.

Tecnologia: uma página web estática (HTML/CSS/JS, sem build) e Supabase (Postgres com RLS). É instalável no celular como app (PWA).

---

## Onde está

- **Site:** https://goodcake-es.github.io/gestao/
- **Código:** https://github.com/goodcake-es/gestao (GitHub Pages, branch `main`)
- **Banco:** Supabase, organização *Good Cake*, projeto `goodcake-gestao` (São Paulo). O `schema.sql` já foi aplicado.

A chave anon no `config.js` é pública por natureza. Quem protege os dados são as regras RLS do banco: sem login liberado por um gestor, ninguém lê nem grava nada.

## Primeiros acessos

Ninguém cria login sozinho: o cadastro público está **desligado** no Supabase. Todo acesso passa pelo gestor.

1. O Vinicius já foi convidado (viniciuscandidosant@gmail.com). Ele abre o e-mail do convite, clica no link, cria a senha e entra como **Gestor**.
2. Para dar acesso a alguém (a Analanda, por exemplo): no app, **Usuários → Convidar pessoa**. Isso abre o Supabase em **Authentication → Users → Add user → Send invitation**. Coloque o e-mail da pessoa.
3. A pessoa recebe o convite, cria a senha e aparece em **Usuários** como **pendente**, sem acesso a nada.
4. O gestor escolhe o papel (Gestor ou Operador), marca as unidades e clica em **Salvar**.

Gestores acessam as duas unidades e fazem tudo. Para alguém que só opera uma unidade (ajudante, por exemplo), use **Operador** e marque a unidade. O operador:

- vê só a unidade marcada;
- não altera fichas técnicas, preços nem cadastros;
- não estorna entradas.

## Rotina

| Quando | O quê |
|---|---|
| Cada compra | **Entradas → Nova entrada**: insumo, nº de embalagens, conteúdo, valor total, validade. O custo médio se atualiza sozinho. |
| Cada produção | **Produção**: quantas receitas e quantos potes de cada sabor. Os insumos saem do estoque pela ficha técnica, e o rendimento é comparado com 8 potes/receita. |
| Cada venda | **Vendas → Nova venda**. Reservas viram venda no botão **Entregar**. |
| Sábado de manhã | **Contagem semanal → Abrir contagem**: conte, feche e veja o **CMV real**. A primeira contagem só serve de ponto de partida. |
| Quando quiser | **Fichas técnicas**: simule preço e veja CMV, margem e o preço que atinge a meta (35%, ajustável em Cadastros → Parâmetros). |

### Como o CMV é calculado

- **CMV teórico** (Painel e Fichas): custo da ficha técnica do que foi vendido ÷ faturamento.
- **CMV real** (Contagem): estoque inicial + compras (± transferências) − estoque final contado, ÷ faturamento do período.
- O custo de cada insumo é o **custo médio** da unidade. Sem estoque, vale o último preço de compra.

## Estrutura

```
index.html, styles.css, app.js   o app
config.js                        URL e chave do Supabase
manifest.json, sw.js, *.png      app instalável, logo e ícones
schema.sql                       banco completo (rodar uma vez)
```

Para mudanças futuras no banco, crie arquivos novos (ex.: `002_ajuste.sql`) e rode no SQL Editor. Não rode o `schema.sql` de novo num banco que já tem dados.
