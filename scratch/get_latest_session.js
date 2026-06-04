import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://usiezbetbsziwsqrqwmc.supabase.co";
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVzaWV6YmV0YnN6aXdzcXJxd21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMDM2ODgsImV4cCI6MjA5NDc3OTY4OH0.ahXzNPXRYEJKghaz0uNIuY8n_4q4uSuUgL1xoJRuOoc";

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function run() {
  try {
    const { data: session, error: sessionError } = await supabase
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
      .eq("id", "6b48b464-f185-4f44-aada-027eda71b069")
      .single();

    if (sessionError) throw sessionError;

    console.log("SESSION_DETAILS_START");
    console.log(JSON.stringify(session, null, 2));
    console.log("SESSION_DETAILS_END");
  } catch (error) {
    console.error("Error retrieving session details:", error);
  }
}

run();
