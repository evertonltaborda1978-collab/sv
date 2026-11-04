-- =====================================================================
-- Secretária Virtual — RLS da tabela family_links (vínculo com familiares)
-- Rode no SQL Editor do Supabase: New query > cole tudo > Run.
-- Pré-requisito: ter rodado 01, 03, 04 e 05b. Pode rodar mais de uma vez.
--
-- Estrutura da tabela (já existe): owner_id (quem compartilha), viewer_id (familiar que vê),
-- status (pending/accepted/declined), owner_label, viewer_label, responded_at.
--
-- Regras:
--   * LER: só os dois participantes (dono e familiar), e só com licença ativa.
--   * ESCREVER direto na tabela: ninguém pelo app (nem criar, nem mudar, nem apagar).
--     Isso impede o usuário de se "aceitar" sozinho no lugar do familiar, de trocar
--     o owner_id/viewer_id ou de criar vínculo com quem não quer.
--   * Todas as mudanças passam por funções seguras abaixo:
--       - admin_create_family_link  : só o administrador marca "familiar" (cria como pendente)
--       - respond_family_link       : só o familiar (viewer) aceita ou recusa o convite
--       - stop_family_link          : dono OU familiar podem parar o compartilhamento quando quiser
--       - admin_list_family_links / admin_delete_family_link : painel de administração
-- =====================================================================

alter table public.family_links enable row level security;

-- Troca a política antiga de leitura pela versão que também exige licença ativa
drop policy if exists family_links_select_participant on public.family_links;
drop policy if exists sv_family_links_select          on public.family_links;

create policy sv_family_links_select on public.family_links
  for select to authenticated
  using (
    ((select auth.uid()) = owner_id or (select auth.uid()) = viewer_id)
    and (select public.sv_license_active())
  );

-- Índices para as consultas por dono e por familiar (a UNIQUE já cobre owner_id + viewer_id)
create index if not exists sv_family_links_viewer_idx on public.family_links (viewer_id);

-- ---------------------------------------------------------------------
-- Administrador cria o vínculo (fica "pending" até o familiar aceitar no app dele)
-- ---------------------------------------------------------------------
create or replace function public.admin_create_family_link(
  p_owner uuid, p_viewer uuid, p_owner_label text default '', p_viewer_label text default '')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_sv_admin() then
    raise exception 'Acesso negado';
  end if;
  if p_owner is null or p_viewer is null or p_owner = p_viewer then
    raise exception 'Escolha duas pessoas diferentes';
  end if;

  insert into public.family_links (owner_id, viewer_id, owner_label, viewer_label)
  values (p_owner, p_viewer, coalesce(p_owner_label, ''), coalesce(p_viewer_label, ''))
  on conflict (owner_id, viewer_id) do update
     set status = 'pending', responded_at = null,
         owner_label = excluded.owner_label, viewer_label = excluded.viewer_label
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Só o familiar (viewer) responde ao convite
-- ---------------------------------------------------------------------
create or replace function public.respond_family_link(p_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.sv_license_active() then
    raise exception 'Acesso negado';
  end if;

  update public.family_links
     set status = case when p_accept then 'accepted' else 'declined' end,
         responded_at = now()
   where id = p_id and viewer_id = auth.uid() and status = 'pending';

  if not found then
    raise exception 'Convite não encontrado ou já respondido';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Dono OU familiar param o compartilhamento quando quiserem (remove o vínculo)
-- ---------------------------------------------------------------------
create or replace function public.stop_family_link(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Acesso negado';
  end if;

  delete from public.family_links
   where id = p_id and (owner_id = auth.uid() or viewer_id = auth.uid());

  if not found then
    raise exception 'Vínculo não encontrado';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Painel de administração: listar e remover vínculos (mostra os e-mails)
-- ---------------------------------------------------------------------
create or replace function public.admin_list_family_links()
returns table (
  id uuid, owner_id uuid, owner_email text, owner_label text,
  viewer_id uuid, viewer_email text, viewer_label text,
  status text, created_at timestamptz, responded_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_sv_admin() then
    raise exception 'Acesso negado';
  end if;

  return query
    select f.id, f.owner_id, o.email::text, f.owner_label,
           f.viewer_id, v.email::text, f.viewer_label,
           f.status, f.created_at, f.responded_at
      from public.family_links f
      left join auth.users o on o.id = f.owner_id
      left join auth.users v on v.id = f.viewer_id
     order by f.created_at desc;
end;
$$;

create or replace function public.admin_delete_family_link(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_sv_admin() then
    raise exception 'Acesso negado';
  end if;
  delete from public.family_links where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Auxiliar para o futuro: "o usuário logado é familiar ACEITO deste dono?"
-- Use dentro de políticas de outras tabelas quando quiser deixar o familiar VER dados do dono.
-- (Ainda não aplicado em nenhuma tabela: o familiar não vê nada além do próprio vínculo.)
-- ---------------------------------------------------------------------
create or replace function public.sv_is_family_viewer_of(p_owner uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.family_links f
     where f.owner_id = p_owner
       and f.viewer_id = auth.uid()
       and f.status = 'accepted')
  and public.sv_license_active();
$$;

-- ---------------------------------------------------------------------
-- Permissões das funções
-- ---------------------------------------------------------------------
revoke all on function public.admin_create_family_link(uuid, uuid, text, text) from public, anon;
revoke all on function public.respond_family_link(uuid, boolean)               from public, anon;
revoke all on function public.stop_family_link(uuid)                           from public, anon;
revoke all on function public.admin_list_family_links()                        from public, anon;
revoke all on function public.admin_delete_family_link(uuid)                   from public, anon;
revoke all on function public.sv_is_family_viewer_of(uuid)                     from public, anon;

grant execute on function public.admin_create_family_link(uuid, uuid, text, text) to authenticated;
grant execute on function public.respond_family_link(uuid, boolean)               to authenticated;
grant execute on function public.stop_family_link(uuid)                           to authenticated;
grant execute on function public.admin_list_family_links()                        to authenticated;
grant execute on function public.admin_delete_family_link(uuid)                   to authenticated;
grant execute on function public.sv_is_family_viewer_of(uuid)                     to authenticated;

-- Conferência: políticas da tabela depois do script (deve haver só sv_family_links_select)
select policyname as politica, cmd as operacao from pg_policies
 where schemaname = 'public' and tablename = 'family_links';
