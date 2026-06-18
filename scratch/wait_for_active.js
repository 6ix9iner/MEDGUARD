const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = "usiezbetbsziwsqrqwmc";

async function run() {
  if (!accessToken) {
    throw new Error("Set SUPABASE_ACCESS_TOKEN before running this script.");
  }
  const url = `https://api.supabase.com/v1/projects/${projectRef}`;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      });
      const data = await res.json();
      console.log(`Check #${i + 1}: Status = ${data.status}`);
      if (data.status === "ACTIVE") {
        console.log("Project is now ACTIVE!");
        return;
      }
    } catch (err) {
      console.error("Fetch failed:", err.message);
    }
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  console.log("Timed out waiting for project to become ACTIVE.");
}

run();
