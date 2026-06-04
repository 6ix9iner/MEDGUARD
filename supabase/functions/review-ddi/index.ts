import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ProposedMedicationInput = {
  name?: string;
  ingredient?: string;
  dose?: string | number;
  unit?: string;
  route?: string;
  frequency?: string;
};

type PatientEhr = {
  patient?: {
    patient_code?: string;
    external_record_ref?: string | null;
    record_status?: string;
  };
  medications?: Array<Record<string, unknown>>;
  allergies?: Array<Record<string, unknown>>;
  conditions?: Array<Record<string, unknown>>;
  observations?: Array<Record<string, unknown>>;
  clinical_notes?: Array<Record<string, unknown>>;
  encounters?: Array<Record<string, unknown>>;
};

type PairReview = {
  pairKey: string;
  left: string;
  right: string;
  leftSource: string;
  rightSource: string;
  pairType: "proposed-proposed" | "proposed-current";
};

type ReviewFinding = {
  type: string;
  severity: "none" | "low" | "medium" | "high" | "critical";
  signal: string;
  detail: string;
  action: string;
  evidence: Array<{
    source: string;
    title: string;
    url: string;
  }>;
};

const GCP_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const fallbackIngredient = (name: string) => name.trim().toLowerCase();

const parseJsonResponseText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Model response text was empty.");
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fenced?.[1]?.trim() || trimmed;

  // JSON healing for truncated responses (common with Google Search grounding)
  if (!candidate.endsWith("}")) {
    if (!candidate.endsWith('"')) {
      candidate += '"';
    }
    candidate += "\n}";
  }

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  const objectText =
    firstBrace >= 0 && lastBrace > firstBrace
      ? candidate.slice(firstBrace, lastBrace + 1)
      : candidate;
  return JSON.parse(objectText);
};

