-- Strojově čitelný typ činnosti pro kompaktní ikonové mobilní UI.
alter table public.cleaning_tasks
  add column if not exists activity_type text not null default 'other';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'cleaning_tasks_activity_type_valid'
      and conrelid = 'public.cleaning_tasks'::regclass
  ) then
    alter table public.cleaning_tasks
      add constraint cleaning_tasks_activity_type_valid
      check (activity_type in (
        'trash', 'toilet', 'sink', 'mirror', 'vacuum', 'mop',
        'disinfect', 'tables', 'windows', 'laundry', 'other'
      ));
  end if;
end $$;

-- Jednorázové explicitní zařazení současného schváleného plánu.
-- Frontend české názvy neparsuje; po migraci čte pouze activity_type.
update public.cleaning_tasks set activity_type = 'trash'
where name = 'Vynést koše';

update public.cleaning_tasks set activity_type = 'toilet'
where name = 'Vyčistit WC a splachovadla';

update public.cleaning_tasks set activity_type = 'sink'
where name = 'Vyčistit umyvadla, baterie a zrcadla';

update public.cleaning_tasks set activity_type = 'mirror'
where name = 'Vyčistit zrcadla';

update public.cleaning_tasks set activity_type = 'vacuum'
where name in (
  'Zamést / vysát chodbu',
  'Zamést / vysát podlahu',
  'Zamést / vysát schody'
);

update public.cleaning_tasks set activity_type = 'mop'
where name in ('Vytřít chodbu', 'Vytřít podlahu', 'Vytřít schody');

update public.cleaning_tasks set activity_type = 'disinfect'
where name in (
  'Dezinfikovat kliky a vypínače',
  'Dezinfikovat kliky, vypínače, baterie a splachovadla'
);

update public.cleaning_tasks set activity_type = 'tables'
where name = 'Otřít stoly';

update public.cleaning_tasks set activity_type = 'windows'
where name like 'Mytí oken – část %';

comment on column public.cleaning_tasks.activity_type is
  'Strojově čitelný typ činnosti pro volbu ikony; UI nesmí typ odvozovat z názvu.';
