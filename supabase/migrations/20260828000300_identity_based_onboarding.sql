-- Google display name is presentation-only. Authorization always uses auth.users.id.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    'cleaner'
  )
  on conflict (id) do nothing;

  -- A caretaker assigns work parts and rotation orders later by profile id.
  -- Never derive roles, assignments, or permissions from a Google display name.
  return new;
end;
$$;
