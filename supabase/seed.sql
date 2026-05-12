-- Optional dev seed. Run manually after signing up at least one user.
-- Usage:
--   1) Find your user's id: select id from auth.users limit 1;
--   2) Replace :user_id below and paste into Supabase SQL editor.
-- Intentionally minimal — most seed data comes from real uploads.

-- Example:
-- insert into nodes (workspace_id, type, title, content)
-- select id, 'note', 'Welcome', 'This is your first memory node.'
-- from workspaces where owner_id = ':user_id';
