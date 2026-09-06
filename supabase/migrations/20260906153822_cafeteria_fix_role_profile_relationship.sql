alter table public.user_module_roles
  drop constraint if exists user_module_roles_created_by_fkey;

alter table public.user_module_roles
  add constraint user_module_roles_created_by_auth_user_fkey
  foreign key (created_by)
  references auth.users(id)
  on delete set null;
