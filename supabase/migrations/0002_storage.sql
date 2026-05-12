-- ============================================================================
-- Storage bucket for ingested files.
--
-- Path convention: <user_id>/<node_id>/<filename>
-- The first folder segment is the user's UUID; storage RLS pins it to auth.uid().
-- Service role (used by FastAPI for downloads) bypasses these policies.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false)
on conflict (id) do nothing;

create policy "users read own uploads"
  on storage.objects for select
  using (
    bucket_id = 'uploads'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "users insert own uploads"
  on storage.objects for insert
  with check (
    bucket_id = 'uploads'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "users delete own uploads"
  on storage.objects for delete
  using (
    bucket_id = 'uploads'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
