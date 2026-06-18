const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = "usiezbetbsziwsqrqwmc";

async function run() {
  try {
    if (!accessToken) {
      throw new Error("Set SUPABASE_ACCESS_TOKEN before running this script.");
    }
    // 1. Check restore status/eligibility
    const getUrl = `https://api.supabase.com/v1/projects/${projectRef}/restore`;
    console.log(`Checking eligibility/status via: ${getUrl}`);
    const getRes = await fetch(getUrl, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    console.log(`GET Restore Status code: ${getRes.status}`);
    const getData = await getRes.json();
    console.log("Restore status details:", JSON.stringify(getData, null, 2));

    // 2. If it's paused/inactive, attempt to restore
    console.log("\nAttempting to restore project...");
    const postRes = await fetch(getUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    console.log(`POST Restore Status code: ${postRes.status}`);
    const postData = await postRes.json();
    console.log("POST Restore result:", JSON.stringify(postData, null, 2));
  } catch (err) {
    console.error("Failed:", err);
  }
}

run();
