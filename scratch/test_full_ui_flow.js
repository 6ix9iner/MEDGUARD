import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://usiezbetbsziwsqrqwmc.supabase.co";
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVzaWV6YmV0YnN6aXdzcXJxd21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMDM2ODgsImV4cCI6MjA5NDc3OTY4OH0.ahXzNPXRYEJKghaz0uNIuY8n_4q4uSuUgL1xoJRuOoc";

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function testFlow() {
  // Step 1: Resolve drug ingredient (same as UI does)
  console.log("=== Step 1: Resolving drug ingredient for 'Cimetidine' ===");
  try {
    const { data: resolveData, error: resolveError } = await supabase.functions.invoke("resolve-drug-ingredient", {
      body: { drugName: "Cimetidine" },
    });
    if (resolveError) {
      console.error("RESOLVE ERROR:", resolveError.name, resolveError.message);
      if (resolveError.context) {
        try {
          const body = await resolveError.context.json();
          console.error("RESOLVE ERROR BODY:", JSON.stringify(body));
        } catch (e) {
          try {
            const text = await resolveError.context.text();
            console.error("RESOLVE ERROR TEXT:", text);
          } catch (e2) {}
        }
      }
    } else {
      console.log("RESOLVE SUCCESS:", JSON.stringify(resolveData, null, 2));
    }
  } catch (e) {
    console.error("RESOLVE CATCH:", e.message);
  }

  // Step 2: Run DDI review (same as UI does)
  console.log("\n=== Step 2: Running DDI review for 'Cimetidine' on EHR-PT-0001 ===");
  try {
    const { data: reviewData, error: reviewError } = await supabase.functions.invoke("review-ddi", {
      body: {
        patientCode: "EHR-PT-0001",
        proposedMedications: [
          { name: "Cimetidine", ingredient: "cimetidine", dose: "400", unit: "mg", route: "Oral route", frequency: "twice daily" }
        ],
      },
    });
    if (reviewError) {
      console.error("REVIEW ERROR:", reviewError.name, reviewError.message);
      if (reviewError.context) {
        try {
          const body = await reviewError.context.json();
          console.error("REVIEW ERROR BODY:", JSON.stringify(body));
        } catch (e) {
          try {
            const text = await reviewError.context.text();
            console.error("REVIEW ERROR TEXT:", text);
          } catch (e2) {}
        }
      }
    } else {
      console.log("REVIEW SUCCESS - overallSeverity:", reviewData?.overallSeverity);
      console.log("REVIEW SUCCESS - findings count:", reviewData?.findings?.length);
      console.log("REVIEW SUCCESS - geminiError:", reviewData?.geminiError);
    }
  } catch (e) {
    console.error("REVIEW CATCH:", e.message);
  }
}

testFlow();
