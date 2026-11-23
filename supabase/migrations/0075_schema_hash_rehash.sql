-- 0075: re-hash stored model schemas (self-hosted upgrade, phase 3).
--
-- Until now computeSchemaHash (lib/schema/modelService.ts) passed the schema's top-level keys as
-- JSON.stringify's replacer. A replacer array filters keys at every depth, so every field serialised
-- as {} and the hash ignored field contents: two versions of a model with the same number of fields
-- had the same hash. The app now hashes the canonical JSON of the whole schema (keys sorted at every
-- depth by UTF-8 bytes, no whitespace, numbers written as JavaScript writes them;
-- lib/schema/engine/hash.ts).
--
-- Stored hashes are compared with freshly computed ones (migration assessments, schema deployment),
-- so this migration re-hashes every stored version with the SQL twin of the new function and rewrites
-- the copies of each version's hash in deployments, assessments and environments. A version holding a
-- number this function cannot reproduce exactly (from 1e308, or nonzero below 1e-307) keeps its
-- old hash, which still matches its own copies; the migration reports how many, as a NOTICE.
--
-- Not rewritten: hashes inside operational change plan nodes (input_json.schemaHash). A plan made
-- before this migration reports that it was built before an update and must be planned again.
--
-- Migration 0074 (phase 3 wave 2) may be applied after this one; both are independent.

-- The canonical JSON text of a jsonb value, identical to canonicalJson(JSON.parse(stored)) in
-- lib/schema/engine/hash.ts, which is what the app computes for a schema it reads back. Returns null
-- when it cannot guarantee that.
create or replace function public.polynovea_canonical_json(value jsonb)
returns text
language plpgsql
immutable
strict
set search_path = ''
set extra_float_digits = 1
as $$
declare
  has_null boolean;
  body text;
  num numeric;
  t text;
  negative boolean;
  mantissa text;
  exponent integer;
  int_part text;
  digits text;
  lead integer;
  n integer;
  k integer;
  e integer;
  result text;
begin
  case pg_catalog.jsonb_typeof(value)
    when 'object' then
      select pg_catalog.bool_or(s.c is null),
             pg_catalog.string_agg(pg_catalog.to_json(s.k)::text || ':' || s.c, ',' order by s.k collate "C")
        into has_null, body
        from (select e.key as k, public.polynovea_canonical_json(e.val) as c from pg_catalog.jsonb_each(value) as e(key, val)) s;
      if has_null then return null; end if;
      return '{' || coalesce(body, '') || '}';
    when 'array' then
      select pg_catalog.bool_or(s.c is null), pg_catalog.string_agg(s.c, ',' order by s.ord)
        into has_null, body
        from (select a.ord, public.polynovea_canonical_json(a.elem) as c
              from pg_catalog.jsonb_array_elements(value) with ordinality as a(elem, ord)) s;
      if has_null then return null; end if;
      return '[' || coalesce(body, '') || ']';
    when 'string' then
      return pg_catalog.to_json(value #>> '{}')::text;
    when 'boolean' then
      return value::text;
    when 'null' then
      return 'null';
    when 'number' then
      -- The app reads numbers as JavaScript doubles, so: round to the nearest double, take its shortest
      -- round-trip digits (float8 output with extra_float_digits = 1), and lay them out with
      -- JavaScript's Number-to-string rules.
      num := (value #>> '{}')::numeric;
      if num = 0 then return '0'; end if;
      -- Beyond the double range (or in its subnormal tail) JavaScript gives Infinity or loses digits.
      if abs(num) >= 1e308 or abs(num) < 1e-307 then return null; end if;
      t := (num::double precision)::text;
      negative := left(t, 1) = '-';
      if negative then t := substr(t, 2); end if;
      if position('e' in t) > 0 then
        mantissa := split_part(t, 'e', 1);
        exponent := split_part(t, 'e', 2)::integer;
      else
        mantissa := t;
        exponent := 0;
      end if;
      int_part := split_part(mantissa, '.', 1);
      digits := int_part || split_part(mantissa, '.', 2);
      n := length(int_part) + exponent;            -- value = 0.<digits> x 10^n
      lead := length(digits) - length(ltrim(digits, '0'));
      digits := rtrim(ltrim(digits, '0'), '0');
      n := n - lead;
      k := length(digits);
      if k <= n and n <= 21 then
        result := digits || repeat('0', n - k);
      elsif 0 < n and n <= 21 then
        result := left(digits, n) || '.' || substr(digits, n + 1);
      elsif -6 < n and n <= 0 then
        result := '0.' || repeat('0', -n) || digits;
      else
        e := n - 1;
        result := left(digits, 1) || case when k > 1 then '.' || substr(digits, 2) else '' end
          || 'e' || case when e >= 0 then '+' else '-' end || abs(e)::text;
      end if;
      return case when negative then '-' || result else result end;
    else
      return null;
  end case;
end;
$$;

comment on function public.polynovea_canonical_json(jsonb) is
  'Canonical JSON text (keys sorted by UTF-8 bytes, no whitespace, JavaScript number form) matching canonicalJson() in lib/schema/engine/hash.ts; null when it cannot match exactly.';

-- rehash:start
-- No temporary table: the owner role may not have TEMP on the database. A helper function lists each
-- version's old and new hash; it is dropped at the end. Copies are rewritten first (they match on the
-- old hash), the versions themselves last.
create function public.polynovea_schema_rehash_map()
returns table (content_model_id uuid, version_number integer, old_hash text, new_hash text)
language sql
stable
set search_path = ''
as $$
  select v.content_model_id, v.version_number, v.schema_hash,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public.polynovea_canonical_json(v.schema_json), 'UTF8')), 'hex')
  from public.content_model_versions v
