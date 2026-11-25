-- RaceLog Phase 0b: one table for the sync test.
-- Paste this whole file into the Supabase SQL Editor and run it once.

create table if not exists public.p0b_entries (
  id          text primary key,                 -- made on the phone, so a retry can never create a second row
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  device_id   text not null,
  text        text not null,
  created_at  timestamptz not null,             -- phone time when the entry was saved
  received_at timestamptz not null default now()  -- server time when it arrived
);

alter table public.p0b_entries enable row level security;

-- Each signed-in user can read and add their own rows. There is no update or delete rule,
-- so the app cannot change or remove a saved entry (the same idea as RaceLog's history rows).
drop policy if exists "own rows read" on public.p0b_entries;
create policy "own rows read" on public.p0b_entries
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "own rows add" on public.p0b_entries;
create policy "own rows add" on public.p0b_entries
  for insert to authenticated with check (user_id = (select auth.uid()));

grant select, insert on public.p0b_entries to authenticated;
