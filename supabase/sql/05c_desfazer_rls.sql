-- Secretária Virtual — DESFAZER o 05b (emergência: se o app parar de mostrar os dados)
-- Remove só as políticas "sv_*" das tabelas do app e desliga o RLS nas tabelas com user_id.
-- A política sv_profiles_select (leitura do próprio perfil no login) é MANTIDA de propósito:
-- sem ela a tela de login mostra "Conta não encontrada".
-- ATENÇÃO: deixa as tabelas sem proteção até você rodar o 05b de novo.
do $$
declare r record; p record;
begin
  for p in select tablename, policyname from pg_policies
            where schemaname = 'public' and policyname like 'sv\_%'
              and policyname <> 'sv_profiles_select'
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;

  for r in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = 'public' and c.column_name = 'user_id'
       and c.table_name not in ('licenses', 'license_devices', 'profiles', 'sv_table_module')
  loop
    execute format('alter table public.%I disable row level security', r.table_name);
  end loop;
end $$;
-- profiles: o 05b apagou as políticas antigas dessa tabela. Se o login parar de funcionar,
-- recrie a leitura do próprio perfil:
--   create policy sv_profiles_select on public.profiles for select to authenticated
--     using ((select auth.uid()) = id or (select public.is_sv_admin()));
