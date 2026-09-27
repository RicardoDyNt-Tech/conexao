# App (Fase 4) — PWA

React + Vite + TypeScript + supabase-js (**anon key + RLS**, sem backend novo). Mobile-first,
tema claro/escuro automático, horários sempre em America/Bahia.

Lê o banco só via RPC (`find_connections`, `find_second_legs`, `date_coverage`,
`collector_status`, `request_collect`) e selects simples (`route_hubs`, `cities`, `trips`,
`collect_requests`). O cruzamento de horários fica no SQL.

## Rodar local

```powershell
cd C:\dev\conexao\web
copy .env.example .env.local      # e preencha VITE_SUPABASE_ANON_KEY
npm ci
npm run dev                       # http://localhost:5173
npm test                          # Vitest + Testing Library, sem rede
```

A chave vem de Supabase → Project Settings → API Keys: a **anon** (ou "publishable",
`sb_publishable_…`). Nunca a `service_role`/secret.

Datas no passado não aparecem no seletor (só datas futuras), mas dá para abrir pelo endereço:
`http://localhost:5173/#/r?o=2910800&d=2907509&date=2026-09-29`.

## Supabase (uma vez)

1. **Migration nova** (`20261001000100_app_status.sql`): `npx supabase@latest db push`.
   Precisa estar aplicada antes de usar o app **e** antes de rodar o coletor de novo.
2. **Authentication → Sign In / Providers**: Email ligado; **"Allow new users to sign up" desligado**.
3. **Authentication → URL Configuration** (troque `conexao` pelo nome do projeto no Pages):
   - Site URL: `https://conexao.pages.dev`
   - Redirect URLs:
     - `https://conexao.pages.dev/**`
     - `https://*.conexao.pages.dev/**` (deploys de preview)
     - `http://localhost:5173/**` (desenvolvimento)
4. **Usuários**: Authentication → Users → **Add user → Create new user**, com o e-mail e
   **Auto Confirm User** marcado (não envia e-mail). Faça para você e para a Caroline.
   Depois cada um entra pelo app com o link mágico.
5. **Entrega do e-mail (importante)**: sem SMTP próprio, o Supabase **só envia e-mail para
   membros da equipe da organização** (e poucos por hora). Duas saídas:
   - Convidar a Caroline em Organization → **Team** (ela passa a ver o painel do Supabase); ou
   - Configurar SMTP próprio em Authentication → **Emails → SMTP Settings** (ex.: Brevo grátis,
     com remetente verificado).
   Sem isso, o login dela mostra "O Supabase recusou enviar para esse e-mail".

## Deploy (Cloudflare Pages)

Workers & Pages → Create → Pages → **Connect to Git** → `ricardodynt-tech/conexao`.

| Campo | Valor |
|---|---|
| Production branch | a branch que você quer publicar (ex.: `main`, depois do merge) |
| Framework preset | None |
| Root directory (advanced) | `web` |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` (= `web/dist`) |
| Variáveis (Production e Preview) | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `NODE_VERSION=22` |

As variáveis `VITE_*` entram no JavaScript público; por isso só a anon key. Rotas usam `#`
(`/#/r?...`), então não precisa de regra de redirect. `public/_headers` impede cache do
service worker.

## Instalar no Android

1. Abra `https://conexao.pages.dev` no **Chrome** do celular.
2. Entre com o e-mail; abra o e-mail **no mesmo celular** e toque no link.
3. Menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial"). O app instalado usa o mesmo login.

## PWA

- `public/manifest.webmanifest`: nome "Conexão", ícones 192/512 + maskable, cor `#0f766e`.
- `public/sw.js`: guarda só o app shell (HTML/JS/CSS/ícones). **Não guarda dados**: pedidos ao
  Supabase (outro domínio) nem passam pelo service worker. Registrado só no build de produção.
