import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://usiezbetbsziwsqrqwmc.supabase.co";
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVzaWV6YmV0YnN6aXdzcXJxd21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMDM2ODgsImV4cCI6MjA5NDc3OTY4OH0.ahXzNPXRYEJKghaz0uNIuY8n_4q4uSuUgL1xoJRuOoc";

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function run() {
  try {
    const { data: patient, error: patientError } = await supabase
      .from("ehr_patients")
      .select("id, patient_code")
      .eq("id", "f660c4ff-cd70-4880-872a-2fd6bde90ed8")
      .single();

    if (patientError) throw patientError;
    console.log("Patient Code:", patient.patient_code);

    // 2. Fetch the EHR using get_patient_ehr rpc
    const { data: ehr, error: ehrError } = await supabase
      .rpc("get_patient_ehr", { p_patient_code: patient.patient_code });

    if (ehrError) throw ehrError;

    console.log("\n--- ACTIVE MEDICATIONS ---");
    const activeMeds = (ehr.medications || [])
      .filter((med) => String(med.medication_status || "").toLowerCase() === "active");
    
    activeMeds.forEach(med => {
      console.log(`- ${med.medication_display} (${med.active_ingredient}) | Status: ${med.medication_status}`);
    });

    console.log("\n--- CONDITIONS ---");
    (ehr.conditions || []).forEach(cond => {
      console.log(`- ${cond.condition_display} | Status: ${cond.clinical_status} | Severity: ${cond.severity}`);
    });

    console.log("\n--- ALLERGIES ---");
    (ehr.allergies || []).forEach(alg => {
      console.log(`- Substance: ${alg.substance_display} | Reaction: ${alg.reaction_display}`);
    });

  } catch (error) {
    console.error("Error retrieving patient EHR:", error);
  }
}

run();
