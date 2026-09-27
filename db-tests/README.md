# Testes do banco (PGlite)

Aplica `supabase/migrations/*.sql` + `supabase/seed.sql` num Postgres em memória
(PGlite) e testa `record_leg_result`, `find_connections`, `find_second_legs`, o trigger
de `price_history` e as permissões/RLS. **Não toca no banco de produção.**

```bash
cd db-tests && npm install && npm test
```

`test/db.ts` imita o que o Supabase já traz (papéis `anon`/`authenticated`/`service_role`,
schema `auth`, `auth.uid()` e grants padrão). Horários dos dados de teste são locais
(America/Bahia) e convertidos pela mesma função do coletor.
