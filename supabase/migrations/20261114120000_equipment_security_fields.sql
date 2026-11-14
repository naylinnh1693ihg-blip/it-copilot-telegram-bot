-- Vendor, model, and firmware on equipment cards. Run after 20261031150000_equipment.sql.
-- /sec uses these fields to decide whether a CVE or advisory affects a saved device.
-- Additive only: existing rows get empty strings and keep working.

alter table equipment
  add column if not exists vendor text not null default '',
  add column if not exists model text not null default '',
  add column if not exists firmware_version text not null default '';

create index if not exists equipment_user_vendor_idx on equipment (user_id, vendor);
