function parseFindingsText(text) {
  const findings = [];
  const blocks = text.split(/(?=Finding \d+:|FINDING \d+:)/i);
  
  for (const block of blocks) {
    if (!block.trim()) continue;
    
    let severity = "low";
    let signal = "";
    let detail = "";
    let action = "";
    const evidence = [];
    
    const lines = block.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      const sevMatch = trimmed.match(/^severity:\s*(none|low|medium|high|critical)/i);
      if (sevMatch) {
        severity = sevMatch[1].toLowerCase();
        continue;
      }
      
      const sigMatch = trimmed.match(/^signal:\s*(.*)/i);
      if (sigMatch) {
        signal = sigMatch[1].trim();
        continue;
      }
      
      const detMatch = trimmed.match(/^detail:\s*(.*)/i);
      if (detMatch) {
        detail = detMatch[1].trim();
        continue;
      }
      
      const actMatch = trimmed.match(/^action:\s*(.*)/i);
      if (actMatch) {
        action = actMatch[1].trim();
        continue;
      }
      
      const evMatch = trimmed.match(/^evidence:\s*(.*)/i);
      if (evMatch) {
        const parts = evMatch[1].split("|").map(p => p.trim());
        if (parts.length >= 3) {
          evidence.push({
            source: parts[0],
            title: parts[1],
            url: parts[2],
          });
        }
        continue;
      }
    }
    
    if (signal) {
      findings.push({
        type: "Drug-Drug",
        severity,
        signal,
        detail: detail || "No detail provided.",
        action: action || "No action recommended.",
        evidence,
      });
    }
  }
  
  return findings;
}

// Test input
const sample = `
Finding 1:
Severity: critical
Signal: Cimetidine and Metformin Interaction
Detail: Cimetidine inhibits OCT2 in the kidneys.
Action: Avoid co-administration.
Evidence: Drugs.com | Metformin and cimetidine | https://www.drugs.com/cimetidine-with-metformin.html
Evidence: PubMed | Lactic acidosis study | https://pubmed.ncbi.nlm.nih.gov/37948503/

Finding 2:
Severity: none
Signal: Cimetidine and Amlodipine
Detail: No interaction found.
Action: No clinical action.
`;

console.log("Parsed Findings:", JSON.stringify(parseFindingsText(sample), null, 2));
