import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BellRing,
  ClipboardList,
  Database,
  FilePlus2,
  HeartPulse,
  History,
  Microscope,
  Pill,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  UserRound,
} from "lucide-react";
import { supabase, supabaseUrl, supabaseAnonKey } from "./supabaseClient";

const parseFindingDetail = (finding) => {
  if (finding.reasoning) {
    return {
      reasoning: finding.reasoning,
      detail: finding.detail
    };
  }
  
  const text = finding.detail || finding.explanation || "";
  if (text.startsWith("Medical Reasoning:") && text.includes("\n\nDetail:")) {
    const parts = text.split("\n\nDetail:");
    const reasoningText = parts[0].replace("Medical Reasoning:", "").trim();
    const detailText = parts[1].trim();
    return {
      reasoning: reasoningText,
      detail: detailText
    };
  }
  
  return {
    reasoning: null,
    detail: text
  };
};

const pages = [
  { id: "prescription", label: "Prescription", icon: ClipboardList },
  { id: "ehr", label: "EHR Records", icon: Database },
  { id: "reports", label: "Reports", icon: History },
];

const agentStatus = [
  { label: "Drug-drug agent", status: "Reads active medication orders", icon: Pill },
  { label: "Allergy agent", status: "Reads allergy rows", icon: ShieldCheck },
  { label: "Disease agent", status: "Reads conditions and observations", icon: HeartPulse },
];

const starterFindings = [
  {
    type: "Drug-Drug",
    severity: "High",
    signal: "Clopidogrel + Aspirin",
    detail:
      "Combined antiplatelet effect may increase bleeding risk if the patient already uses aspirin.",
    action: "Run the interaction agents before final prescription.",
  },
  {
    type: "Drug-Allergy",
    severity: "Low",
    signal: "Drug vs allergy profile",
    detail: "The allergy agent compares prescribed ingredients with the patient's allergy section.",
    action: "Confirm allergy history before saving high-risk prescriptions.",
  },
  {
    type: "Drug-Disease",
    severity: "Medium",
    signal: "Drug vs diagnoses and labs",
    detail: "The disease agent reviews active conditions such as CKD, liver disease, asthma, and bleeding risk.",
    action: "Use patient-specific context to rank severity.",
  },
];

const fallbackIngredient = (name) => name.trim().toLowerCase();

const humanizeResolutionNote = (drugName, result) => {
  if (result.resolutionStatus === "ingredient") {
    return `Ingredient confirmed for ${drugName}.`;
  }
  if (result.resolutionStatus === "resolved" && result.ingredient) {
    return `Resolved ${drugName} to ${result.ingredient}.`;
  }
  if (result.resolutionStatus === "unconfirmed") {
    return `Could not confirm an ingredient for ${drugName} yet.`;
  }
  if (result.resolutionStatus === "failed") {
    return `Ingredient lookup is temporarily unavailable for ${drugName}.`;
  }
  return result.resolutionNote || "";
};

const resolveDrugIngredientOnline = async (drugName) => {
  const normalizedName = fallbackIngredient(drugName);
  if (!normalizedName) {
    return {
      ingredient: "",
      resolutionStatus: "empty",
      resolutionSource: "",
      resolutionNote: "No medication name entered.",
    };
  }

  try {
    const { data, error } = await supabase.functions.invoke("resolve-drug-ingredient", {
      body: { drugName },
    });
    if (error) throw error;

    if (data?.ingredient) {
      const result = {
        ingredient: data.ingredient,
        resolutionStatus: data.status || "resolved",
        resolutionSource: data.source || "search resolver",
        resolutionNote: data.note || `Resolved "${drugName}" to "${data.ingredient}".`,
      };
      return { ...result, resolutionNote: humanizeResolutionNote(drugName, result) };
    }

    const result = {
      ingredient: "",
      resolutionStatus: data?.status || "unconfirmed",
      resolutionSource: data?.source || "",
      resolutionNote: data?.note || "Search resolver did not confirm an active ingredient.",
    };
    return { ...result, resolutionNote: humanizeResolutionNote(drugName, result) };
  } catch (error) {
    let errMsg = error.message;
    if (error && error.context) {
      try {
        const body = await error.context.json();
        if (body && body.note) {
          errMsg = body.note;
        } else if (body && body.error) {
          errMsg = body.error;
        }
      } catch (e) {
        // ignore
      }
    }
    const result = {
      ingredient: "",
      resolutionStatus: "failed",
      resolutionSource: "Supabase Edge Function",
      resolutionNote: `Search resolver is not available yet: ${errMsg}`,
    };
    return { ...result, resolutionNote: humanizeResolutionNote(drugName, result) };
  }
};
const makeCode = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

const ehrSections = {
  encounter: {
    label: "Encounter",
    table: "ehr_encounters",
    collection: "encounters",
    codeField: "encounter_code",
    codePrefix: "ENC-NEW",
    fields: [
      { name: "encounter_class", label: "Encounter class", type: "select", options: ["outpatient", "inpatient", "emergency", "telehealth"] },
      { name: "service_area", label: "Service area / clinic" },
      { name: "reason_for_visit", label: "Reason for visit" },
      { name: "encounter_start", label: "Start date and time", type: "datetime-local" },
      { name: "encounter_end", label: "End date and time", type: "datetime-local" },
      { name: "status", label: "Status", type: "select", options: ["planned", "in_progress", "finished", "cancelled", "entered_in_error"] },
    ],
    defaults: { encounter_class: "outpatient", status: "finished" },
    display: (row) => `${row.encounter_code || "Encounter"} - ${row.reason_for_visit || row.service_area || ""}`,
  },
  medication: {
    label: "Medication",
    table: "ehr_medications",
    collection: "medications",
    codeField: "medication_code",
    codePrefix: "MED-NEW",
    fields: [
      { name: "medication_display", label: "Medication display" },
      { name: "active_ingredient", label: "Active ingredient" },
      { name: "rxnorm_code", label: "RxNorm code" },
      { name: "dose_value", label: "Dose value", type: "number" },
      { name: "dose_unit", label: "Dose unit" },
      { name: "route_display", label: "Route" },
      { name: "frequency_text", label: "Frequency instruction" },
      { name: "start_date", label: "Start date", type: "date" },
      { name: "end_date", label: "End date", type: "date" },
      { name: "medication_status", label: "Medication status", type: "select", options: ["active", "completed", "stopped", "on_hold", "entered_in_error"] },
      { name: "intent", label: "Intent", type: "select", options: ["proposal", "plan", "order", "original_order", "reflex_order"] },
    ],
    defaults: { route_display: "Oral route", medication_status: "active", intent: "order" },
    display: (row) => row.medication_display || row.active_ingredient || row.medication_code,
  },
  condition: {
    label: "Condition",
    table: "ehr_conditions",
    collection: "conditions",
    codeField: "condition_code",
    codePrefix: "COND-NEW",
    fields: [
      { name: "condition_display", label: "Condition display" },
      { name: "source_code", label: "ICD-10/source code" },
      { name: "clinical_status", label: "Clinical status", type: "select", options: ["active", "resolved", "inactive", "recurrence", "remission"] },
      { name: "verification_status", label: "Verification status", type: "select", options: ["confirmed", "provisional", "differential", "refuted", "entered_in_error"] },
      { name: "severity", label: "Severity", type: "select", options: ["mild", "moderate", "severe", "critical"] },
      { name: "onset_date", label: "Onset date", type: "date" },
      { name: "recorded_date", label: "Recorded date", type: "date" },
    ],
    defaults: { clinical_status: "active", verification_status: "confirmed", severity: "moderate" },
    display: (row) => row.condition_display || row.condition_code,
  },
  allergy: {
    label: "Allergy",
    table: "ehr_allergies",
    collection: "allergies",
    codeField: "allergy_code",
    codePrefix: "ALG-NEW",
    fields: [
      { name: "substance_display", label: "Substance / allergen" },
      { name: "substance_category", label: "Category", type: "select", options: ["medication", "food", "environment", "biologic", "other"] },
      { name: "reaction_display", label: "Reaction" },
      { name: "criticality", label: "Criticality", type: "select", options: ["low", "medium", "high", "unable_to_assess"] },
      { name: "clinical_status", label: "Clinical status", type: "select", options: ["active", "inactive", "resolved", "entered_in_error"] },
      { name: "verification_status", label: "Verification status", type: "select", options: ["confirmed", "unconfirmed", "refuted", "entered_in_error"] },
      { name: "recorded_date", label: "Recorded date", type: "date" },
    ],
    defaults: { substance_category: "medication", criticality: "medium", clinical_status: "active", verification_status: "confirmed" },
    display: (row) => row.substance_display || row.allergy_code,
  },
  observation: {
    label: "Lab / Vital",
    table: "ehr_observations",
    collection: "observations",
    codeField: "observation_code",
    codePrefix: "OBS-NEW",
    fields: [
      { name: "observation_type", label: "Observation type", type: "select", options: ["laboratory", "vital_sign", "clinical_score"] },
      { name: "observation_display", label: "Observation name" },
      { name: "loinc_code", label: "LOINC code" },
      { name: "value_text", label: "Text value" },
      { name: "value_number", label: "Numeric value", type: "number" },
      { name: "unit", label: "Unit" },
      { name: "reference_low", label: "Reference low", type: "number" },
      { name: "reference_high", label: "Reference high", type: "number" },
      { name: "interpretation", label: "Interpretation", type: "select", options: ["low", "normal", "high", "critical", "abnormal"] },
      { name: "observed_at", label: "Observed at", type: "datetime-local" },
      { name: "result_status", label: "Result status", type: "select", options: ["registered", "preliminary", "final", "amended", "entered_in_error"] },
    ],
    defaults: { observation_type: "laboratory", result_status: "final", interpretation: "normal" },
    display: (row) => row.observation_display || row.observation_code,
  },
  procedure: {
    label: "Procedure",
    table: "ehr_procedures",
    collection: "procedures",
    codeField: "procedure_code",
    codePrefix: "PROC-NEW",
    fields: [
      { name: "procedure_display", label: "Procedure display" },
      { name: "source_code", label: "Source code" },
      { name: "performed_at", label: "Performed at", type: "datetime-local" },
      { name: "procedure_status", label: "Procedure status", type: "select", options: ["preparation", "in_progress", "completed", "stopped", "entered_in_error"] },
    ],
    defaults: { procedure_status: "completed" },
    display: (row) => row.procedure_display || row.procedure_code,
  },
  note: {
    label: "Clinical Note",
    table: "ehr_clinical_notes",
    collection: "clinical_notes",
    codeField: "note_code",
    codePrefix: "NOTE-NEW",
    fields: [
      { name: "note_type", label: "Note type" },
      { name: "note_text", label: "Note text", type: "textarea" },
      { name: "authored_at", label: "Authored at", type: "datetime-local" },
      { name: "note_status", label: "Note status", type: "select", options: ["current", "superseded", "entered_in_error"] },
    ],
    defaults: { note_type: "Clinical update note", note_status: "current" },
    display: (row) => `${row.note_type || "Note"} - ${(row.note_text || "").slice(0, 48)}`,
  },
};

