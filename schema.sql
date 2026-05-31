-- Run in Supabase SQL editor: https://supabase.com/dashboard → SQL Editor

create table if not exists abandoned_leads (
  id                   uuid default gen_random_uuid() primary key,
  session_id           text unique not null,
  business_name        text,
  business_url         text,
  name                 text,
  email                text,
  phone                text,
  status               text default 'started'
                       check (status in ('started','abandoned','completed','recovered')),
  reminder_1h_sent_at  timestamptz,
  reminder_24h_sent_at timestamptz,
  reminder_3d_sent_at  timestamptz,
  unsubscribed         boolean default false,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create or replace function update_updated_at_column()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists set_updated_at on abandoned_leads;
create trigger set_updated_at
  before update on abandoned_leads
  for each row execute procedure update_updated_at_column();

create index if not exists al_status_idx     on abandoned_leads(status);
create index if not exists al_created_idx    on abandoned_leads(created_at desc);
create index if not exists al_session_idx    on abandoned_leads(session_id);
