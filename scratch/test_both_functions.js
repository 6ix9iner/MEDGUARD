const supabaseUrl = "https://usiezbetbsziwsqrqwmc.supabase.co";
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVzaWV6YmV0YnN6aXdzcXJxd21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMDM2ODgsImV4cCI6MjA5NDc3OTY4OH0.ahXzNPXRYEJKghaz0uNIuY8n_4q4uSuUgL1xoJRuOoc";

async function testResolve() {
  console.log("\n--- Testing resolve-drug-ingredient ---");
  const response = await fetch(`${supabaseUrl}/functions/v1/resolve-drug-ingredient`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${supabaseAnonKey}`,
    },
    body: JSON.stringify({ drugName: "Clopidogrel" }),
  });
  console.log("Resolve Status:", response.status);
  const text = await response.text();
  console.log("Resolve Response Text:", text);
}

async function testReview() {
  console.log("\n--- Testing review-ddi ---");
  const response = await fetch(`${supabaseUrl}/functions/v1/review-ddi`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${supabaseAnonKey}`,
    },
    body: JSON.stringify({
      patientCode: "EHR-PT-0001",
      proposedMedications: [
        { name: "Cimetidine", ingredient: "cimetidine", dose: "400", unit: "mg", route: "Oral route", frequency: "twice daily" }
      ],
    }),
  });
  console.log("Review Status:", response.status);
  const text = await response.text();
  console.log("Review Response Text:", text.slice(0, 1000) + (text.length > 1000 ? "..." : ""));
}

async function run() {
  try {
    await testResolve();
    await testReview();
  } catch (err) {
    console.error("Test failed:", err);
  }
}

run();