const blankFormFor = (sectionKey) =>
  Object.fromEntries(
    ehrSections[sectionKey].fields.map((field) => [
      field.name,
      ehrSections[sectionKey].defaults?.[field.name] || "",
    ])
  );

const makeFinding = (type, severity, signal, detail, action, evidence = []) => ({
  type,
  severity,
  signal,
  detail,
  action,
  evidence,
});

function App() {
  const [activePage, setActivePage] = useState("prescription");
  const [lookupCode, setLookupCode] = useState("EHR-PT-0001");
  const [ehr, setEhr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("Ready");
  const [newPatientCode, setNewPatientCode] = useState("EHR-PT-0021");
  const [newPatientRef, setNewPatientRef] = useState("FHIR-Patient/948221");
  const [newPatientStatus, setNewPatientStatus] = useState("active");
  const [patientEditForm, setPatientEditForm] = useState({
    external_record_ref: "",
    record_status: "active",
  });
  const [addSection, setAddSection] = useState("condition");
  const [addForm, setAddForm] = useState(blankFormFor("condition"));
  const [editSection, setEditSection] = useState("condition");
  const [editRecordId, setEditRecordId] = useState("");
  const [editForm, setEditForm] = useState(blankFormFor("condition"));
  const [prescription, setPrescription] = useState({
    name: "",
    dose: "",
    unit: "mg",
    route: "Oral route",
    frequency: "",
  });
  const [prescriptionItems, setPrescriptionItems] = useState([
    {
      id: "rx-1",
      name: "",
      dose: "",
      unit: "mg",
      route: "Oral route",
      frequency: "",
      ingredient: "",
      resolutionStatus: "pending",
      resolutionSource: "",
      resolutionNote: "",
    },
    {
      id: "rx-2",
      name: "",
      dose: "",
      unit: "mg",
      route: "Oral route",
      frequency: "",
      ingredient: "",
      resolutionStatus: "pending",
      resolutionSource: "",
      resolutionNote: "",
    },
  ]);
  const [reviewFindings, setReviewFindings] = useState([]);
  const [reviewCompleted, setReviewCompleted] = useState(false);
  const [loadingReferences, setLoadingReferences] = useState({});

  // Drug-to-Allergy agent state
  const [allergyFindings, setAllergyFindings] = useState([]);
  const [allergyReviewCompleted, setAllergyReviewCompleted] = useState(false);
  const [loadingAllergyReview, setLoadingAllergyReview] = useState(false);
  const [loadingAllergyReferences, setLoadingAllergyReferences] = useState({});

  // Drug-to-Disease agent state
  const [diseaseFindings, setDiseaseFindings] = useState([]);
  const [diseaseReviewCompleted, setDiseaseReviewCompleted] = useState(false);
  const [loadingDiseaseReview, setLoadingDiseaseReview] = useState(false);
  const [loadingDiseaseReferences, setLoadingDiseaseReferences] = useState({});

  const patient = ehr?.patient;
  const latestEncounter = ehr?.encounters?.[0];
  const activeMeds = useMemo(
    () => (ehr?.medications || []).filter((med) => med.medication_status === "active"),
    [ehr]
  );

  async function fetchPatient(code = lookupCode) {
    const patientCode = code.trim();
    if (!patientCode) return;
    setLoading(true);
    setMessage("Fetching EHR record...");

    const { data, error } = await supabase.rpc("get_patient_ehr", {
      p_patient_code: patientCode,
    });

    if (error) {
      setMessage(error.message);
      setEhr(null);
    } else if (!data) {
      setMessage(`No EHR record found for ${patientCode}`);
      setEhr(null);
    } else {
      setEhr(data);
      setLookupCode(patientCode);
      setMessage(`Loaded ${patientCode}`);
    }

    setLoading(false);
  }

  useEffect(() => {
    fetchPatient("EHR-PT-0001");
    resolvePrescriptionIngredients();
  }, []);

  useEffect(() => {
    if (patient) {
      setPatientEditForm({
        external_record_ref: patient.external_record_ref || "",
        record_status: patient.record_status || "active",
      });
    }
  }, [patient?.patient_code]);

  useEffect(() => {
    const rows = ehr?.[ehrSections[editSection].collection] || [];
    if (rows.length > 0 && !rows.some((row) => row.id === editRecordId)) {
      setEditRecordId(rows[0].id);
      setEditForm(formFromRow(editSection, rows[0]));
    }
  }, [ehr, editSection]);

  async function getPatientId(patientCode = lookupCode) {
    const { data, error } = await supabase
      .from("ehr_patients")
      .select("id")
      .eq("patient_code", patientCode.trim())
      .single();

    if (error) throw error;
    return data.id;
  }

  async function addPatient(event) {
    event.preventDefault();
    setLoading(true);
    setMessage("Creating patient record...");

    try {
      const patientCode = newPatientCode.trim();
      const { error } = await supabase.from("ehr_patients").insert({
        patient_code: patientCode,
        external_record_ref: newPatientRef.trim() || null,
        record_status: newPatientStatus,
      });
      if (error) throw error;

      const patientId = await getPatientId(patientCode);
      const today = new Date().toISOString().slice(0, 10);
      await supabase.from("ehr_allergies").insert({
        allergy_code: makeCode("ALG-NEW"),
        patient_id: patientId,
        substance_display: "No known drug allergy",
        substance_category: "other",
        reaction_display: "No allergy reaction recorded",
        criticality: "low",
        clinical_status: "active",
        recorded_date: today,
      });

      setLookupCode(patientCode);
      await fetchPatient(patientCode);
      setActivePage("ehr");
      setMessage(`Created ${patientCode}`);
    } catch (error) {
      setMessage(error.message);
    }

    setLoading(false);
  }

  async function updatePatientShell(event) {
    event.preventDefault();
    if (!patient) return;
    setLoading(true);
    setMessage("Updating patient shell...");

    try {
      const { error } = await supabase
        .from("ehr_patients")
        .update({
          external_record_ref: patientEditForm.external_record_ref || null,
          record_status: patientEditForm.record_status,
          updated_at: new Date().toISOString(),
        })
        .eq("patient_code", patient.patient_code);
      if (error) throw error;
      await fetchPatient(patient.patient_code);
      setMessage("Patient shell updated");
    } catch (error) {
      setMessage(error.message);
    }

    setLoading(false);
  }

  function changeAddSection(sectionKey) {
    setAddSection(sectionKey);
    setAddForm(blankFormFor(sectionKey));
  }

  function changeEditSection(sectionKey) {
    setEditSection(sectionKey);
    const firstRow = ehr?.[ehrSections[sectionKey].collection]?.[0];
    setEditRecordId(firstRow?.id || "");
    setEditForm(firstRow ? formFromRow(sectionKey, firstRow) : blankFormFor(sectionKey));
  }

  function chooseEditRecord(sectionKey, recordId) {
    setEditRecordId(recordId);
    const row = ehr?.[ehrSections[sectionKey].collection]?.find((item) => item.id === recordId);
    setEditForm(row ? formFromRow(sectionKey, row) : blankFormFor(sectionKey));
  }

  function formFromRow(sectionKey, row) {
    return Object.fromEntries(
      ehrSections[sectionKey].fields.map((field) => [
        field.name,
        formatValueForInput(field, row[field.name]),
      ])
    );
  }

  function formatValueForInput(field, value) {
    if (value === null || value === undefined) return "";
    if (field.type === "datetime-local") return String(value).slice(0, 16);
    return String(value);
  }

  function normalizeFormPayload(sectionKey, form) {
    const payload = {};
    ehrSections[sectionKey].fields.forEach((field) => {
      const value = form[field.name];
      if (value === "") {
        payload[field.name] = null;
      } else if (field.type === "number") {
        payload[field.name] = Number(value);
      } else if (field.type === "datetime-local") {
        payload[field.name] = new Date(value).toISOString();
      } else {
        payload[field.name] = value;
      }
    });
    return payload;
  }

  async function addEhrRecord(event) {
    event.preventDefault();
    if (!patient) return;
    setLoading(true);
    setMessage(`Adding ${ehrSections[addSection].label.toLowerCase()}...`);

    try {
      const patientId = await getPatientId(patient.patient_code);
      const config = ehrSections[addSection];
      const payload = normalizeFormPayload(addSection, addForm);
      payload.patient_id = patientId;
      payload[config.codeField] = makeCode(config.codePrefix);
      if (addSection !== "encounter") {
        payload.encounter_id = latestEncounter?.id || null;
      }
      if (addSection === "encounter") {
        payload.source_system = "frontend-ehr";
      }
      const { error } = await supabase.from(config.table).insert(payload);
      if (error) throw error;
      setAddForm(blankFormFor(addSection));
      await fetchPatient(patient.patient_code);
      setMessage(`${config.label} added`);
    } catch (error) {
      setMessage(error.message);
    }

    setLoading(false);
  }

  async function saveEditedRecord(event) {
    event.preventDefault();
    if (!patient || !editRecordId) return;
    setLoading(true);
    setMessage(`Updating ${ehrSections[editSection].label.toLowerCase()}...`);

    try {
      const config = ehrSections[editSection];
      const payload = normalizeFormPayload(editSection, editForm);
      const { error } = await supabase.from(config.table).update(payload).eq("id", editRecordId);
      if (error) throw error;
      await fetchPatient(patient.patient_code);
      setMessage(`${config.label} updated`);
    } catch (error) {
      setMessage(error.message);
    }

    setLoading(false);
  }

  async function savePrescription(event) {
    event.preventDefault();
    if (!patient || !reviewCompleted) return;
    setLoading(true);
    setMessage("Saving prescribed medication...");

    try {
      const patientId = await getPatientId(patient.patient_code);
      const encounterId = latestEncounter?.id || null;
      const validItems = prescriptionItems.filter((item) => item.name.trim());
      if (validItems.length === 0) {
        throw new Error("Enter at least one medication before saving.");
      }

      const rows = validItems.map((item, index) => ({
        medication_code: makeCode(`RX-${index + 1}`),
        patient_id: patientId,
        encounter_id: encounterId,
        medication_display: `${item.name} ${item.dose} ${item.unit}`.trim(),
        active_ingredient: item.ingredient || fallbackIngredient(item.name),
        dose_value: Number(item.dose) || null,
        dose_unit: item.unit,
        route_display: item.route || "Oral route",
        route_code: "26643006",
        frequency_text: item.frequency,
        start_date: new Date().toISOString().slice(0, 10),
        medication_status: "active",
        intent: "order",
      }));

      const { error } = await supabase.from("ehr_medications").insert(rows);
      if (error) throw error;

      await fetchPatient(patient.patient_code);
      setMessage(`${rows.length} prescription record(s) saved`);
    } catch (error) {
      setMessage(error.message);
    }

    setLoading(false);
  }

  function resetReview() {
    setReviewCompleted(false);
    setReviewFindings([]);
    setLoadingReferences({});
    setAllergyFindings([]);
    setAllergyReviewCompleted(false);
    setLoadingAllergyReferences({});
    setDiseaseFindings([]);
    setDiseaseReviewCompleted(false);
    setLoadingDiseaseReferences({});
  }

  async function resolvePrescriptionIngredients() {
    const validItems = prescriptionItems.filter((item) => item.name.trim());
    if (validItems.length === 0) {
      setMessage("Enter at least one drug before resolving ingredients.");
      return prescriptionItems;
    }

    setLoading(true);
    setMessage("Searching the internet for active ingredients...");

    const resolvedItems = await Promise.all(
      prescriptionItems.map(async (item) => {
        if (!item.name.trim()) {
          return {
            ...item,
            ingredient: "",
            resolutionStatus: "empty",
            resolutionSource: "",
            resolutionNote: "No medication name entered.",
          };
        }

        // Skip if already resolved to save API calls and decrease latency
        if (["resolved", "ingredient"].includes(item.resolutionStatus) && item.ingredient) {
          return item;
        }

        const result = await resolveDrugIngredientOnline(item.name.trim());
        return { ...item, ...result };
      })
    );

    setPrescriptionItems(resolvedItems);
    setLoading(false);

    const confirmed = resolvedItems.filter((item) =>
      ["resolved", "ingredient"].includes(item.resolutionStatus)
    ).length;
    setMessage(`Ingredient search completed: ${confirmed}/${validItems.length} confirmed online`);
    return resolvedItems;
  }

  async function resolveOnePrescriptionIngredient(itemId) {
    const item = prescriptionItems.find((entry) => entry.id === itemId);
    if (!item?.name.trim()) return;

    // Skip if already resolved to save API calls and decrease latency
    if (["resolved", "ingredient"].includes(item.resolutionStatus) && item.ingredient) {
      return;
    }

    setLoading(true);
    setMessage(`Searching active ingredient for ${item.name.trim()}...`);

    const result = await resolveDrugIngredientOnline(item.name.trim());
    let nextItems = [];
    setPrescriptionItems((items) => {
      nextItems = items.map((entry) => (entry.id === itemId ? { ...entry, ...result } : entry));
      return nextItems;
    });
    resetReview();
    setLoading(false);
    setMessage(result.resolutionNote || `Ingredient search completed for ${item.name.trim()}`);
    return nextItems;
  }

  async function handleFetchReferences(finding, index) {
    if (!patient || !finding.left || !finding.right) return;

    const key = finding.signal || `${finding.left}-${finding.right}`;
    setLoadingReferences((prev) => ({ ...prev, [key]: true }));
    setMessage(`Fetching references for ${finding.signal}...`);

    try {
      const SUPABASE_URL = supabaseUrl;
      const SUPABASE_ANON_KEY = supabaseAnonKey;

      const response = await fetch(`${SUPABASE_URL}/functions/v1/review-ddi`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
          "apikey": SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          mode: "references",
          patientCode: patient.patient_code,
          pair: {
            left: finding.left,
            right: finding.right,
            leftSource: finding.leftSource || finding.left,
            rightSource: finding.rightSource || finding.right,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(errText || `Failed to fetch references (HTTP ${response.status})`);
      }

      const data = await response.json();
      const fetchedEvidence = data?.evidence || [];

      setReviewFindings((prevFindings) =>
        prevFindings.map((f, i) => (i === index ? { ...f, evidence: fetchedEvidence } : f))
      );
      setMessage(`References loaded for ${finding.signal}`);
    } catch (error) {
      console.error(error);
      setMessage(`Error fetching references: ${error.message || error}`);
    } finally {
      setLoadingReferences((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function handleFetchAllergyReferences(finding, index) {
    if (!patient || !finding.drug || !finding.allergen) return;

    const key = finding.signal || `${finding.drug}-${finding.allergen}`;
    setLoadingAllergyReferences((prev) => ({ ...prev, [key]: true }));
    setMessage(`Fetching allergy references for ${finding.signal}...`);

    try {
      const SUPABASE_URL = supabaseUrl;
      const SUPABASE_ANON_KEY = supabaseAnonKey;

      const response = await fetch(`${SUPABASE_URL}/functions/v1/review-allergy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
          "apikey": SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          mode: "references",
          pair: {
            drug: finding.drug,
            allergen: finding.allergen,
            drugSource: finding.drugSource || finding.drug,
            allergenSource: finding.allergenSource || finding.allergen,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(errText || `Failed to fetch allergy references (HTTP ${response.status})`);
      }

      const data = await response.json();
      const fetchedEvidence = data?.evidence || [];
      setAllergyFindings((prev) =>
        prev.map((f, i) => (i === index ? { ...f, evidence: fetchedEvidence } : f))
      );
      setMessage(`Allergy references loaded for ${finding.signal}`);
    } catch (error) {
      console.error(error);
      setMessage(`Error fetching allergy references: ${error.message || error}`);
    } finally {
      setLoadingAllergyReferences((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function handleFetchDiseaseReferences(finding, index) {
    if (!patient || !finding.drug || !finding.disease) return;

    const key = finding.signal || `${finding.drug}-${finding.disease}`;
    setLoadingDiseaseReferences((prev) => ({ ...prev, [key]: true }));
    setMessage(`Fetching disease references for ${finding.signal}...`);

    try {
      const SUPABASE_URL = supabaseUrl;
      const SUPABASE_ANON_KEY = supabaseAnonKey;

      const response = await fetch(`${SUPABASE_URL}/functions/v1/review-disease`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
          "apikey": SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          mode: "references",
          pair: {
            drug: finding.drug,
            disease: finding.disease,
            drugSource: finding.drugSource || finding.drug,
            diseaseSource: finding.diseaseSource || finding.disease,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(errText || `Failed to fetch disease references (HTTP ${response.status})`);
      }

      const data = await response.json();
      const fetchedEvidence = data?.evidence || [];
      setDiseaseFindings((prev) =>
        prev.map((f, i) => (i === index ? { ...f, evidence: fetchedEvidence } : f))
      );
      setMessage(`Disease references loaded for ${finding.signal}`);
    } catch (error) {
      console.error(error);
      setMessage(`Error fetching disease references: ${error.message || error}`);
    } finally {
      setLoadingDiseaseReferences((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function runAllergyReview() {
    if (!patient) {
      setMessage("Fetch a patient before running allergy review.");
      return;
    }

    const resolvedItems = await resolvePrescriptionIngredients();
    const proposed = resolvedItems
      .filter((item) => item.name.trim())
      .map((item) => ({
        ...item,
        ingredient: item.ingredient || fallbackIngredient(item.name),
      }));

    if (proposed.length === 0) {
      setMessage("Enter at least one drug before running allergy review.");
      return;
    }

    setLoadingAllergyReview(true);
    setMessage("Running the Drug-to-Allergy review agent...");

    try {
      const SUPABASE_URL = supabaseUrl;
      const SUPABASE_ANON_KEY = supabaseAnonKey;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120_000);

      let allergyResponse;
      try {
        allergyResponse = await fetch(`${SUPABASE_URL}/functions/v1/review-allergy`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
            "apikey": SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            patientCode: patient.patient_code,
            proposedMedications: proposed.map((item) => ({
              name: item.name,
              ingredient: item.ingredient,
              dose: item.dose,
              unit: item.unit,
              route: item.route,
              frequency: item.frequency,
            })),
          }),
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!allergyResponse.ok) {
        const errText = await allergyResponse.text().catch(() => "");
        let serverMsg = `Allergy review failed (HTTP ${allergyResponse.status})`;
        try { const parsed = JSON.parse(errText); serverMsg = parsed?.error || parsed?.message || serverMsg; } catch (_) {}
        throw new Error(serverMsg);
      }

      const data = await allergyResponse.json();

      const finalFindings = Array.isArray(data?.findings) && data.findings.length > 0
        ? data.findings.map((finding) => ({
            type: finding.type || "Drug-Allergy",
            severity: finding.severity || "low",
            signal: finding.signal || "Allergy review result",
            detail: finding.detail || "No detail returned.",
            action: finding.action || "Review the allergy evidence.",
            evidence: finding.evidence || [],
            drug: finding.drug,
            allergen: finding.allergen,
            drugSource: finding.drugSource,
            allergenSource: finding.allergenSource,
          }))
        : [
            {
              type: "Drug-Allergy",
              severity: "none",
              signal: "No allergy interactions identified",
              detail: data?.clinicalSummary || "The allergy review agent found no clinically significant drug-allergy cross-reactivities for the reviewed medications.",
              action: "No clinical action required for allergy interactions.",
              evidence: [],
            },
          ];

      setAllergyFindings(finalFindings);
      setAllergyReviewCompleted(true);
      setLoadingAllergyReview(false);
      setMessage(`Allergy review completed: ${finalFindings.length} finding(s)`);
    } catch (error) {
      setLoadingAllergyReview(false);
      let errMsg = "The allergy review agent could not complete the review.";
      if (error?.name === "AbortError") {
        errMsg = "The allergy review timed out. Please try again.";
      } else if (error?.message) {
        errMsg = error.message;
      }
      setMessage(errMsg);
      setAllergyFindings([
        makeFinding(
          "Drug-Allergy",
          "Medium",
          "Allergy review unavailable",
          errMsg,
          "Retry the review or manually verify medications against the patient's allergy history."
        ),
      ]);
    }
  }

  async function runDiseaseReview() {
    if (!patient) {
      setMessage("Fetch a patient before running disease review.");
      return;
    }

    const resolvedItems = await resolvePrescriptionIngredients();
    const proposed = resolvedItems
      .filter((item) => item.name.trim())
      .map((item) => ({
        ...item,
        ingredient: item.ingredient || fallbackIngredient(item.name),
      }));

    if (proposed.length === 0) {
      setMessage("Enter at least one drug before running disease review.");
      return;
    }

    setLoadingDiseaseReview(true);
    setMessage("Running the Drug-to-Disease review agent...");

    try {
      const SUPABASE_URL = supabaseUrl;
      const SUPABASE_ANON_KEY = supabaseAnonKey;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120_000);

      let diseaseResponse;
      try {
        diseaseResponse = await fetch(`${SUPABASE_URL}/functions/v1/review-disease`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
            "apikey": SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            patientCode: patient.patient_code,
            proposedMedications: proposed.map((item) => ({
              name: item.name,
              ingredient: item.ingredient,
              dose: item.dose,
              unit: item.unit,
              route: item.route,
              frequency: item.frequency,
            })),
          }),
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!diseaseResponse.ok) {
        const errText = await diseaseResponse.text().catch(() => "");
        let serverMsg = `Disease review failed (HTTP ${diseaseResponse.status})`;
        try { const parsed = JSON.parse(errText); serverMsg = parsed?.error || parsed?.message || serverMsg; } catch (_) {}
        throw new Error(serverMsg);
      }

      const data = await diseaseResponse.json();

      const finalFindings = Array.isArray(data?.findings) && data.findings.length > 0
        ? data.findings.map((finding) => ({
            type: finding.type || "Drug-Disease",
            severity: finding.severity || "low",
            signal: finding.signal || "Disease review result",
            detail: finding.detail || "No detail returned.",
            action: finding.action || "Review the disease evidence.",
            evidence: finding.evidence || [],
            drug: finding.drug,
            disease: finding.disease,
            drugSource: finding.drugSource,
            diseaseSource: finding.diseaseSource,
          }))
        : [
            {
              type: "Drug-Disease",
              severity: "none",
              signal: "No drug-disease contraindications identified",
              detail: data?.clinicalSummary || "The disease review agent found no clinically significant drug-disease contraindications or precautions for the reviewed medications.",
              action: "No clinical action required for drug-disease contraindications.",
              evidence: [],
            },
          ];

      setDiseaseFindings(finalFindings);
      setDiseaseReviewCompleted(true);
      setLoadingDiseaseReview(false);
      setMessage(`Disease review completed: ${finalFindings.length} finding(s)`);
    } catch (error) {
      setLoadingDiseaseReview(false);
      let errMsg = "The disease review agent could not complete the review.";
      if (error?.name === "AbortError") {
        errMsg = "The disease review timed out. Please try again.";
      } else if (error?.message) {
        errMsg = error.message;
      }
      setMessage(errMsg);
      setDiseaseFindings([
        makeFinding(
          "Drug-Disease",
          "Medium",
          "Disease review unavailable",
          errMsg,
          "Retry the review or manually verify medications against the patient's condition and lab history."
        ),
      ]);
    }
  }

  async function runInteractionReview() {
    if (!patient) {
      setMessage("Fetch a patient before running interaction review.");
      return;
    }

    const resolvedItems = await resolvePrescriptionIngredients();
    const unresolved = resolvedItems.filter(
      (item) =>
        item.name.trim() && !["resolved", "ingredient"].includes(item.resolutionStatus)
    );

    const proposed = resolvedItems
      .filter((item) => item.name.trim())
      .map((item) => ({
        ...item,
        ingredient: item.ingredient || fallbackIngredient(item.name),
      }));

    if (proposed.length === 0) {
      setMessage("Enter at least one drug before running interaction review.");
      return;
    }

    setLoading(true);
    setMessage("Running the DDI review agent...");

    let finalFindings = [];
    try {
      // Use raw fetch with a 120s timeout — supabase.functions.invoke() has a
      // shorter default timeout that can expire during AI-powered DDI searches.
      const SUPABASE_URL = supabaseUrl;
      const SUPABASE_ANON_KEY = supabaseAnonKey;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120_000);

      let ddiResponse;
      try {
        ddiResponse = await fetch(`${SUPABASE_URL}/functions/v1/review-ddi`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
            "apikey": SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            patientCode: patient.patient_code,
            proposedMedications: proposed.map((item) => ({
              name: item.name,
              ingredient: item.ingredient,
              dose: item.dose,
              unit: item.unit,
              route: item.route,
              frequency: item.frequency,
            })),
          }),
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!ddiResponse.ok) {
        const errText = await ddiResponse.text().catch(() => "");
        let serverMsg = `DDI review failed (HTTP ${ddiResponse.status})`;
        try { const parsed = JSON.parse(errText); serverMsg = parsed?.error || parsed?.message || serverMsg; } catch (_) {}
        throw new Error(serverMsg);
      }

      const data = await ddiResponse.json();

      finalFindings = Array.isArray(data?.findings) && data.findings.length > 0
        ? data.findings.map((finding) => ({
            ...makeFinding(
              finding.type || "Drug-Drug",
              finding.severity || "Low",
              finding.signal || "DDI review result",
              finding.detail || "No detail returned by the DDI agent.",
              finding.action || "Review the interaction evidence before saving.",
              finding.evidence || []
            ),
            left: finding.left,
            right: finding.right,
            leftSource: finding.leftSource,
            rightSource: finding.rightSource,
          }))
        : [
             makeFinding(
               "Drug-Drug",
               "None",
               "No drug interactions identified",
               "The DDI review agent did not identify any clinically significant drug-drug interactions for the reviewed pairs. Absence of identified interactions is not proof of safety.",
               "Use clinical judgment and verify unusual or high-risk combinations manually before saving."
             ),
          ];
    } catch (error) {
      setLoading(false);
      let errMsg = "The DDI review agent could not complete the review.";
      if (error && error.name === "AbortError") {
        errMsg = "The DDI review timed out. The AI is still processing — please try again in a moment.";
      } else if (error && error.message) {
        errMsg = error.message;
      }
      setMessage(errMsg);
      setReviewCompleted(false);
      setReviewFindings([
        makeFinding(
          "Drug-Drug",
          "Medium",
          "DDI review unavailable",
          errMsg,
          "Retry the review. If the error persists, manually verify all medication combinations using trusted clinical sources (PubMed, Medscape, Drugs.com, Empathia AI)."
        ),
      ]);
      return;
    }

    if (unresolved.length > 0) {
      finalFindings.unshift(
        makeFinding(
          "Ingredient Resolution",
          "Medium",
          `${unresolved.length} drug name(s) not confirmed online`,
          "The review used the entered medication name as the ingredient because online search did not return a clear active ingredient.",
          "Confirm the active ingredient before relying on the interaction result."
        )
      );
    }

    setReviewFindings(finalFindings);
    setReviewCompleted(true);
    setLoading(false);
    setMessage(`Interaction review completed: ${finalFindings.length} finding(s)`);
  }

  const pageTitle =
    activePage === "prescription"
      ? "Doctor prescription workspace"
      : activePage === "ehr"
        ? "Electronic health record"
        : "Interaction reports";

  return (
    <main className="appShell">
      <aside className="sidebar" aria-label="Clinical workspace navigation">
        <div className="brandLockup">
          <span className="brandMark">
            <Stethoscope size={22} />
          </span>
          <div>
            <strong>MedGuard Agent</strong>
            <span>Prescription Safety</span>
          </div>
        </div>

        <nav className="navStack">
          {pages.map((page) => {
            const Icon = page.icon;
            return (
              <button
                className={`navItem ${activePage === page.id ? "active" : ""}`}
                key={page.id}
                type="button"
                onClick={() => setActivePage(page.id)}
              >
                <Icon size={18} />
                {page.label}
              </button>
            );
          })}
        </nav>

        <div className="sidebarFoot">
          <span className="pulseDot" />
          <span>{message}</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Autonomous Clinical Workflow Agent</p>
            <h1>{pageTitle}</h1>
          </div>
          <button className="iconTextButton" type="button">
            <BellRing size={18} />
            {loading ? "Working" : "Ready"}
          </button>
        </header>

        {activePage === "prescription" && (
          <PrescriptionPage
            activeMeds={activeMeds}
            ehr={ehr}
            fetchPatient={fetchPatient}
            loading={loading}
            lookupCode={lookupCode}
            patient={patient}
            prescription={prescription}
            prescriptionItems={prescriptionItems}
            resetReview={resetReview}
            resolveOnePrescriptionIngredient={resolveOnePrescriptionIngredient}
            resolvePrescriptionIngredients={resolvePrescriptionIngredients}
            reviewCompleted={reviewCompleted}
            reviewFindings={reviewFindings}
            runInteractionReview={runInteractionReview}
            savePrescription={savePrescription}
            setLookupCode={setLookupCode}
            setPrescription={setPrescription}
            setPrescriptionItems={setPrescriptionItems}
            loadingReferences={loadingReferences}
            handleFetchReferences={handleFetchReferences}
            allergyFindings={allergyFindings}
            allergyReviewCompleted={allergyReviewCompleted}
            loadingAllergyReview={loadingAllergyReview}
            loadingAllergyReferences={loadingAllergyReferences}
            handleFetchAllergyReferences={handleFetchAllergyReferences}
            runAllergyReview={runAllergyReview}
            diseaseFindings={diseaseFindings}
            diseaseReviewCompleted={diseaseReviewCompleted}
            loadingDiseaseReview={loadingDiseaseReview}
            loadingDiseaseReferences={loadingDiseaseReferences}
            handleFetchDiseaseReferences={handleFetchDiseaseReferences}
            runDiseaseReview={runDiseaseReview}
          />
        )}

        {activePage === "ehr" && (
          <EhrPage
            activeMeds={activeMeds}
            addEhrRecord={addEhrRecord}
            addPatient={addPatient}
            addForm={addForm}
            addSection={addSection}
            changeAddSection={changeAddSection}
            changeEditSection={changeEditSection}
            chooseEditRecord={chooseEditRecord}
            editForm={editForm}
            editRecordId={editRecordId}
            editSection={editSection}
            ehr={ehr}
            fetchPatient={fetchPatient}
            loading={loading}
            lookupCode={lookupCode}
            newPatientCode={newPatientCode}
            newPatientRef={newPatientRef}
            newPatientStatus={newPatientStatus}
            patient={patient}
            patientEditForm={patientEditForm}
            saveEditedRecord={saveEditedRecord}
            setLookupCode={setLookupCode}
            setAddForm={setAddForm}
            setEditForm={setEditForm}
            setNewPatientCode={setNewPatientCode}
            setNewPatientRef={setNewPatientRef}
            setNewPatientStatus={setNewPatientStatus}
            setPatientEditForm={setPatientEditForm}
            updatePatientShell={updatePatientShell}
          />
        )}

        {activePage === "reports" && (
          <ReportsPage
            patient={patient}
            activePage={activePage}
          />
        )}
      </section>
    </main>
  );
}

function PatientSearch({ fetchPatient, lookupCode, setLookupCode, loading }) {
  return (
    <form
      className="lookupRow"
      onSubmit={(event) => {
        event.preventDefault();
        fetchPatient();
      }}
    >
      <label htmlFor="patient-id">Patient identifier</label>
      <div className="inputAction">
        <input
          id="patient-id"
          value={lookupCode}
          onChange={(event) => setLookupCode(event.target.value)}
        />
        <button type="submit" aria-label="Search patient" disabled={loading}>
          <Search size={19} />
        </button>
      </div>
    </form>
  );
}

function PrescriptionPage(props) {
  const {
    activeMeds,
    ehr,
    fetchPatient,
    loading,
    lookupCode,
    patient,
    prescriptionItems,
    resetReview,
    resolveOnePrescriptionIngredient,
    resolvePrescriptionIngredients,
    reviewCompleted,
    reviewFindings,
    runInteractionReview,
    savePrescription,
    setLookupCode,
    setPrescriptionItems,
    loadingReferences,
    handleFetchReferences,
    allergyFindings,
    allergyReviewCompleted,
    loadingAllergyReview,
    loadingAllergyReferences,
    handleFetchAllergyReferences,
    runAllergyReview,
    diseaseFindings,
    diseaseReviewCompleted,
    loadingDiseaseReview,
    loadingDiseaseReferences,
    handleFetchDiseaseReferences,
    runDiseaseReview,
  } = props;

  const updateItem = (id, field, value) => {
    setPrescriptionItems((items) =>
      items.map((item) =>
        item.id === id
          ? {
              ...item,
              [field]: value,
              ...(field === "name"
                ? {
                    ingredient: "",
                    resolutionStatus: "pending",
                    resolutionSource: "",
                    resolutionNote: "",
                  }
                : {}),
            }
          : item
      )
    );
    resetReview();
  };

  const addPrescriptionRow = () => {
    setPrescriptionItems((items) => [
      ...items,
      {
        id: `rx-${Date.now()}`,
        name: "",
        dose: "",
        unit: "mg",
        route: "Oral route",
        frequency: "",
        ingredient: "",
        resolutionStatus: "pending",
        resolutionSource: "",
        resolutionNote: "",
      },
    ]);
    resetReview();
  };

  const removePrescriptionRow = (id) => {
    setPrescriptionItems((items) =>
      items.length === 1 ? items : items.filter((item) => item.id !== id)
    );
    resetReview();
  };

  return (
    <section className="pageStack">
      <section className="twoColumn prescriptionLayout">
        <div className="primaryColumn">
          <section className="toolPanel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Step 1</p>
                <h2>Search patient before prescribing</h2>
              </div>
              <span className="statusPill">
                <Activity size={14} />
                Supabase EHR
              </span>
            </div>

            <PatientSearch
              fetchPatient={fetchPatient}
              loading={loading}
              lookupCode={lookupCode}
              setLookupCode={setLookupCode}
            />

            <PatientIdentity patient={patient} />
          </section>

          <section className="toolPanel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Step 2</p>
                <h2>Enter prescription</h2>
              </div>
              <span className="statusPill">
                <Pill size={14} />
                Active medication order
              </span>
            </div>

            <form onSubmit={savePrescription}>
              <div className="prescriptionList">
                {prescriptionItems.map((item, index) => (
                  <article className="prescriptionRow" key={item.id}>
                    <div className="rowHeader">
                      <strong>Drug {index + 1}</strong>
                      <button
                        className="textButton"
                        type="button"
                        onClick={() => removePrescriptionRow(item.id)}
                      >
                        Remove
                      </button>
                    </div>
                    <div className="prescriptionFields">
                      <label>
                        Medication name
                        <input
                          value={item.name}
                          onChange={(event) => updateItem(item.id, "name", event.target.value)}
                          onBlur={() => resolveOnePrescriptionIngredient(item.id)}
                        />
                      </label>
                      <label>
                        Dose
                        <input
                          value={item.dose}
                          onChange={(event) => updateItem(item.id, "dose", event.target.value)}
                        />
                      </label>
                      <label>
                        Unit
                        <input
                          value={item.unit}
                          onChange={(event) => updateItem(item.id, "unit", event.target.value)}
                        />
                      </label>
                      <label>
                        Route
                        <input
                          value={item.route}
                          onChange={(event) => updateItem(item.id, "route", event.target.value)}
                        />
                      </label>
                      <label>
                        Frequency
                        <input
                          value={item.frequency}
                          onChange={(event) => updateItem(item.id, "frequency", event.target.value)}
                        />
                      </label>
                    </div>
                    <button
                      className="inlineResolveButton"
                      type="button"
                      onClick={() => resolveOnePrescriptionIngredient(item.id)}
                      disabled={!item.name.trim() || loading}
                    >
                      <Search size={15} />
                      Search ingredient
                    </button>
                    <div className="inlineHint">
                      Ingredient:{" "}
                      <strong>{item.ingredient || (item.name ? "not resolved yet" : "not set")}</strong>
                      {item.name && (
                        <span className={`ingredientStatus ${item.resolutionStatus || "pending"}`}>
                          {item.resolutionStatus || "pending"}
                        </span>
                      )}
                      {item.resolutionNote && <span>{item.resolutionNote}</span>}
                    </div>
                  </article>
                ))}
              </div>

              <button className="secondaryButton wideButton spacedButton" type="button" onClick={addPrescriptionRow}>
                <Plus size={17} />
                Add another drug
              </button>

              <button
                className="secondaryButton wideButton spacedButton"
                type="button"
                onClick={resolvePrescriptionIngredients}
                disabled={loading}
              >
                <Search size={17} />
                Resolve active ingredients online
              </button>

              <div className="normalizationStrip">
                <Sparkles size={18} />
                <span>
                  Ingredients queued:{" "}
                  <strong>
                    {prescriptionItems
                      .map((item) => item.ingredient || item.name.trim())
                      .filter(Boolean)
                      .join(", ") || "none"}
                  </strong>
                </span>
              </div>

              <div className="actionSplit">
                <button
                  className="secondaryButton wideButton"
                  type="button"
                  onClick={runInteractionReview}
                  disabled={!patient || loading}
                >
                  <Microscope size={17} />
                  Run DDI Review
                </button>
                <button
                  className="allergyReviewButton wideButton"
                  type="button"
                  onClick={runAllergyReview}
                  disabled={!patient || loading || loadingAllergyReview}
                >
                  <ShieldCheck size={17} />
                  {loadingAllergyReview ? "Running Allergy Check..." : "Run Allergy Check"}
                </button>
                <button
                  className="diseaseReviewButton wideButton"
                  type="button"
                  onClick={runDiseaseReview}
                  disabled={!patient || loading || loadingDiseaseReview}
                >
                  <HeartPulse size={17} />
                  {loadingDiseaseReview ? "Running Disease Check..." : "Run Disease Check"}
                </button>
                <button
                  className="primaryButton"
                  type="submit"
                  disabled={!patient || loading || !reviewCompleted}
                >
                  <Save size={19} />
                  Save after review
                </button>
              </div>
              {!reviewCompleted && (
                <p className="emptyText spacedText">
                  Run the interaction review before saving the prescription to the EHR.
                </p>
              )}
              {reviewFindings.length > 0 && (
                <div className="inlineReport">
                  {reviewFindings.map((finding, index) => {
                    const parsed = parseFindingDetail(finding);
                    return (
                      <article className="findingCard compactFinding" key={`${finding.type}-${index}`}>
                        <div className={`severityBadge ${finding.severity.toLowerCase()}`}>
                          {finding.severity.toLowerCase() === "none" ? (
                            <ShieldCheck size={16} />
                          ) : (
                            <AlertTriangle size={16} />
                          )}
                          {finding.severity}
                        </div>
                        <div className="findingBody">
                          <span>{finding.type}</span>
                          <h3>{finding.signal}</h3>
                          {parsed.reasoning && (
                            <div className="findingReasoning">
                              <strong>Clinical Reasoning</strong>
                              <p>{parsed.reasoning}</p>
                            </div>
                          )}
                          <p>{parsed.detail}</p>
                          <strong>{finding.action}</strong>

                        </div>
                      </article>
                    );
                  })}
                </div>
              )}

              {/* Drug-to-Allergy Findings */}
              {allergyFindings.length > 0 && (
                <div className="inlineReport allergyReport">
                  <div className="allergyReportHeader">
                    <ShieldCheck size={16} />
                    <span>Drug-to-Allergy Analysis</span>
                  </div>
                  {allergyFindings.map((finding, index) => {
                    const parsed = parseFindingDetail(finding);
                    return (
                      <article className="findingCard compactFinding allergyFindingCard" key={`allergy-${finding.signal}-${index}`}>
                        <div className={`severityBadge allergy-${finding.severity.toLowerCase()}`}>
                          {finding.severity.toLowerCase() === "none" ? (
                            <ShieldCheck size={16} />
                          ) : (
                            <AlertTriangle size={16} />
                          )}
                          {finding.severity}
                        </div>
                        <div className="findingBody">
                          <span>{finding.type}</span>
                          <h3>{finding.signal}</h3>
                          {parsed.reasoning && (
                            <div className="findingReasoning">
                              <strong>Clinical Reasoning</strong>
                              <p>{parsed.reasoning}</p>
                            </div>
                          )}
                          <p>{parsed.detail}</p>
                          <strong>{finding.action}</strong>

                        </div>
                      </article>
                    );
                  })}
                </div>
              )}

              {/* Drug-to-Disease Findings */}
              {diseaseFindings.length > 0 && (
                <div className="inlineReport diseaseReport">
                  <div className="diseaseReportHeader">
                    <HeartPulse size={16} />
                    <span>Drug-to-Disease Analysis</span>
                  </div>
                  {diseaseFindings.map((finding, index) => {
                    const parsed = parseFindingDetail(finding);
                    return (
                      <article className="findingCard compactFinding diseaseFindingCard" key={`disease-${finding.signal}-${index}`}>
                        <div className={`severityBadge disease-${finding.severity.toLowerCase()}`}>
                          {finding.severity.toLowerCase() === "none" ? (
                            <HeartPulse size={16} />
                          ) : (
                            <AlertTriangle size={16} />
                          )}
                          {finding.severity}
                        </div>
                        <div className="findingBody">
                          <span>{finding.type}</span>
                          <h3>{finding.signal}</h3>
                          {parsed.reasoning && (
                            <div className="findingReasoning" style={{ borderLeftColor: "var(--purple, #a855f7)", background: "#faf5ff" }}>
                              <strong style={{ color: "var(--purple, #a855f7)" }}>Clinical Reasoning</strong>
                              <p>{parsed.reasoning}</p>
                            </div>
                          )}
                          <p>{parsed.detail}</p>
                          <strong>{finding.action}</strong>

                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </form>
          </section>
        </div>

        <aside className="sideStack">
          <section className="toolPanel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Patient context</p>
                <h2>Safety snapshot</h2>
              </div>
            </div>
            <MetricGrid
              items={[
                ["Active meds", activeMeds.length],
                ["Allergies", ehr?.allergies?.length || 0],
                ["Conditions", ehr?.conditions?.length || 0],
                ["Labs/vitals", ehr?.observations?.length || 0],
              ]}
            />
          </section>

          <section className="toolPanel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Agent status</p>
                <h2>Review pipeline</h2>
              </div>
            </div>
            <AgentStack />
          </section>
        </aside>
      </section>
    </section>
  );
}

function EhrPage(props) {
  const {
    activeMeds,
    addEhrRecord,
    addPatient,
    addForm,
    addSection,
    changeAddSection,
    changeEditSection,
    chooseEditRecord,
    editForm,
    editRecordId,
    editSection,
    ehr,
    fetchPatient,
    loading,
    lookupCode,
    newPatientCode,
    newPatientRef,
    newPatientStatus,
    patient,
    patientEditForm,
    saveEditedRecord,
    setLookupCode,
    setAddForm,
    setEditForm,
    setNewPatientCode,
    setNewPatientRef,
    setNewPatientStatus,
    setPatientEditForm,
    updatePatientShell,
  } = props;

  return (
    <section className="pageStack">
      <section className="toolPanel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">EHR lookup</p>
            <h2>View and maintain patient record</h2>
          </div>
          <span className="statusPill">
            <Database size={14} />
            Normalized record
          </span>
        </div>
        <PatientSearch
          fetchPatient={fetchPatient}
          loading={loading}
          lookupCode={lookupCode}
          setLookupCode={setLookupCode}
        />
        <PatientIdentity patient={patient} />
      </section>

      <section className="ehrManageGrid">
        <form className="toolPanel miniForm flatForm" onSubmit={addPatient}>
          <div className="panelHeader">
            <div>
              <p className="eyebrow">New record</p>
              <h2>Add patient shell</h2>
            </div>
            <FilePlus2 size={20} />
          </div>
          <label>
            Patient code
            <input
              value={newPatientCode}
              onChange={(event) => setNewPatientCode(event.target.value)}
            />
          </label>
          <label>
            External EHR reference
            <input value={newPatientRef} onChange={(event) => setNewPatientRef(event.target.value)} />
          </label>
          <label>
            Record status
            <select value={newPatientStatus} onChange={(event) => setNewPatientStatus(event.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="superseded">Superseded</option>
              <option value="entered_in_error">Entered in error</option>
            </select>
          </label>
          <button className="secondaryButton wideButton" type="submit" disabled={loading}>
            <Plus size={17} />
            Add patient
          </button>
        </form>

        <form className="toolPanel miniForm flatForm" onSubmit={updatePatientShell}>
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Patient shell</p>
              <h2>Edit current patient status</h2>
            </div>
            <Save size={20} />
          </div>
          <label>
            External EHR reference
            <input
              value={patientEditForm.external_record_ref}
              onChange={(event) =>
                setPatientEditForm({ ...patientEditForm, external_record_ref: event.target.value })
              }
            />
          </label>
          <label>
            Record status
            <select
              value={patientEditForm.record_status}
              onChange={(event) =>
                setPatientEditForm({ ...patientEditForm, record_status: event.target.value })
              }
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="superseded">Superseded</option>
              <option value="entered_in_error">Entered in error</option>
            </select>
          </label>
          <button className="secondaryButton wideButton" type="submit" disabled={!patient || loading}>
            <Save size={17} />
            Update patient
          </button>
        </form>
      </section>

      <section className="ehrEditorGrid">
        <form className="toolPanel miniForm flatForm" onSubmit={addEhrRecord}>
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Add EHR section</p>
              <h2>Add complete record row</h2>
            </div>
            <Plus size={20} />
          </div>
          <label>
            Section
            <select value={addSection} onChange={(event) => changeAddSection(event.target.value)}>
              {Object.entries(ehrSections).map(([key, config]) => (
                <option key={key} value={key}>
                  {config.label}
                </option>
              ))}
            </select>
          </label>
          <DynamicRecordFields
            form={addForm}
            sectionKey={addSection}
            setForm={setAddForm}
          />
          <button className="secondaryButton wideButton" type="submit" disabled={!patient || loading}>
            <Save size={17} />
            Add {ehrSections[addSection].label}
          </button>
        </form>

        <form className="toolPanel miniForm flatForm" onSubmit={saveEditedRecord}>
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Edit EHR section</p>
              <h2>Update existing row</h2>
            </div>
            <Save size={20} />
          </div>
          <div className="formGrid">
            <label>
              Section
              <select value={editSection} onChange={(event) => changeEditSection(event.target.value)}>
                {Object.entries(ehrSections).map(([key, config]) => (
                  <option key={key} value={key}>
                    {config.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Existing record
              <select
                value={editRecordId}
                onChange={(event) => chooseEditRecord(editSection, event.target.value)}
              >
                <option value="">Select record</option>
                {(ehr?.[ehrSections[editSection].collection] || []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {ehrSections[editSection].display(row)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <DynamicRecordFields
            form={editForm}
            sectionKey={editSection}
            setForm={setEditForm}
          />
          <button className="secondaryButton wideButton" type="submit" disabled={!patient || !editRecordId || loading}>
            <Save size={17} />
            Save edited row
          </button>
        </form>
      </section>

      <section className="ehrRecordGrid">
        <RecordTable title="Encounters" rows={ehr?.encounters || []} columns={["encounter_code", "encounter_class", "service_area", "reason_for_visit", "status"]} />
        <RecordTable title="Medications" rows={activeMeds} columns={["medication_display", "active_ingredient", "dose_value", "dose_unit", "frequency_text"]} />
        <RecordTable title="Conditions" rows={ehr?.conditions || []} columns={["condition_display", "source_code", "clinical_status", "severity", "recorded_date"]} />
        <RecordTable title="Allergies" rows={ehr?.allergies || []} columns={["substance_display", "substance_category", "reaction_display", "criticality"]} />
        <RecordTable title="Labs and vitals" rows={ehr?.observations || []} columns={["observation_display", "value_text", "value_number", "unit", "interpretation"]} />
        <RecordTable title="Clinical notes" rows={ehr?.clinical_notes || []} columns={["note_type", "note_text", "authored_at", "note_status"]} wide />
      </section>
    </section>
  );
}

function ReportsPage({ patient, activePage }) {
  const [reports, setReports] = useState([]);
  const [selectedReport, setSelectedReport] = useState(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const fetchReports = async () => {
    if (!patient?.patient_code) {
      setReports([]);
      setSelectedReport(null);
      return;
    }
    setLocalLoading(true);
    setErrorMsg("");
    try {
      const { data: ptData, error: ptError } = await supabase
        .from("ehr_patients")
        .select("id")
        .eq("patient_code", patient.patient_code)
        .single();
      if (ptError) throw ptError;
      if (!ptData) {
        setReports([]);
        setSelectedReport(null);
        return;
      }

      const { data: sessions, error: sessionsError } = await supabase
        .from("prescription_review_sessions")
        .select(`
          id,
          patient_id,
          requested_medications,
          normalized_ingredients,
          overall_severity,
          report_status,
          created_at,
          interaction_findings (
            id,
            interaction_type,
            severity,
            signal,
            explanation,
            recommendation,
            evidence
          )
        `)
        .eq("patient_id", ptData.id)
        .order("created_at", { ascending: false });

      if (sessionsError) throw sessionsError;
      setReports(sessions || []);
      if (sessions && sessions.length > 0) {
        setSelectedReport(sessions[0]);
      } else {
        setSelectedReport(null);
      }
    } catch (err) {
      console.error("Error fetching reports:", err);
      setErrorMsg("Failed to load reports: " + err.message);
    } finally {
      setLocalLoading(false);
    }
  };

  const clearAllReports = async () => {
    if (!patient?.patient_code) return;
    if (!window.confirm(`Are you sure you want to delete all past review sessions for patient ${patient.patient_code}? This action cannot be undone.`)) {
      return;
    }
    setLocalLoading(true);
    setErrorMsg("");
    try {
      const { data: ptData, error: ptError } = await supabase
        .from("ehr_patients")
        .select("id")
        .eq("patient_code", patient.patient_code)
        .single();
      if (ptError) throw ptError;
      if (!ptData) return;

      const { error: deleteError } = await supabase
        .from("prescription_review_sessions")
        .delete()
        .eq("patient_id", ptData.id);

      if (deleteError) throw deleteError;

      setReports([]);
      setSelectedReport(null);
    } catch (err) {
      console.error("Error deleting reports:", err);
      setErrorMsg("Failed to delete reports: " + err.message);
    } finally {
      setLocalLoading(false);
    }
  };

  useEffect(() => {
    if (activePage === "reports") {
      fetchReports();
    }
  }, [patient?.patient_code, activePage]);

  const formatDate = (isoString) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (e) {
      return isoString;
    }
  };

  if (!patient) {
    return (
      <section className="pageStack">
        <div className="reportsEmptyState">
          <AlertTriangle size={48} className="severityBadge none" />
          <h2>No patient loaded</h2>
          <p>Search for a patient record on the Prescription or EHR tab to view their safety reports.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="pageStack">
      {localLoading && reports.length === 0 ? (
        <p className="emptyText">Loading reports...</p>
      ) : errorMsg ? (
        <p className="emptyText" style={{ color: "var(--red)" }}>{errorMsg}</p>
      ) : reports.length === 0 ? (
        <div className="reportsEmptyState">
          <AlertTriangle size={48} style={{ color: "var(--muted)" }} />
          <h2>No reports found</h2>
          <p>No prescription safety reports exist for patient <strong>{patient.patient_code}</strong>. Go to the Prescription tab to enter medications and run a review.</p>
        </div>
      ) : (
        <div className="reportsLayout">
          <aside className="reportsSidebar" aria-label="Past reports list">
            <div className="toolPanel compactPanel">
              <div className="panelHeader" style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                  <div>
                    <p className="eyebrow">Select Report</p>
                    <h2>Past Sessions ({reports.length})</h2>
                  </div>
                  <button 
                    onClick={clearAllReports}
                    style={{ 
                      fontSize: '0.78rem', 
                      padding: '4px 10px', 
                      border: '1px solid var(--red)', 
                      borderRadius: '6px', 
                      background: 'var(--red-bg)',
                      color: 'var(--red)',
                      fontWeight: '800',
                      cursor: 'pointer',
                    }}
                    type="button"
                    disabled={localLoading}
                  >
                    Delete All
                  </button>
                </div>
              </div>
              <div className="reportsList">
                {reports.map((report) => {
                  const medsList = Array.isArray(report.requested_medications)
                    ? report.requested_medications.map(m => m.name || m.ingredient).filter(Boolean).join(", ")
                    : "No meds specified";
                  const isActive = selectedReport?.id === report.id;
                  const severity = report.overall_severity || "none";
                  return (
                    <button
                      key={report.id}
                      className={`reportListItem ${isActive ? "active" : ""}`}
                      onClick={() => setSelectedReport(report)}
                      type="button"
                    >
                      <div className="reportListHeader">
                        <span className="reportListDate">{formatDate(report.created_at)}</span>
                        <span className={`severityBadge compact ${severity.toLowerCase()}`}>
                          {severity}
                        </span>
                      </div>
                      <div className="reportListMeds" title={medsList}>{medsList}</div>
                      <div className="reportListStatus">Status: {report.report_status}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          <main className="activeReportContainer">
            {selectedReport && (
              <section className="toolPanel">
                <div className="reportDetailHeader">
                  <div className="reportTitleGroup">
                    <h2>Prescription Safety Report</h2>
                    <p className="reportMetaText">
                      Patient: <strong>{patient.patient_code}</strong> | Reviewed: {formatDate(selectedReport.created_at)}
                    </p>
                  </div>
                  <div className={`severityBadge ${(selectedReport.overall_severity || "none").toLowerCase()}`}>
                    <AlertTriangle size={18} />
                    {selectedReport.overall_severity ? (selectedReport.overall_severity.charAt(0).toUpperCase() + selectedReport.overall_severity.slice(1)) : "None"} Severity
                  </div>
                </div>

                <div className="findingsList" style={{ marginTop: "20px" }}>
                  {selectedReport.interaction_findings && selectedReport.interaction_findings.length > 0 ? (
                    selectedReport.interaction_findings.map((finding, idx) => {
                      const parsed = parseFindingDetail(finding);
                      return (
                        <article className="findingDetailCard" key={finding.id || idx}>
                          <div className="findingDetailHeader">
                            <div className={`severityBadge ${(finding.severity || "low").toLowerCase()}`}>
                              {(finding.severity || "").toLowerCase() === "none" ? (
                                <ShieldCheck size={15} />
                              ) : (
                                <AlertTriangle size={15} />
                              )}
                              {finding.severity ? (finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)) : "Low"}
                            </div>
                            <h3 className="findingDetailTitle">{finding.signal}</h3>
                          </div>
                          <div className="findingDetailBody">
                            <div className="findingSection">
                              <span className="findingSectionLabel">Clinical Assessment</span>
                              {parsed.reasoning && (
                                <div className="findingReasoning">
                                  <strong>Clinical Reasoning</strong>
                                  <p>{parsed.reasoning}</p>
                                </div>
                              )}
                              <p className="findingExplanation">{parsed.detail}</p>
                            </div>
                          <div className="findingSection">
                            <span className="findingSectionLabel">Action Plan / Recommendation</span>
                            <p className="findingRecommendation">{finding.recommendation}</p>
                          </div>
                          {finding.evidence && Array.isArray(finding.evidence) && finding.evidence.length > 0 && (
                            <div className="findingEvidence">
                              <span className="evidenceTitle">Clinical References & Evidence:</span>
                              <ul className="evidenceList">
                                {finding.evidence.map((ev, evIdx) => {
                                  const url = ev.url || ev.websiteUrl;
                                  const source = ev.source || ev.severityLabel || (url ? new URL(url).hostname.replace("www.", "") : "Reference");
                                  const title = ev.title || ev.description || "Interaction source record";
                                  if (url) {
                                    return (
                                      <li key={evIdx}>
                                        <a href={url} target="_blank" rel="noopener noreferrer" className="evidenceLink">
                                          {source}: {title}
                                        </a>
                                      </li>
                                    );
                                  }
                                  return (
                                    <li key={evIdx}>
                                      <span className="evidenceText">
                                        {source}: {title}
                                      </span>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })
                  ) : (
                    <div className="reportsEmptyState" style={{ padding: "30px 20px" }}>
                      <AlertTriangle size={32} style={{ color: "var(--muted)" }} />
                      <p>No specific interaction findings were generated for this session. Use standard clinical judgment.</p>
                    </div>
                  )}
                </div>
              </section>
            )}
          </main>
        </div>
      )}
    </section>
  );
}

function DynamicRecordFields({ form, sectionKey, setForm }) {
  const config = ehrSections[sectionKey];
  return (
    <div className="dynamicFields">
      {config.fields.map((field) => (
        <label className={field.type === "textarea" ? "wideField" : ""} key={field.name}>
          {field.label}
          {field.type === "select" ? (
            <select
              value={form[field.name] || ""}
              onChange={(event) => setForm({ ...form, [field.name]: event.target.value })}
            >
              <option value="">Select</option>
              {field.options.map((option) => (
                <option key={option} value={option}>
                  {option.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          ) : field.type === "textarea" ? (
            <textarea
              value={form[field.name] || ""}
              onChange={(event) => setForm({ ...form, [field.name]: event.target.value })}
            />
          ) : (
            <input
              type={field.type || "text"}
              value={form[field.name] || ""}
              onChange={(event) => setForm({ ...form, [field.name]: event.target.value })}
            />
          )}
        </label>
      ))}
    </div>
  );
}

function PatientIdentity({ patient }) {
  return (
    <div className="patientBand">
      <div className="avatar">
        <UserRound size={28} />
      </div>
      <div>
        <strong>{patient?.patient_code || "No patient loaded"}</strong>
        <span>
          {patient?.external_record_ref || "Search for a patient record"} / {patient?.record_status || "unknown"}
        </span>
      </div>
    </div>
  );
}

function MetricGrid({ items }) {
  return (
    <div className="metricGrid">
      {items.map(([label, value]) => (
        <div className="metricTile" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function AgentStack() {
  return (
    <div className="agentStack">
      {agentStatus.map((agent) => {
        const Icon = agent.icon;
        return (
          <div className="agentRow" key={agent.label}>
            <span>
              <Icon size={17} />
            </span>
            <div>
              <strong>{agent.label}</strong>
              <small>{agent.status}</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RecordTable({ title, rows, columns, wide = false }) {
  return (
    <section className={`toolPanel recordPanel ${wide ? "wideRecord" : ""}`}>
      <div className="panelHeader">
        <div>
          <p className="eyebrow">EHR section</p>
          <h2>{title}</h2>
        </div>
        <span className="reportScore">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="emptyText">No records available.</p>
      ) : (
        <div className="tableScroller">
          <table className="recordTable">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column.replaceAll("_", " ")}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.id || row[columns[0]] || index}>
                  {columns.map((column) => (
                    <td key={column}>{row[column] ?? "n/a"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default App;
