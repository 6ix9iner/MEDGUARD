-- Supabase EHR schema for the Autonomous Clinical Workflow Agent.
-- This is a de-identified, normalized mini-EHR model inspired by OMOP/FHIR.
-- It intentionally excludes patient names, phone numbers, addresses, and dates of birth.

create extension if not exists pgcrypto;
create extension if not exists vector;

create table if not exists ehr_patients (
  id uuid primary key default gen_random_uuid(),
  patient_code text not null unique,
  external_record_ref text unique,
  record_status text not null default 'active'
    check (record_status in ('active', 'inactive', 'superseded', 'entered_in_error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ehr_encounters (
  id uuid primary key default gen_random_uuid(),
  encounter_code text not null unique,
  patient_id uuid not null references ehr_patients(id) on delete restrict,
  encounter_class text not null,
  service_area text not null,
  reason_for_visit text not null,
  encounter_start timestamptz not null,
  encounter_end timestamptz,
  status text not null default 'finished'
    check (status in ('planned', 'in_progress', 'finished', 'cancelled', 'entered_in_error')),
  source_system text not null default 'synthetic-ehr',
  created_at timestamptz not null default now()
);

create table if not exists ehr_conditions (
  id uuid primary key default gen_random_uuid(),
  condition_code text not null unique,
  patient_id uuid not null references ehr_patients(id) on delete restrict,
  encounter_id uuid references ehr_encounters(id) on delete set null,
  condition_display text not null,
  code_system text not null default 'ICD-10-CM',
  source_code text,
  clinical_status text not null default 'active'
    check (clinical_status in ('active', 'resolved', 'inactive', 'recurrence', 'remission')),
  verification_status text not null default 'confirmed'
    check (verification_status in ('confirmed', 'provisional', 'differential', 'refuted', 'entered_in_error')),
  severity text check (severity in ('mild', 'moderate', 'severe', 'critical')),
  onset_date date,
  recorded_date date not null default current_date,
  created_at timestamptz not null default now()
);

create table if not exists ehr_medications (
  id uuid primary key default gen_random_uuid(),
  medication_code text not null unique,
  patient_id uuid not null references ehr_patients(id) on delete restrict,
  encounter_id uuid references ehr_encounters(id) on delete set null,
  medication_display text not null,
  active_ingredient text not null,
  rxnorm_code text,
  dose_value numeric,
  dose_unit text,
  route_display text not null default 'Oral route',
  route_code text default '26643006',
  frequency_text text not null,
  start_date date,
  end_date date,
  medication_status text not null default 'active'
    check (medication_status in ('active', 'completed', 'stopped', 'on_hold', 'entered_in_error')),
  intent text not null default 'order'
    check (intent in ('proposal', 'plan', 'order', 'original_order', 'reflex_order')),
  created_at timestamptz not null default now()
);

create table if not exists ehr_allergies (
  id uuid primary key default gen_random_uuid(),
  allergy_code text not null unique,
  patient_id uuid not null references ehr_patients(id) on delete restrict,
  substance_display text not null,
  substance_category text not null
    check (substance_category in ('medication', 'food', 'environment', 'biologic', 'other')),
  reaction_display text not null,
  criticality text not null
    check (criticality in ('low', 'medium', 'high', 'unable_to_assess')),
  clinical_status text not null default 'active'
    check (clinical_status in ('active', 'inactive', 'resolved', 'entered_in_error')),
  verification_status text not null default 'confirmed'
    check (verification_status in ('confirmed', 'unconfirmed', 'refuted', 'entered_in_error')),
  recorded_date date not null,
  created_at timestamptz not null default now()
);

create table if not exists ehr_observations (
  id uuid primary key default gen_random_uuid(),
  observation_code text not null unique,
  patient_id uuid not null references ehr_patients(id) on delete restrict,
  encounter_id uuid references ehr_encounters(id) on delete set null,
  observation_type text not null check (observation_type in ('laboratory', 'vital_sign', 'clinical_score')),
  observation_display text not null,
  loinc_code text,
  value_text text,
  value_number numeric,
  unit text,
  reference_low numeric,
  reference_high numeric,
  interpretation text check (interpretation in ('low', 'normal', 'high', 'critical', 'abnormal')),
  observed_at timestamptz not null,
  result_status text not null default 'final'
    check (result_status in ('registered', 'preliminary', 'final', 'amended', 'entered_in_error')),
  created_at timestamptz not null default now()
);

create table if not exists ehr_procedures (
  id uuid primary key default gen_random_uuid(),
  procedure_code text not null unique,
  patient_id uuid not null references ehr_patients(id) on delete restrict,
  encounter_id uuid references ehr_encounters(id) on delete set null,
  procedure_display text not null,
  code_system text default 'SNOMED-CT',
  source_code text,
  performed_at timestamptz,
  procedure_status text not null default 'completed'
    check (procedure_status in ('preparation', 'in_progress', 'completed', 'stopped', 'entered_in_error')),
  created_at timestamptz not null default now()
);

create table if not exists ehr_clinical_notes (
  id uuid primary key default gen_random_uuid(),
  note_code text not null unique,
  patient_id uuid not null references ehr_patients(id) on delete restrict,
  encounter_id uuid references ehr_encounters(id) on delete set null,
  note_type text not null,
  note_text text not null,
  authored_at timestamptz not null,
  note_status text not null default 'current'
    check (note_status in ('current', 'superseded', 'entered_in_error')),
  created_at timestamptz not null default now()
);

create table if not exists ehr_audit_events (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references ehr_patients(id) on delete restrict,
  entity_table text not null,
  entity_code text not null,
  action text not null check (action in ('create', 'amend', 'supersede', 'mark_entered_in_error')),
  actor_role text not null default 'system_seed',
  occurred_at timestamptz not null default now(),
  reason text
);

create table if not exists prescription_review_sessions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references ehr_patients(id) on delete restrict,
  requested_medications jsonb not null,
  normalized_ingredients jsonb not null default '[]'::jsonb,
  overall_severity text check (overall_severity in ('none', 'low', 'medium', 'high', 'critical')),
  report_status text not null default 'draft'
    check (report_status in ('draft', 'completed', 'failed', 'superseded')),
  created_at timestamptz not null default now()
);

create table if not exists interaction_findings (
  id uuid primary key default gen_random_uuid(),
  review_session_id uuid not null references prescription_review_sessions(id) on delete cascade,
  interaction_type text not null check (interaction_type in ('drug_drug', 'drug_allergy', 'drug_disease')),
  severity text not null check (severity in ('none', 'low', 'medium', 'high', 'critical')),
  signal text not null,
  explanation text not null,
  recommendation text not null,
  evidence jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists drug_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  knowledge_type text not null check (knowledge_type in ('drug_drug', 'drug_allergy', 'drug_disease', 'drug_identity')),
  title text not null,
  source_name text,
  source_url text,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

create index if not exists idx_ehr_encounters_patient on ehr_encounters(patient_id);
create index if not exists idx_ehr_conditions_patient on ehr_conditions(patient_id);
create index if not exists idx_ehr_medications_patient_status on ehr_medications(patient_id, medication_status);
create index if not exists idx_ehr_allergies_patient_status on ehr_allergies(patient_id, clinical_status);
create index if not exists idx_ehr_observations_patient_time on ehr_observations(patient_id, observed_at desc);
create index if not exists idx_ehr_notes_patient_time on ehr_clinical_notes(patient_id, authored_at desc);
create index if not exists idx_drug_knowledge_type on drug_knowledge_documents(knowledge_type);

create or replace function get_patient_ehr(p_patient_code text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'patient', jsonb_build_object(
      'patient_code', p.patient_code,
      'external_record_ref', p.external_record_ref,
      'record_status', p.record_status
    ),
    'encounters', coalesce((
      select jsonb_agg(to_jsonb(e) - 'patient_id' order by e.encounter_start desc)
      from ehr_encounters e
      where e.patient_id = p.id
    ), '[]'::jsonb),
    'conditions', coalesce((
      select jsonb_agg(to_jsonb(c) - 'patient_id' order by c.recorded_date desc, c.condition_display)
      from ehr_conditions c
      where c.patient_id = p.id
    ), '[]'::jsonb),
    'medications', coalesce((
      select jsonb_agg(to_jsonb(m) - 'patient_id' order by m.medication_status, m.medication_display)
      from ehr_medications m
      where m.patient_id = p.id
    ), '[]'::jsonb),
    'allergies', coalesce((
      select jsonb_agg(to_jsonb(a) - 'patient_id' order by a.criticality desc, a.substance_display)
      from ehr_allergies a
      where a.patient_id = p.id
    ), '[]'::jsonb),
    'observations', coalesce((
      select jsonb_agg(to_jsonb(o) - 'patient_id' order by o.observed_at desc)
      from ehr_observations o
      where o.patient_id = p.id
    ), '[]'::jsonb),
    'procedures', coalesce((
      select jsonb_agg(to_jsonb(pr) - 'patient_id' order by pr.performed_at desc)
      from ehr_procedures pr
      where pr.patient_id = p.id
    ), '[]'::jsonb),
    'clinical_notes', coalesce((
      select jsonb_agg(to_jsonb(n) - 'patient_id' order by n.authored_at desc)
      from ehr_clinical_notes n
      where n.patient_id = p.id
    ), '[]'::jsonb)
  )
  from ehr_patients p
  where p.patient_code = p_patient_code;
$$;
