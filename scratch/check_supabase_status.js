const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = "usiezbetbsziwsqrqwmc";

async function run() {
  try {
    if (!accessToken) {
      throw new Error("Set SUPABASE_ACCESS_TOKEN before running this script.");
    }
    const url = `https://api.supabase.com/v1/projects/${projectRef}`;
    console.log(`Fetching project details from: ${url}`);
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    console.log(`Status code: ${res.status}`);
    const data = await res.json();
    console.log("Project info:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed:", err);
  }
}

run();
