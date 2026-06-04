import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://usiezbetbsziwsqrqwmc.supabase.co";
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVzaWV6YmV0YnN6aXdzcXJxd21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMDM2ODgsImV4cCI6MjA5NDc3OTY4OH0.ahXzNPXRYEJKghaz0uNIuY8n_4q4uSuUgL1xoJRuOoc";

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function run() {
  console.log("Testing invoke error handling...");
  const { data, error } = await supabase.functions.invoke("review-ddi", {
    body: { patientCode: "EHR-PT-9999", proposedMedications: [{ name: "Cimetidine" }] },
  });

  if (error) {
    console.log("Error properties:");
    console.log("name:", error.name);
    console.log("message:", error.message);
    console.log("status:", error.status);
    console.log("Full error object keys:", Object.keys(error));
    // Let's see if we can get the text/json content if error has response or context
    if (error.context) {
      try {
        const text = await error.context.text();
        console.log("error.context.text():", text);
      } catch (e) {
        console.log("Failed to read error.context:", e.message);
      }
    }
  } else {
    console.log("Success data:", data);
  }
}

run();
