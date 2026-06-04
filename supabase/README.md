# Supabase EHR Seed

These files create a de-identified, normalized mini-EHR schema and 20 synthetic patient records for the prescription safety review project.

Run order in the Supabase SQL editor:

1. `schema.sql`
2. `seed_ehr_records.sql`

The records are realistic synthetic test data. They should be described in the project as synthetic EHR-like records, not real hospital patient records.

The schema excludes patient names, addresses, phone numbers, and dates of birth. Patient lookup is done with `patient_code`, for example `EHR-PT-0001`.

After seeding, you can fetch a complete assembled record with:

```sql
select get_patient_ehr('EHR-PT-0001');
```

From the frontend, the same function can be exposed through Supabase RPC as `get_patient_ehr`.

## Drug Ingredient Search Resolver

The frontend calls a Supabase Edge Function named `resolve-drug-ingredient` before running interaction checks. This keeps real search API keys out of React/browser code.

Supported search secrets:

```bash
supabase secrets set SERPER_API_KEY=your_serper_key
```

```bash
supabase secrets set ALIBABA_QWEN_API_KEY=your_alibaba_qwen_key
```

or:

```bash
supabase secrets set BRAVE_SEARCH_API_KEY=your_brave_search_api_key
```

Deploy:

```bash
supabase functions deploy resolve-drug-ingredient
```

The resolver now uses plain Gemini `gemini-3.5-flash` only. Search APIs such as Google Search grounding, Serper, Brave, and Qwen adjudication are disabled for active-ingredient lookup.

If `GCP_GEMINI_SERVICE_ACCOUNT_JSON_B64` or `GCP_GEMINI_SERVICE_ACCOUNT_JSON` is configured, the resolver uses plain Gemini `gemini-3.5-flash` to answer a direct active-ingredient lookup question. Search APIs are not used in this simplified resolver path.

## DDI Review Agent

The prescription workspace now expects a second Supabase Edge Function named `review-ddi`.

This function:

- fetches the patient record from Supabase
- compares proposed drugs against each other and against active EHR medications
- retrieves DDI evidence using Gemini 3.5 Flash Google Search Grounding targeting DrugBank, PubMed, Medscape, and Drugs.com
- produces the final clinically-reasoned DDI report
- stores the review session in `prescription_review_sessions` and `interaction_findings`

Required secret:

```bash
supabase secrets set GCP_GEMINI_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
```

Deploy:

```bash
supabase functions deploy review-ddi
```
