-- Seed da Etapa 1. Códigos IBGE conferidos; lat/lng = sede do município (aprox.).
insert into cities (id, name, uf, lat, lng) values
  (2910800, 'Feira de Santana', 'BA', -12.266700, -38.966700),
  (2900702, 'Alagoinhas',       'BA', -12.135600, -38.419000),
  (2927408, 'Salvador',         'BA', -12.971400, -38.501400),
  (2907509, 'Catu',             'BA', -12.351300, -38.379100)
on conflict (id) do update set name = excluded.name, uf = excluded.uf, lat = excluded.lat, lng = excluded.lng;

insert into city_source_ids (city_id, source, source_slug) values
  (2910800, 'clickbus', 'feira-de-santana-todos'),
  (2900702, 'clickbus', 'alagoinhas-ba'),
  (2927408, 'clickbus', 'salvador-ba'),
  (2907509, 'clickbus', 'catu-ba'),
  -- Fase 5 (Quero Passagem): Catu e Alagoinhas sem "-ba".
  (2910800, 'queropassagem', 'feira-de-santana-ba'),
  (2900702, 'queropassagem', 'alagoinhas'),
  (2927408, 'queropassagem', 'salvador-ba'),
  (2907509, 'queropassagem', 'catu')
on conflict (city_id, source) do update set source_slug = excluded.source_slug;

insert into route_hubs (origin_city_id, dest_city_id, hub_city_id) values
  (2910800, 2907509, 2900702),  -- Feira → Catu via Alagoinhas
  (2910800, 2907509, 2927408),  -- Feira → Catu via Salvador
  (2907509, 2910800, 2900702),  -- Catu → Feira via Alagoinhas
  (2907509, 2910800, 2927408)   -- Catu → Feira via Salvador
on conflict do nothing;