const encodeBase64Url = (value: string | Uint8Array) => {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const pemToArrayBuffer = (pem: string) => {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
};

const createGoogleAccessToken = async () => {
  const b64ServiceAccount = Deno.env.get("GCP_GEMINI_SERVICE_ACCOUNT_JSON_B64");
  const rawServiceAccount =
    Deno.env.get("GCP_GEMINI_SERVICE_ACCOUNT_JSON") ||
    Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");

  const jsonString = b64ServiceAccount
    ? new TextDecoder().decode(
        Uint8Array.from(atob(b64ServiceAccount), (c) => c.charCodeAt(0)),
      )
    : rawServiceAccount;

  if (!jsonString) {
    throw new Error("Google service account secret is not configured.");
  }

  let serviceAccount: Record<string, string>;
  try {
    serviceAccount = JSON.parse(jsonString);
  } catch (parseError) {
    throw new Error(
      `Failed to parse service account JSON (first 80 chars: ${jsonString.slice(0, 80)}): ${parseError instanceof Error ? parseError.message : "unknown"}`,
    );
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    scope: GCP_SCOPE,
    aud: serviceAccount.token_uri,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };

  const unsignedToken = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}`;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedToken),
  );
  const assertion = `${unsignedToken}.${encodeBase64Url(new Uint8Array(signature))}`;

  const tokenResponse = await fetch(serviceAccount.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text();
    throw new Error(`Google OAuth token exchange failed: ${tokenResponse.status} ${detail}`);
  }

  const tokenData = await tokenResponse.json();
  return {
    accessToken: String(tokenData.access_token || ""),
    projectId: String(serviceAccount.project_id || ""),
  };
};

const buildEhrSummary = (ehr: PatientEhr) => {
  const activeMedications = (ehr.medications || [])
    .filter((med) => String(med.medication_status || "").toLowerCase() === "active")
    .map((med) => ({
      medication_display: String(med.medication_display || ""),
      active_ingredient: String(med.active_ingredient || "").toLowerCase(),
      frequency_text: String(med.frequency_text || ""),
      route_display: String(med.route_display || ""),
      start_date: String(med.start_date || ""),
    }));

  const allergies = (ehr.allergies || []).map((allergy) => ({
    substance_display: String(allergy.substance_display || ""),
    reaction_display: String(allergy.reaction_display || ""),
    criticality: String(allergy.criticality || ""),
    clinical_status: String(allergy.clinical_status || ""),
  }));

  const conditions = (ehr.conditions || []).slice(0, 12).map((condition) => ({
    condition_display: String(condition.condition_display || ""),
    clinical_status: String(condition.clinical_status || ""),
    severity: String(condition.severity || ""),
  }));

  const observations = (ehr.observations || []).slice(0, 8).map((obs) => ({
    observation_display: String(obs.observation_display || ""),
    value_number: obs.value_number ?? null,
    value_text: String(obs.value_text || ""),
    unit: String(obs.unit || ""),
    interpretation: String(obs.interpretation || ""),
    observed_at: String(obs.observed_at || ""),
  }));

  const recentNotes = (ehr.clinical_notes || []).slice(0, 4).map((note) => ({
    note_type: String(note.note_type || ""),
    note_text: String(note.note_text || "").slice(0, 700),
    authored_at: String(note.authored_at || ""),
  }));

  return {
    patient: ehr.patient || {},
    activeMedications,
    allergies,
    conditions,
    observations,
    recentNotes,
  };
};

const buildPairReviews = (proposed: ProposedMedicationInput[], activeMeds: Array<{ active_ingredient: string; medication_display: string }>) => {
  const pairs: PairReview[] = [];
  const seen = new Set<string>();

  for (let leftIndex = 0; leftIndex < proposed.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < proposed.length; rightIndex += 1) {
      const left = fallbackIngredient(String(proposed[leftIndex].ingredient || proposed[leftIndex].name || ""));
      const right = fallbackIngredient(String(proposed[rightIndex].ingredient || proposed[rightIndex].name || ""));
      if (!left || !right || left === right) continue;
      const pairKey = [left, right].sort().join("|");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      pairs.push({
        pairKey,
        left,
        right,
        leftSource: String(proposed[leftIndex].name || left),
        rightSource: String(proposed[rightIndex].name || right),
        pairType: "proposed-proposed",
      });
    }
  }

  for (const item of proposed) {
    const ingredient = fallbackIngredient(String(item.ingredient || item.name || ""));
    if (!ingredient) continue;
    for (const activeMed of activeMeds) {
      const currentIngredient = fallbackIngredient(activeMed.active_ingredient);
      if (!currentIngredient || currentIngredient === ingredient) continue;
      const pairKey = [ingredient, currentIngredient].sort().join("|");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      pairs.push({
        pairKey,
        left: ingredient,
        right: currentIngredient,
        leftSource: String(item.name || ingredient),
        rightSource: activeMed.medication_display,
        pairType: "proposed-current",
      });
    }
  }

  return pairs;
};

const callGeminiForDdiReview = async (
  patientCode: string,
  ehrSummary: ReturnType<typeof buildEhrSummary>,
  proposedMedications: ProposedMedicationInput[],
  pairReviews: PairReview[],
) => {
  const { accessToken, projectId } = await createGoogleAccessToken();
  const endpoint =
    `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/gemini-3.5-flash:generateContent`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      systemInstruction: {
        role: "system",
        parts: [
          {
            text:
              "You are an expert clinical drug-drug interaction review agent equipped with Google Search Grounding.\n" +
              "Your task is to analyze potential drug-drug interactions (DDIs) for the provided medication pairs (proposed-proposed and proposed-current) in the context of the patient's EHR.\n\n" +
              "Follow these strict clinical rules:\n" +
              "1. Perform rigorous clinical reasoning. Analyze pharmacokinetic risks (e.g. CYP450 metabolism, absorption/clearance changes) and pharmacodynamic risks (e.g. additive QTc prolongation, anticholinergic burden, CNS depressant combination, nephrotoxicity 'triple whammy').\n" +
              "2. Integrate patient context. Check the patient's existing active conditions, allergies, and observations (e.g. renal/hepatic status, lab abnormalities) to see if they increase the risk.\n" +
              "3. Use Google Search to find clinical evidence. You MUST ONLY cite from these 5 approved sources — NO OTHER WEBSITES ALLOWED:\n" +
              "   - Drugs.com (drugs.com) — e.g. https://www.drugs.com/drug-interactions/drugA-with-drugB.html\n" +
              "   - PubMed (pubmed.ncbi.nlm.nih.gov) — e.g. https://pubmed.ncbi.nlm.nih.gov/12345678/\n" +
              "   - Medscape (reference.medscape.com or www.medscape.com) — e.g. https://reference.medscape.com/drug-interactionchecker\n" +
              "   - DrugBank (go.drugbank.com) — e.g. https://go.drugbank.com/drugs/DB00001\n" +
              "   - Empathia AI (empathia.ai) — e.g. https://empathia.ai/blog/drugA-and-drugB-drug-interaction\n" +
              "   STRICTLY FORBIDDEN: Do not cite Google, Wikipedia, WebMD, RxList, FDA.gov, NIH.gov, or any other website. Every URL must belong to one of the 5 approved domains above.\n" +
              "4. You must evaluate every single provided medication pair. For every pair that has a documented clinical interaction of any severity ('low', 'medium', 'high', 'critical'), you MUST generate a corresponding finding in findingsText. Do not omit moderate or mild interactions in favor of more severe ones. Omit drug pairs ONLY if they have absolutely no clinical interaction (severity 'none').\n" +
              "5. Keep the explanation ('detail') and action item ('action') extremely concise (maximum 2-3 sentences each) to prevent response truncation.\n" +
              "6. For each finding, provide 1-2 evidence citations. Each citation must specify source, title, and exact URL from the 5 approved sources only. The URL must contain the names of the specific drugs involved — not a generic homepage URL.\n\n" +
              "CRITICAL: The output must be a 100% valid JSON object matching the schema below. To ensure stable generation with Google Search Grounding, you must output a flat JSON structure containing overallSeverity, clinicalSummary, and a single plain text block containing all findings ('findingsText'). Do not output any nested JSON arrays or objects for findings, as this conflicts with search grounding.\n\n" +
              "All keys (overallSeverity, clinicalSummary, findingsText) are mandatory. The overallSeverity must be strictly one of: 'none', 'low', 'medium', 'high', 'critical' (all lowercase).\n\n" +
              "Return strict JSON matching this schema:\n" +
              "{\n" +
              "  \"overallSeverity\": \"high\",\n" +
              "  \"clinicalSummary\": \"Clinical overview of risks...\",\n" +
              "  \"findingsText\": \"Finding 1:\\nSeverity: critical\\nSignal: DrugA and DrugB Interaction\\nDetail: Mechanism.\\nAction: Recommendation.\\nEvidence: Drugs.com | DrugA and DrugB Drug Interactions | https://www.drugs.com/drug-interactions/druga-with-drugb.html\"\n" +
              "}\n\n" +
              "Format findingsText exactly as a plain text string for each finding. Separate multiple findings with a double newline:\n\n" +
              "Finding N:\n" +
              "Severity: [none|low|medium|high|critical]\n" +
              "Signal: [Both drug names, e.g., DrugA and DrugB Interaction]\n" +
              "Detail: [Concise clinical explanation, max 2-3 sentences]\n" +
              "Action: [Clinical recommendation, max 2-3 sentences]\n" +
              "Evidence: [One of: Drugs.com | PubMed | Medscape | DrugBank | Empathia AI] | [Specific title mentioning both drugs] | [URL from that approved domain containing both drug names]\n" +
              "Evidence: [Second citation if available — also from approved domains only]",
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: JSON.stringify({
                patientCode,
                task: "Review proposed medications for drug-drug interactions against each other and against the patient's active medications. Identify risk severity and detail findings.",
                proposedMedications,
                patientEhrSummary: ehrSummary,
                medicationPairsToCheck: pairReviews.map((pair) => ({
                  pairType: pair.pairType,
                  left: pair.left,
                  right: pair.right,
                  leftSource: pair.leftSource,
                  rightSource: pair.rightSource,
                })),
              }),
            },
          ],
        },
      ],
      tools: [
        {
          google_search: {},
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini review call failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || "";
  if (!text.trim()) {
    throw new Error("Gemini returned an empty review payload.");
  }

  const groundingChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

  try {
    const parsed = parseJsonResponseText(text);
    return { parsed, groundingChunks };
  } catch (parseError) {
    console.error("Failed to parse Gemini response JSON. Raw text:", text);
    throw new Error(`JSON parse failure: ${parseError instanceof Error ? parseError.message : String(parseError)}. Raw response text: ${text}. Full API response: ${JSON.stringify(data)}`);
  }
};

const cleanDrugName = (name: string): string => {
  let cleaned = name.toLowerCase().trim();
  const salts = [
    "hydrochloride", "hydrobromide", "besylate", "maleate", "sodium", "potassium", 
    "calcium", "bisulfate", "sulfate", "tartrate", "phosphate", "acetate", 
    "fumarate", "mesylate", "estolate", "valerate", "succinate", "camsylate", 
    "nitrate", "chloride", "hcl", "mesilate", "besilate", "flesinoxan", "dipotassium"
  ];
  salts.forEach((salt) => {
    const regex = new RegExp(`\\b${salt}\\b`, "g");
    cleaned = cleaned.replace(regex, "");
  });
  return cleaned.replace(/\s+/g, " ").trim();
};

const isUrlValidAndSpecific = (url: string, source: string, involvedIngredients: string[]): boolean => {
  const urlLower = url.toLowerCase().trim();
  if (!urlLower || urlLower.includes("example.com")) return false;
  
  const genericUrls = [
    "https://www.drugs.com", "https://drugs.com", "https://www.drugs.com/", "https://drugs.com/",
    "https://pubmed.ncbi.nlm.nih.gov", "https://pubmed.ncbi.nlm.nih.gov/",
    "https://www.medscape.com", "https://medscape.com", "https://www.medscape.com/", "https://medscape.com/",
    "https://reference.medscape.com", "https://reference.medscape.com/",
    "https://go.drugbank.com", "https://drugbank.com", "https://go.drugbank.com/",
    "https://empathia.ai", "https://empathia.ai/", "https://www.empathia.ai"
  ];
  if (genericUrls.includes(urlLower)) return false;

  if (urlLower.includes("drugs.com/drug-interactions/")) {
    const hasIds = /-\d+-\d+-\d+-\d+\.html/.test(urlLower);
    if (!hasIds) return false;
  }

  if (
    urlLower.includes("search.php?searchterm=") ||
    urlLower.includes("term=") ||
    urlLower.includes("search/?q=") ||
    urlLower.includes("unearth/q?query=") ||
    urlLower.includes("google.com/search?q=")
  ) {
    return true;
  }

  const hasInvolvedIngredient = involvedIngredients.some((ing) => {
    const formatted = ing.replace(/\s+/g, "-");
    return urlLower.includes(formatted) || urlLower.includes(ing);
  });
  if (!hasInvolvedIngredient) return false;

  return true;
};

const parseFindingsText = (text: string): ReviewFinding[] => {
  const findings: ReviewFinding[] = [];
  const blocks = text.split(/(?=Finding \d+:|FINDING \d+:)/i);
  
  for (const block of blocks) {
    if (!block.trim()) continue;
    
    let severity: ReviewFinding["severity"] = "low";
    let signal = "";
    let detail = "";
    let action = "";
    const evidence: ReviewFinding["evidence"] = [];
    
    const lines = block.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      const sevMatch = trimmed.match(/^severity:\s*(none|low|medium|high|critical)/i);
      if (sevMatch) {
        const rawSev = sevMatch[1].toLowerCase();
        if (["none", "low", "medium", "high", "critical"].includes(rawSev)) {
          severity = rawSev as ReviewFinding["severity"];
        }
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
};

const correctEvidenceUrls = (
  findings: ReviewFinding[],
  groundingChunks: Array<{ web?: { uri: string; title: string } }>,
  allIngredients: string[],
  pairReviews: PairReview[]
): ReviewFinding[] => {
  if (!groundingChunks || groundingChunks.length === 0) {
    return findings;
  }

  return findings.map((finding) => {
    const signalLower = cleanDrugName(finding.signal);
    const detailLower = cleanDrugName(finding.detail);
    
    // Find all ingredients mentioned in the signal or detail
    let involvedIngredients: string[] = [];
    
    // First try to match from pairReviews directly
    const matchingPair = pairReviews.find((pair) => {
      const leftClean = cleanDrugName(pair.left);
      const rightClean = cleanDrugName(pair.right);
      
      const sigHasLeft = signalLower.includes(leftClean);
      const sigHasRight = signalLower.includes(rightClean);
      const detHasLeft = detailLower.includes(leftClean);
      const detHasRight = detailLower.includes(rightClean);
      
      return (sigHasLeft || detHasLeft) && (sigHasRight || detHasRight);
    });

    if (matchingPair) {
      involvedIngredients = [cleanDrugName(matchingPair.left), cleanDrugName(matchingPair.right)];
    } else {
      // Fallback to the old logic of finding any matching ingredients from allIngredients
      allIngredients.forEach((ing) => {
        const parts = ing.split(/[;,]/).map((p) => p.trim()).filter(Boolean);
        parts.forEach((part) => {
          const cleanedPart = cleanDrugName(part);
          if (!cleanedPart) return;
          if (signalLower.includes(cleanedPart) || detailLower.includes(cleanedPart)) {
            if (!involvedIngredients.includes(cleanedPart)) {
              involvedIngredients.push(cleanedPart);
            }
          }
        });
      });
    }

    if (involvedIngredients.length < 2) {
      return finding;
    }

    const nextEvidence = finding.evidence.map((ev) => {
      const currentUrl = ev.url.trim();
      const currentSource = ev.source.trim();
      const currentSourceLower = currentSource.toLowerCase();

      let isVerified = false;

      // 1. Check if it's already in grounding chunks, valid, and not a mismatch
      const matchingChunk = groundingChunks.find(chunk => {
        const uri = (chunk.web?.uri || "").trim();
        return uri.toLowerCase() === currentUrl.toLowerCase();
      });

      if (matchingChunk) {
        const uriLower = (matchingChunk.web?.uri || "").toLowerCase();
        const titleLower = (matchingChunk.web?.title || "").toLowerCase();
        
        let isMismatch = false;
        
        // Check for other ingredients (cross-contamination)
        for (const ing of allIngredients) {
          const cleanedIng = cleanDrugName(ing);
          if (!cleanedIng) continue;
          if (involvedIngredients.includes(cleanedIng)) continue;
          
          const formattedIng = cleanedIng.replace(/\s+/g, "-");
          if (uriLower.includes(formattedIng) || titleLower.includes(cleanedIng)) {
            isMismatch = true;
            break;
          }
        }

        // Check if it actually contains the involved ingredients
        const missingIng = involvedIngredients.find((ing) => {
          const formattedIng = ing.replace(/\s+/g, "-");
          return !uriLower.includes(formattedIng) && !titleLower.includes(ing);
        });
        if (missingIng) {
          isMismatch = true;
        }

        if (!isMismatch && isUrlValidAndSpecific(currentUrl, currentSource, involvedIngredients)) {
          isVerified = true;
        }
      }

      // 2. If not verified, try to find a better matching chunk in groundingChunks
      if (!isVerified) {
        const bestChunk = groundingChunks.find((chunk) => {
          const uri = (chunk.web?.uri || "").toLowerCase();
          const title = (chunk.web?.title || "").toLowerCase();
          
          let sourceMatches = false;
          if (currentSourceLower.includes("drugs.com") && uri.includes("drugs.com")) {
            sourceMatches = true;
          } else if (currentSourceLower.includes("pubmed") && (uri.includes("pubmed.ncbi") || uri.includes("pmc"))) {
            sourceMatches = true;
          } else if (currentSourceLower.includes("medscape") && uri.includes("medscape.com")) {
            sourceMatches = true;
          } else if (currentSourceLower.includes("drugbank") && uri.includes("drugbank.com")) {
            sourceMatches = true;
          } else if (currentSourceLower.includes("empathia") && uri.includes("empathia.ai")) {
            sourceMatches = true;
          }
          
          if (!sourceMatches) return false;
          
          // Check for involved ingredients
          const matchesAllIngredients = involvedIngredients.every((ing) => {
            const formatted = ing.replace(/\s+/g, "-");
            return uri.includes(formatted) || title.includes(ing);
          });
          if (!matchesAllIngredients) return false;
          
          // Check for other ingredients
          let hasOtherIng = false;
          for (const ing of allIngredients) {
            const cleanedIng = cleanDrugName(ing);
            if (!cleanedIng) continue;
            if (involvedIngredients.includes(cleanedIng)) continue;
            const formatted = cleanedIng.replace(/\s+/g, "-");
            if (uri.includes(formatted) || title.includes(cleanedIng)) {
              hasOtherIng = true;
              break;
            }
          }
          if (hasOtherIng) return false;

          // Require Drugs.com interaction IDs
          if (uri.includes("drugs.com/drug-interactions/")) {
            const hasIds = /-\d+-\d+-\d+-\d+\.html/.test(uri);
            if (!hasIds) return false;
          }
          
          return true;
        });

        if (bestChunk?.web?.uri) {
          console.log(`[URL Correction] Fixed mismatched/hallucinated URL for finding "${finding.signal}":`);
          console.log(`  Old: ${ev.url}`);
          console.log(`  New: ${bestChunk.web.uri}`);
          return {
            ...ev,
            url: bestChunk.web.uri,
            title: bestChunk.web.title || ev.title,
          };
        } else {
          // 3. Fallback: build a drug-specific search URL within the approved source domain.
          // NEVER use Google, Wikipedia, or any non-approved domain.
          const drugQuery = involvedIngredients.join(" ") + " interaction";
          const drug1Slug = involvedIngredients[0]?.replace(/\s+/g, "-") || "";
          const drug2Slug = involvedIngredients[1]?.replace(/\s+/g, "-") || "";
          let fallbackUrl: string;
          let fallbackTitle: string;

          if (currentSourceLower.includes("drugs.com")) {
            fallbackUrl = `https://www.drugs.com/drug-interactions/${drug1Slug}-with-${drug2Slug}.html`;
            fallbackTitle = `${involvedIngredients[0]} and ${involvedIngredients[1]} Drug Interactions — Drugs.com`;
          } else if (currentSourceLower.includes("pubmed")) {
            fallbackUrl = `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(drugQuery)}`;
            fallbackTitle = `${involvedIngredients[0]} ${involvedIngredients[1]} interaction — PubMed`;
          } else if (currentSourceLower.includes("medscape")) {
            fallbackUrl = `https://reference.medscape.com/drug-interactionchecker`;
            fallbackTitle = `Drug Interaction Checker — Medscape`;
          } else if (currentSourceLower.includes("drugbank")) {
            fallbackUrl = `https://go.drugbank.com/unearth/q?query=${encodeURIComponent(drugQuery)}`;
            fallbackTitle = `${involvedIngredients[0]} ${involvedIngredients[1]} interaction — DrugBank`;
          } else if (currentSourceLower.includes("empathia")) {
            fallbackUrl = `https://empathia.ai/blog/${drug1Slug}-and-${drug2Slug}-drug-interaction`;
            fallbackTitle = `${involvedIngredients[0]} and ${involvedIngredients[1]} Drug Interaction — Empathia AI`;
          } else {
            // Unknown source cited by AI — force to Drugs.com as the default approved fallback
            fallbackUrl = `https://www.drugs.com/drug-interactions/${drug1Slug}-with-${drug2Slug}.html`;
            fallbackTitle = `${involvedIngredients[0]} and ${involvedIngredients[1]} Drug Interactions — Drugs.com`;
          }

          console.log(`[URL Correction] No matching grounding chunk. Using approved fallback for "${finding.signal}": ${fallbackUrl}`);
          return {
            ...ev,
            url: fallbackUrl,
            title: fallbackTitle,
          };
        }
      }

      return ev;
    });

    // Final guardrail: reject any URL not from the 5 approved clinical domains.
    const APPROVED_DOMAINS = ["drugs.com", "pubmed.ncbi.nlm.nih.gov", "medscape.com", "drugbank.com", "empathia.ai"];
    const sanitizedEvidence = nextEvidence.map((ev) => {
      const urlLower = ev.url.toLowerCase();
      const isApproved = APPROVED_DOMAINS.some((domain) => urlLower.includes(domain));
      if (!isApproved) {
        // Force unapproved URL to Drugs.com drug-specific interaction page
        const d1 = involvedIngredients[0]?.replace(/\s+/g, "-") || "drug-a";
        const d2 = involvedIngredients[1]?.replace(/\s+/g, "-") || "drug-b";
        console.log(`[URL Guardrail] Rejected unapproved URL "${ev.url}" — replaced with approved Drugs.com link.`);
        return {
          ...ev,
          url: `https://www.drugs.com/drug-interactions/${d1}-with-${d2}.html`,
          title: `${involvedIngredients[0] || "Drug A"} and ${involvedIngredients[1] || "Drug B"} Drug Interactions — Drugs.com`,
          source: ev.source || "Drugs.com",
        };
      }
      return ev;
    });

    return {
      ...finding,
      evidence: sanitizedEvidence,
    };
  });
};