$$;

do $$
declare
  kept bigint;
begin
  select count(*) into kept from public.polynovea_schema_rehash_map() r where r.new_hash is null;
  raise notice 'schema hash re-hash: % schema version(s) keep their previous hash', kept;
end;
$$;

update public.environment_schema_deployments d
set schema_hash = r.new_hash
from public.polynovea_schema_rehash_map() r
where r.new_hash is not null and r.new_hash <> r.old_hash
  and d.content_model_id = r.content_model_id and d.schema_version = r.version_number and d.schema_hash = r.old_hash;

update public.operational_change_assessments a
set proposed_schema_hash = r.new_hash
from public.polynovea_schema_rehash_map() r
where r.new_hash is not null and r.new_hash <> r.old_hash
  and a.content_model_id = r.content_model_id and a.target_schema_version = r.version_number and a.proposed_schema_hash = r.old_hash;

update public.operational_change_assessments a
set target_schema_hash = r.new_hash
from public.polynovea_schema_rehash_map() r
where r.new_hash is not null and r.new_hash <> r.old_hash
  and a.content_model_id = r.content_model_id and a.target_schema_version = r.version_number and a.target_schema_hash = r.old_hash;

update public.operational_change_assessments a
set source_schema_hash = r.new_hash
from public.polynovea_schema_rehash_map() r
where r.new_hash is not null and r.new_hash <> r.old_hash
  and a.content_model_id = r.content_model_id and a.source_schema_version = r.version_number and a.source_schema_hash = r.old_hash;

update public.workspace_environments e
set deployed_schema_hash = r.new_hash
from public.polynovea_schema_rehash_map() r
join public.content_models m on m.id = r.content_model_id
where r.new_hash is not null and r.new_hash <> r.old_hash
  and e.workspace_id = m.workspace_id
  and e.deployed_schema_revision = m.api_key || ':v' || r.version_number
  and e.deployed_schema_hash = r.old_hash;

update public.content_model_versions v
set schema_hash = r.new_hash
from public.polynovea_schema_rehash_map() r
where r.new_hash is not null and r.new_hash <> r.old_hash
  and v.content_model_id = r.content_model_id and v.version_number = r.version_number;

drop function public.polynovea_schema_rehash_map();
-- rehash:end

-- EXECUTE for polynovea_app on the new function, never for PUBLIC (0067/0068/0072 helper).
select public.polynovea_apply_app_access();

-- greatest(): 0074 may land after this file; the recorded migration must not go backwards.
update public.cms_runtime_state
set schema_migration = greatest(schema_migration, '0075'), updated_at = now() where singleton = true;
