insert into public.shirt_inventory (shirt_type, shirt_size, total_quantity, reserved_quantity, delivered_quantity)
select v.shirt_type, v.shirt_size, v.total_quantity, 0, 0
from (values
  ('Camiseta', 'PP', 20),
  ('Camiseta', 'P', 20),
  ('Camiseta', 'M', 20),
  ('Camiseta', 'G', 20),
  ('Camiseta', 'GG', 20),
  ('Camiseta', 'EG', 20),
  ('Camiseta', 'EXG', 20),
  ('Camiseta', 'EXGG', 20),
  ('Babylook', 'PP', 20),
  ('Babylook', 'P', 20),
  ('Babylook', 'M', 20),
  ('Babylook', 'G', 20),
  ('Babylook', 'GG', 20),
  ('Babylook', 'EG', 20)
) as v(shirt_type, shirt_size, total_quantity)
where not exists (
  select 1
  from public.shirt_inventory existing
  where existing.event_id is null
    and existing.shirt_type = v.shirt_type
    and existing.shirt_size = v.shirt_size
);
