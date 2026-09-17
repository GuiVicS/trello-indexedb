-- ============================================================================
-- Tarefas App — schema do modo Cloud
-- Rode este arquivo inteiro uma vez no SQL Editor do seu projeto Supabase
-- (Painel > SQL Editor > New query > cole tudo > Run).
-- ============================================================================

-- ---------- perfis (dados cadastrais do usuário) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  phone text,
  cpf text,
  is_superadmin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: usuário vê e edita o próprio perfil"
  on public.profiles for select using (auth.uid() = id);
create policy "profiles: usuário atualiza o próprio perfil"
  on public.profiles for update using (auth.uid() = id);
create policy "profiles: usuário cria o próprio perfil"
  on public.profiles for insert with check (auth.uid() = id);

-- cria o perfil automaticamente quando alguém se cadastra
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, email, phone, cpf)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', ''),
    new.email,
    new.raw_user_meta_data->>'phone',
    new.raw_user_meta_data->>'cpf'
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- assinaturas (espelho do status do Stripe) ----------
-- Só as funções serverless (service role) escrevem aqui — o webhook do Stripe é a
-- fonte da verdade. O usuário só tem permissão de leitura sobre a própria linha.
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  -- referencia profiles (não auth.users) para permitir o embed profiles:user_id(...)
  -- usado pela tela de superadmin; profiles.id já é 1:1 com auth.users.id.
  user_id uuid not null references public.profiles(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'inactive', -- inactive | trialing | active | past_due | canceled
  price_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

create policy "subscriptions: usuário vê a própria assinatura"
  on public.subscriptions for select using (auth.uid() = user_id);
-- sem policy de insert/update/delete para o usuário: só a service role (via /api) escreve.

create index if not exists subscriptions_user_id_idx on public.subscriptions(user_id);

-- ---------- espaços de trabalho (equivalente ao "workspaces" do IndexedDB) ----------
create table if not exists public.cloud_workspaces (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  labels jsonb not null default '[]',
  statuses jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cloud_workspaces enable row level security;

create policy "cloud_workspaces: dono tem acesso total"
  on public.cloud_workspaces for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- tarefas ----------
create table if not exists public.cloud_tasks (
  id text primary key,
  workspace_id text not null references public.cloud_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  status text not null default 'todo',
  priority text not null default 'none',
  due_date text,
  tags jsonb not null default '[]',
  content jsonb not null default '[]',
  checklist jsonb not null default '[]',
  attachments jsonb not null default '[]', -- metadados; arquivos ficam no Storage
  activity jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cloud_tasks enable row level security;

create policy "cloud_tasks: dono tem acesso total"
  on public.cloud_tasks for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists cloud_tasks_workspace_id_idx on public.cloud_tasks(workspace_id);
create index if not exists cloud_tasks_user_id_idx on public.cloud_tasks(user_id);

-- ---------- Storage: anexos ----------
-- Crie manualmente um bucket chamado "attachments" em Storage > New bucket (privado,
-- não público), depois rode as policies abaixo.
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

create policy "attachments: dono lê seus arquivos"
  on storage.objects for select
  using (bucket_id = 'attachments' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "attachments: dono envia seus arquivos"
  on storage.objects for insert
  with check (bucket_id = 'attachments' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "attachments: dono apaga seus arquivos"
  on storage.objects for delete
  using (bucket_id = 'attachments' and auth.uid()::text = (storage.foldername(name))[1]);

-- ---------- para virar superadmin ----------
-- Depois de criar sua própria conta pelo app, rode (trocando o e-mail):
-- update public.profiles set is_superadmin = true where email = 'voce@seudominio.com';