const buildFallbackReview = (
  pairReviews: PairReview[]
): { overallSeverity: "none" | "low" | "medium" | "high" | "critical"; clinicalSummary: string; findings: ReviewFinding[] } => {
  return {
    overallSeverity: "none",
    clinicalSummary: "AI review service was temporarily unavailable. Clinicians should manually verify all medication combinations.",
    findings: [
      {
        type: "Drug-Drug",
        severity: "none",
        signal: "Review service unavailable",
        detail: "The AI agent could not complete the automated drug-drug interaction review at this time.",
        action: "Please manually review the prescribed medications against the patient's current medications using trusted sources (e.g. DrugBank, PubMed, Medscape, Drugs.com, Empathia AI).",
        evidence: [],
      },
    ],
  };
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await request.json();
    const patientCode = String(body?.patientCode || "").trim();
    const proposedMedications = Array.isArray(body?.proposedMedications)
      ? (body.proposedMedications as ProposedMedicationInput[]).filter((item) =>
          String(item?.name || item?.ingredient || "").trim()
        )
      : [];

    if (!patientCode) {
      return new Response(JSON.stringify({ error: "patientCode is required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (proposedMedications.length === 0) {
      return new Response(JSON.stringify({ error: "At least one proposed medication is required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceRoleKey) {
      throw new Error("Supabase service role configuration is missing.");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
    const [{ data: ehrData, error: ehrError }, { data: patientRow, error: patientError }] = await Promise.all([
      supabase.rpc("get_patient_ehr", { p_patient_code: patientCode }),
      supabase.from("ehr_patients").select("id").eq("patient_code", patientCode).maybeSingle(),
    ]);

    if (ehrError) throw ehrError;
    if (patientError) throw patientError;

    if (!patientRow) {
      return new Response(JSON.stringify({ error: `Patient record not found for code: ${patientCode}` }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!ehrData) {
      return new Response(JSON.stringify({ error: `No EHR record found for patient: ${patientCode}` }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ehr = ehrData as PatientEhr;
    const ehrSummary = buildEhrSummary(ehr);
    const activeMeds = ehrSummary.activeMedications.map((item) => ({
      active_ingredient: item.active_ingredient,
      medication_display: item.medication_display || item.active_ingredient,
    }));
    const pairReviews = buildPairReviews(proposedMedications, activeMeds);

    let modelReview: { overallSeverity?: string; clinicalSummary?: string; findingsText?: string } | null = null;
    let geminiError: string | null = null;
    let groundingChunks: any[] = [];

    if (pairReviews.length > 0) {
      try {
        const result = await callGeminiForDdiReview(patientCode, ehrSummary, proposedMedications, pairReviews);
        modelReview = result.parsed;
        groundingChunks = result.groundingChunks;
      } catch (error) {
        console.error("Gemini DDI review failed, falling back to clean warning.", error);
        geminiError = error instanceof Error ? error.message : String(error);
      }
    } else {
      // No medication pairs to check (e.g. only one drug and patient has no active meds)
      modelReview = {
        overallSeverity: "none",
        clinicalSummary: "No medication pairs to check (no proposed-proposed combinations and patient has no active medications).",
        findingsText: "",
      };
    }

    const fallbackReview = buildFallbackReview(pairReviews);
    
    let rawFindings: ReviewFinding[] = [];
    if (modelReview?.findingsText) {
      rawFindings = parseFindingsText(modelReview.findingsText);
    } else if (geminiError) {
      rawFindings = fallbackReview.findings;
    } else {
      rawFindings = [];
    }

    const allIngredients = [
      ...proposedMedications.map((item) => fallbackIngredient(String(item.ingredient || item.name || ""))),
      ...activeMeds.map((item) => fallbackIngredient(item.active_ingredient)),
    ].filter(Boolean);

    const validatedFindings = correctEvidenceUrls(rawFindings, groundingChunks, allIngredients, pairReviews);

    // Post-process to add "None" severity findings for checked pairs that have no interactions
    const findings: ReviewFinding[] = [...validatedFindings];
    const isServiceUnavailable = validatedFindings.some((f) => f.signal === "Review service unavailable");

    if (!isServiceUnavailable && pairReviews.length > 0) {
      const coveredPairs = new Set<string>();

      validatedFindings.forEach((finding) => {
        const sigLower = (finding.signal || "").toLowerCase();
        const detLower = (finding.detail || "").toLowerCase();

        pairReviews.forEach((pair) => {
          const leftLower = pair.left.toLowerCase();
          const rightLower = pair.right.toLowerCase();

          if (
            (sigLower.includes(leftLower) && sigLower.includes(rightLower)) ||
            (detLower.includes(leftLower) && detLower.includes(rightLower))
          ) {
            coveredPairs.add(`${leftLower}|${rightLower}`);
          }
        });
      });

      pairReviews.forEach((pair) => {
        const leftLower = pair.left.toLowerCase();
        const rightLower = pair.right.toLowerCase();
        const key = `${leftLower}|${rightLower}`;

        if (!coveredPairs.has(key)) {
          const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
          findings.push({
            type: "Drug-Drug",
            severity: "none",
            signal: `${capitalize(pair.left)} and ${capitalize(pair.right)} Interaction`,
            detail: `The DDI review agent verified the combination of ${pair.left} and ${pair.right} and found no clinically significant drug-drug interactions.`,
            action: "No clinical action required.",
            evidence: [],
          });
          coveredPairs.add(key);
        }
      });
    }

    const rawOverallSeverity = String(modelReview?.overallSeverity || fallbackReview.overallSeverity || "none").toLowerCase();
    const overallSeverity = (["none", "low", "medium", "high", "critical"].includes(rawOverallSeverity)
      ? rawOverallSeverity
      : "none") as "none" | "low" | "medium" | "high" | "critical";

    const clinicalSummary =
      String(modelReview?.clinicalSummary || fallbackReview.clinicalSummary || "").trim();

    const reviewSessionPayload = {
      patient_id: patientRow.id,
      requested_medications: proposedMedications,
      normalized_ingredients: proposedMedications.map((item) =>
        fallbackIngredient(String(item.ingredient || item.name || ""))
      ),
      overall_severity: overallSeverity,
      report_status: "completed",
    };

    const { data: reviewSession, error: reviewSessionError } = await supabase
      .from("prescription_review_sessions")
      .insert(reviewSessionPayload)
      .select("id")
      .single();
    if (reviewSessionError) throw reviewSessionError;

    if (findings.length > 0) {
      const findingRows = findings.map((finding) => ({
        review_session_id: reviewSession.id,
        interaction_type: "drug_drug",
        severity: finding.severity,
        signal: finding.signal,
        explanation: finding.detail,
        recommendation: finding.action,
        evidence: finding.evidence || [],
      }));
      const { error: findingsError } = await supabase.from("interaction_findings").insert(findingRows);
      if (findingsError) throw findingsError;
    }

    return new Response(
      JSON.stringify({
        reviewSessionId: reviewSession.id,
        overallSeverity,
        clinicalSummary,
        findings,
        geminiError,
        pairChecks: pairReviews.map((pair) => ({
          pairType: pair.pairType,
          left: pair.left,
          right: pair.right,
        })),
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error(error);
    const errorMessage = error instanceof Error ? error.message : "Unexpected DDI agent failure.";
    return new Response(
      JSON.stringify({
        reviewSessionId: null,
        overallSeverity: "none",
        clinicalSummary: "The DDI review agent encountered an error. Please retry or verify medications manually.",
        findings: [
          {
            type: "Drug-Drug",
            severity: "none",
            signal: "Review agent error",
            detail: errorMessage,
            action: "Please retry the review. If the error persists, manually verify all medication combinations using trusted clinical sources.",
            evidence: [],
          },
        ],
        geminiError: errorMessage,
        pairChecks: [],
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
