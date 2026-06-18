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

type AllergyFinding = {
  type: string;
  severity: "none" | "low" | "medium" | "high" | "critical";
  signal: string;
  reasoning?: string;
  detail: string;
  action: string;
  drug?: string;
  allergen?: string;
  drugSource?: string;
  allergenSource?: string;
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
  if (!trimmed) throw new Error("Model response text was empty.");

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fenced?.[1]?.trim() || trimmed;

  if (!candidate.endsWith("}")) {
    if (!candidate.endsWith('"')) candidate += '"';
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
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
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

  if (!jsonString) throw new Error("Google service account secret is not configured.");

  let serviceAccount: Record<string, string>;
  try {
    serviceAccount = JSON.parse(jsonString);
  } catch (parseError) {
    throw new Error(
      `Failed to parse service account JSON: ${parseError instanceof Error ? parseError.message : "unknown"}`,
    );
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
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

const cleanDrugName = (name: string): string => {
  let cleaned = name.toLowerCase().trim();
  const salts = [
    "hydrochloride", "hydrobromide", "besylate", "maleate", "sodium", "potassium",
    "calcium", "bisulfate", "sulfate", "tartrate", "phosphate", "acetate",
    "fumarate", "mesylate", "estolate", "valerate", "succinate", "camsylate",
    "nitrate", "chloride", "hcl", "mesilate", "besilate", "dipotassium",
  ];
  salts.forEach((salt) => {
    const regex = new RegExp(`\\b${salt}\\b`, "g");
    cleaned = cleaned.replace(regex, "");
  });
  return cleaned.replace(/\s+/g, " ").trim();
};

const cleanIngredientForUrl = (name: string): string => {
  if (!name) return "";
  let cleaned = name.toLowerCase().trim();
  const salts = [
    "hydrochloride", "hydrobromide", "besylate", "maleate", "sodium", "potassium", 
    "calcium", "bisulfate", "sulfate", "tartrate", "phosphate", "acetate", 
    "fumarate", "mesylate", "estolate", "valerate", "succinate", "camsylate", 
    "nitrate", "chloride", "hcl", "mesilate", "besilate", "flesinoxan", "dipotassium"
  ];
  salts.forEach((salt) => {
    const regex = new RegExp(`\\b${salt}\\b`, "gi");
    cleaned = cleaned.replace(regex, "");
  });
  cleaned = cleaned.replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml|%)\b/gi, "");
  cleaned = cleaned.replace(/\b\d+(\.\d+)?\b/gi, "");
  const dosageForms = [
    "oral tablet", "oral capsule", "tablet", "capsule", "injection", "solution", 
    "suspension", "extended release", "delayed release", "xr", "er", "release", 
    "oral", "topical", "cream", "ointment", "spray", "inhaler", "liquid"
  ];
  dosageForms.forEach((form) => {
    const regex = new RegExp(`\\b${form}\\b`, "gi");
    cleaned = cleaned.replace(regex, "");
  });
  cleaned = cleaned.replace(/\//g, " ");
  cleaned = cleaned.replace(/[^a-z0-9\s-]/gi, "");
  return cleaned.replace(/\s+/g, " ").trim();
};

const parseSourcesFromLine = (lineContent: string): string[] => {
  const parts = lineContent.split("|").map(p => p.trim());
  if (parts.length >= 3) {
    const src = parts[0].toLowerCase();
    if (src.includes("drugs.com")) return ["S1"];
    if (src.includes("pubmed")) return ["S2"];
    if (src.includes("medscape")) return ["S3"];
    if (src.includes("empathia")) return ["S4"];
  }
  
  const rawIds = lineContent.split(/[,;]+/).map(p => p.trim());
  const found: string[] = [];
  for (const raw of rawIds) {
    const lower = raw.toLowerCase();
    if (lower === "s1" || lower.includes("drugs.com")) found.push("S1");
    else if (lower === "s2" || lower.includes("pubmed")) found.push("S2");
    else if (lower === "s3" || lower.includes("medscape")) found.push("S3");
    else if (lower === "s4" || lower.includes("empathia")) found.push("S4");
  }
  return found;
};

// Deterministic URL builder — server code maps sourceId → search URL, never the LLM
const buildEvidenceUrl = (sourceId: string, drug: string, allergen: string, drugSource?: string, allergenSource?: string): { source: string; title: string; url: string } => {
  const dName = cleanIngredientForUrl(drugSource || drug);
  const aName = cleanIngredientForUrl(allergenSource || allergen);
  const query = `${dName} ${aName} allergy`;
  const encoded = encodeURIComponent(query);

  switch (sourceId.toUpperCase()) {
    case "S1":
    case "DRUGS_COM":
      return {
        source: "Drugs.com",
        title: `${dName} and ${aName} Allergy — Drugs.com`,
        url: `https://www.drugs.com/search.php?searchterm=${encodeURIComponent(dName + " " + aName + " allergy")}`,
      };
    case "S2":
    case "PUBMED":
      return {
        source: "PubMed",
        title: `${dName} and ${aName} allergy — PubMed`,
        url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encoded}`,
      };
    case "S3":
    case "MEDSCAPE":
      return {
        source: "Medscape",
        title: `${dName} and ${aName} allergy — Medscape`,
        url: `https://search.medscape.com/search/?q=${encoded}`,
      };
    case "S4":
    case "EMPATHIA_AI":
      return {
        source: "Empathia AI",
        title: `${dName} and ${aName} Allergy — Empathia AI`,
        url: `https://empathia.ai/allergy-cross-reactivity/${encodeURIComponent(dName)}-${encodeURIComponent(aName)}`,
      };
    default:
      return {
        source: "Drugs.com",
        title: `${dName} and ${aName} Allergy Search — Drugs.com`,
        url: `https://www.drugs.com/search.php?searchterm=${encodeURIComponent(dName + " " + aName + " allergy")}`,
      };
  }
};

const resolveAllergyEvidenceFromSourceId = (
  sourceId: string,
  drug: string,
  allergen: string,
  drugSource: string,
  allergenSource: string,
  groundingChunks: Array<{ web?: { uri: string; title: string } }>
): { source: string; title: string; url: string } => {
  const fallback = buildEvidenceUrl(sourceId, drug, allergen, drugSource, allergenSource);
  
  const targetDomain = 
    sourceId === "S1" ? "drugs.com" :
    sourceId === "S2" ? "pubmed.ncbi.nlm.nih.gov" :
    sourceId === "S3" ? "medscape.com" :
    sourceId === "S4" ? "empathia.ai" : "";
    
  if (!targetDomain) return fallback;

  const bestChunk = groundingChunks.find((chunk) => {
    const uri = (chunk.web?.uri || "").toLowerCase();
    const title = (chunk.web?.title || "").toLowerCase();
    
    if (!uri.includes(targetDomain)) return false;
    
    const drugAliases = [cleanDrugName(drug), cleanDrugName(drugSource)].filter(Boolean);
    const allergenAliases = [cleanDrugName(allergen), cleanDrugName(allergenSource)].filter(Boolean);
    
    const matchesDrug = drugAliases.some(alias => uri.includes(alias.replace(/\s+/g, "-")) || title.includes(alias));
    const matchesAllergen = allergenAliases.some(alias => uri.includes(alias.replace(/\s+/g, "-")) || title.includes(alias));
    
    if (!matchesDrug || !matchesAllergen) return false;
    
    return true;
  });

  if (bestChunk?.web?.uri) {
    return {
      source: fallback.source,
      title: bestChunk.web.title || fallback.title,
      url: bestChunk.web.uri,
    };
  }

  return fallback;
};

// Correct and supplement evidence using grounding chunks — same approach as DDI
const correctAllergyEvidenceUrls = (
  findings: AllergyFinding[],
  groundingChunks: Array<{ web?: { uri: string; title: string } }>,
): AllergyFinding[] => {
  return findings.map((finding) => {
    const drug = finding.drug || "";
    const allergen = finding.allergen || "";
    const drugSource = finding.drugSource || drug;
    const allergenSource = finding.allergenSource || allergen;

    const correctedEvidence = finding.evidence.map((ev) => {
      let sourceId = "S1";
      const srcLower = ev.source.toLowerCase();
      if (srcLower === "s1" || srcLower.includes("drugs.com")) sourceId = "S1";
      else if (srcLower === "s2" || srcLower.includes("pubmed")) sourceId = "S2";
      else if (srcLower === "s3" || srcLower.includes("medscape")) sourceId = "S3";
      else if (srcLower === "s4" || srcLower.includes("empathia")) sourceId = "S4";

      return resolveAllergyEvidenceFromSourceId(
        sourceId,
        drug,
        allergen,
        drugSource,
        allergenSource,
        groundingChunks
      );
    });

    return { ...finding, evidence: correctedEvidence };
  });
};

const matchAllergen = (allergenName: string, signal: string, detail: string): boolean => {
  const signalLower = signal.toLowerCase();
  const detailLower = detail.toLowerCase();
  const allergenLower = allergenName.toLowerCase();
  
  if (signalLower.includes(allergenLower) || detailLower.includes(allergenLower)) {
    return true;
  }
  
  const allergenWords = allergenLower.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, "")).filter(w => w.length >= 4);
  if (allergenWords.length === 0) return false;
  
  return allergenWords.some(word => signalLower.includes(word) || detailLower.includes(word));
};

const parseFindingsText = (text: string, drugAllergenMap: Map<string, { drug: string; allergen: string; drugSource: string; allergenSource: string }>): AllergyFinding[] => {
  const findings: AllergyFinding[] = [];
  const blocks = text.split(/(?=Finding \d+:|FINDING \d+:)/i);

  for (const block of blocks) {
    if (!block.trim()) continue;

    let severity: AllergyFinding["severity"] = "low";
    let signal = "";
    let reasoning = "";
    let detail = "";
    let action = "";
    const evidence: AllergyFinding["evidence"] = [];

    const lines = block.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const sevMatch = trimmed.match(/^severity:\s*(none|low|medium|high|critical)/i);
      if (sevMatch) {
        const rawSev = sevMatch[1].toLowerCase();
        if (["none", "low", "medium", "high", "critical"].includes(rawSev)) {
          severity = rawSev as AllergyFinding["severity"];
        }
        continue;
      }

      const sigMatch = trimmed.match(/^signal:\s*(.*)/i);
      if (sigMatch) { signal = sigMatch[1].trim(); continue; }

      const reasMatch = trimmed.match(/^reasoning:\s*(.*)/i);
      if (reasMatch) { reasoning = reasMatch[1].trim(); continue; }

      const detMatch = trimmed.match(/^detail:\s*(.*)/i);
      if (detMatch) { detail = detMatch[1].trim(); continue; }

      const actMatch = trimmed.match(/^action:\s*(.*)/i);
      if (actMatch) { action = actMatch[1].trim(); continue; }

      const evMatch = trimmed.match(/^(?:evidence|sources?):\s*(.*)/i);
      if (evMatch) {
        const sourceLine = evMatch[1].trim();
        const parsedIds = parseSourcesFromLine(sourceLine);
        parsedIds.forEach((id) => {
          evidence.push({ source: id, title: "", url: "" });
        });
        continue;
      }
    }

    if (signal) {
      const signalLower = cleanDrugName(signal);
      let matchedDrug = "";
      let matchedAllergen = "";
      let matchedDrugSource = "";
      let matchedAllergenSource = "";

      // 1. Try matching both drug ingredient and allergen with high precision
      for (const [key, val] of drugAllergenMap.entries()) {
        const drugClean = cleanDrugName(val.drug);
        const drugMatches = signalLower.includes(drugClean);
        
        if (drugMatches && matchAllergen(val.allergen, signal, detail || "")) {
          matchedDrug = val.drug;
          matchedAllergen = val.allergen;
          matchedDrugSource = val.drugSource;
          matchedAllergenSource = val.allergenSource;
          break;
        }
      }

      // 2. Fallback to looser brand name + allergen matching
      if (!matchedDrug) {
        for (const [key, val] of drugAllergenMap.entries()) {
          const drugMatches = cleanDrugName(val.drugSource).split(/\s+/).some(w => w.length >= 4 && signalLower.includes(w.toLowerCase()));
          if (drugMatches && matchAllergen(val.allergen, signal, detail || "")) {
            matchedDrug = val.drug;
            matchedAllergen = val.allergen;
            matchedDrugSource = val.drugSource;
            matchedAllergenSource = val.allergenSource;
            break;
          }
        }
      }

      // 3. Fallback: match drug ingredient only (no allergen match)
      if (!matchedDrug) {
        for (const [key, val] of drugAllergenMap.entries()) {
          const drugClean = cleanDrugName(val.drug);
          const drugMatches = signalLower.includes(drugClean);
          if (drugMatches) {
            matchedDrug = val.drug;
            matchedAllergen = val.allergen;
            matchedDrugSource = val.drugSource;
            matchedAllergenSource = val.allergenSource;
            break;
          }
        }
      }

      // 4. Fallback: match looser brand name only (no allergen match)
      if (!matchedDrug) {
        for (const [key, val] of drugAllergenMap.entries()) {
          const drugMatches = cleanDrugName(val.drugSource).split(/\s+/).some(w => w.length >= 4 && signalLower.includes(w.toLowerCase()));
          if (drugMatches) {
            matchedDrug = val.drug;
            matchedAllergen = val.allergen;
            matchedDrugSource = val.drugSource;
            matchedAllergenSource = val.allergenSource;
            break;
          }
        }
      }

      findings.push({
        type: "Drug-Allergy",
        severity,
        signal,
        reasoning: reasoning || "",
        detail: detail || "No detail provided.",
        action: action || "No action recommended.",
        drug: matchedDrug,
        allergen: matchedAllergen,
        drugSource: matchedDrugSource,
        allergenSource: matchedAllergenSource,
        evidence,
      });
    }
  }

  return findings;
};

const expandProposedMedications = (meds: ProposedMedicationInput[]): ProposedMedicationInput[] => {
  const expanded: ProposedMedicationInput[] = [];
  for (const med of meds) {
    const rawIng = String(med.ingredient || med.name || "").trim();
    if (!rawIng) continue;
    const ingredients = rawIng
      .split(/[,;/+]+|\band\b/i)
      .map((i) => i.trim().toLowerCase())
      .filter(Boolean);

    if (ingredients.length <= 1) {
      expanded.push(med);
    } else {
      for (const ing of ingredients) {
        const originalName = String(med.name || med.ingredient || "").trim();
        const nameHasIngredient = originalName.toLowerCase().includes(ing);
        const hasSeparators = /[,;/+]|\band\b/i.test(originalName);
        const name = hasSeparators ? ing : (nameHasIngredient ? originalName : `${originalName} (${ing})`);
        expanded.push({
          ...med,
          name,
          ingredient: ing,
        });
      }
    }
  }
  return expanded;
};

// ─── Gemini call: full allergy review WITH Google Search Grounding ───────────
const callGeminiForAllergyReview = async (
  patientCode: string,
  proposedMedications: ProposedMedicationInput[],
  allergies: Array<{ substance_display: string; reaction_display: string; criticality: string; clinical_status: string }>,
  enableSearch: boolean,
) => {
  const { accessToken, projectId } = await createGoogleAccessToken();
  const endpoint =
    `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/gemini-3.5-flash:generateContent`;

  const allergyList = allergies
    .filter((a) => a.clinical_status === "active")
    .map((a) => `- ${a.substance_display} (reaction: ${a.reaction_display || "unknown"}, criticality: ${a.criticality || "unknown"})`)
    .join("\n");

  const drugList = proposedMedications
    .map((m) => `- ${m.name || m.ingredient} (ingredient: ${m.ingredient || m.name})`)
    .join("\n");

  const medicationAllergenPairs = [];
  for (const med of proposedMedications) {
    const medName = med.name || med.ingredient || "";
    const medIngred = med.ingredient || med.name || "";
    const medDisplay = `${medName} (${medIngred})`;

    for (const allergy of allergies) {
      medicationAllergenPairs.push({
        medication: medDisplay,
        allergen: allergy.substance_display,
        reaction: allergy.reaction_display || "unknown",
        criticality: allergy.criticality || "unknown",
      });
    }
  }

  const pairsChecklistText = 
    `Medication-Allergy Pairs to Check:\n` +
    medicationAllergenPairs.map((p, idx) => `${idx + 1}. ${p.medication} vs ${p.allergen} [reaction: ${p.reaction}, criticality: ${p.criticality}]`).join("\n");

  const systemInstructionText = enableSearch
    ? "You are an expert clinical pharmacist equipped with Google Search Grounding.\n" +
      "Your task is to analyze potential drug-allergy cross-reactivities for the provided proposed medications against the patient's documented active allergies by systematically evaluating the provided pair checklist.\n\n" +
      "Follow these strict clinical rules:\n" +
      "1. Perform rigorous clinical reasoning. First, perform medical reasoning on the clinical evidence and context. You must analyze the evidence step-by-step to explain the physiological/pharmacological mechanism of cross-reactivity, how it relates to this specific patient's allergy details (like reaction type and criticality), and what clinical decision should be made. Write this reasoning process in the 'Reasoning:' section of each finding before detailing the final message.\n" +
      "2. Consider all forms of allergy cross-reactivity — direct allergy (the drug IS the allergen or a close derivative), class cross-reactivity (e.g. penicillin allergy → amoxicillin), and pharmacological class overlap.\n" +
      "3. Use Google Search Grounding to read and analyze clinical evidence from the 4 approved sources (Drugs.com, PubMed, Medscape, Empathia AI). Do NOT output any URLs, source names, or citations in your response.\n" +
      "4. Keep 'detail' and 'action' concise (max 2-3 sentences each).\n" +
      "5. Evaluate every single medication-allergen pair in the checklist. Generate findings only for pairs with documented clinical cross-reactivity (severity: low, medium, high, or critical). Omit pairs with no clinical concern (severity 'none').\n" +
      "6. NEVER analyze proposed medications against other proposed medications.\n\n" +
      "CRITICAL: Output must be a 100% valid JSON object matching this schema:\n" +
      "{\n" +
      "  \"overallRisk\": \"high\",\n" +
      "  \"clinicalSummary\": \"Summary of allergy risks...\",\n" +
      "  \"findingsText\": \"Finding 1:\\nSeverity: high\\nSignal: Amoxicillin — Penicillin Allergy\\nReasoning: Medical reasoning based on RAG source information goes here.\\nDetail: Mechanism.\\nAction: Recommendation.\"\n" +
      "}\n\n" +
      "Format findingsText as plain text. Separate multiple findings with a double newline:\n\n" +
      "Finding N:\n" +
      "Severity: [none|low|medium|high|critical]\n" +
      "Signal: [DrugName — AllergenName Allergy]\n" +
      "Reasoning: [Structured medical/clinical reasoning based on the retrieved search results/context, explaining mechanisms and patient-specific risks]\n" +
      "Detail: [Concise clinical explanation, max 2-3 sentences]\n" +
      "Action: [Clinical recommendation, max 2-3 sentences]"
    : "You are an expert clinical pharmacist.\n" +
      "Your task is to analyze potential drug-allergy cross-reactivities for the provided proposed medications against the patient's documented active allergies by systematically evaluating the provided pair checklist.\n\n" +
      "Follow these strict clinical rules:\n" +
      "1. Perform rigorous clinical reasoning. First, perform medical reasoning on the clinical context. You must analyze the evidence step-by-step to explain the physiological/pharmacological mechanism of cross-reactivity, how it relates to this specific patient's allergy details (like reaction type and criticality), and what clinical decision should be made. Write this reasoning process in the 'Reasoning:' section of each finding before detailing the final message.\n" +
      "2. Consider all forms of allergy cross-reactivity — direct allergy, class cross-reactivity (e.g. penicillin allergy → amoxicillin), and pharmacological class overlap.\n" +
      "3. Do NOT search Google, do NOT cite any sources, and do NOT provide any evidence URLs.\n" +
      "4. Keep 'detail' and 'action' concise (max 2-3 sentences each).\n" +
      "5. Evaluate every single medication-allergen pair. Generate findings only for pairs with clinical cross-reactivity. Omit pairs with no clinical concern.\n" +
      "6. NEVER analyze proposed medications against other proposed medications.\n\n" +
      "CRITICAL: Output must be a 100% valid JSON object:\n" +
      "{\n" +
      "  \"overallRisk\": \"high\",\n" +
      "  \"clinicalSummary\": \"Summary of allergy risks...\",\n" +
      "  \"findingsText\": \"Finding 1:\\nSeverity: high\\nSignal: Amoxicillin — Penicillin Allergy\\nReasoning: Medical reasoning goes here.\\nDetail: Mechanism.\\nAction: Recommendation.\"\n" +
      "}\n\n" +
      "Format findingsText as plain text. Separate multiple findings with a double newline:\n\n" +
      "Finding N:\n" +
      "Severity: [none|low|medium|high|critical]\n" +
      "Signal: [DrugName — AllergenName Allergy]\n" +
      "Reasoning: [Structured medical/clinical reasoning based on the clinical context, explaining mechanisms and patient-specific risks]\n" +
      "Detail: [Concise clinical explanation, max 2-3 sentences]\n" +
      "Action: [Clinical recommendation, max 2-3 sentences]";

  let response: Response | null = null;
  let attempt = 0;
  const maxAttempts = 3;
  let delayMs = 1500;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          systemInstruction: {
            role: "system",
            parts: [{ text: systemInstructionText }],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: JSON.stringify({
                    patientCode,
                    task: "Analyze proposed medications for drug-allergy cross-reactivities against the patient's documented allergies.",
                    proposedMedications: drugList,
                    patientActiveAllergies: allergyList,
                    pairsToCheck: pairsChecklistText,
                  }),
                },
              ],
            },
          ],
          ...(enableSearch ? { tools: [{ google_search: {} }] } : {}),
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
          },
        }),
      });

      if (response.status === 429) {
        console.warn(`Gemini API returned 429 (Resource Exhausted) on attempt ${attempt}. Retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
        continue;
      }

      break;
    } catch (fetchErr) {
      console.warn(`Fetch error on attempt ${attempt}:`, fetchErr);
      if (attempt >= maxAttempts) throw fetchErr;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }

  if (!response) {
    throw new Error("Failed to receive response from Gemini.");
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini allergy review call failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || "";
  if (!text.trim()) throw new Error("Gemini returned an empty allergy review payload.");

  const groundingChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

  try {
    const parsed = parseJsonResponseText(text);
    return { parsed, groundingChunks };
  } catch (parseError) {
    console.error("Failed to parse Gemini allergy response. Raw text:", text);
    throw new Error(`JSON parse failure: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
  }
};

// ─── Gemini call: on-demand references for a specific drug-allergen pair ─────
const callGeminiForAllergyReferences = async (
  pair: { drug: string; allergen: string; drugSource: string; allergenSource: string },
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
              "You are an expert clinical pharmacist equipped with Google Search Grounding.\n" +
              "Your task is to find reliable clinical evidence references for the drug-allergy cross-reactivity between:\n" +
              `Drug: ${pair.drug} (brand/display: ${pair.drugSource})\n` +
              `Allergen: ${pair.allergen} (display: ${pair.allergenSource})\n\n` +
              "Follow these strict rules:\n" +
              "1. Search Google to find direct evidence of their cross-reactivity, and determine which of the 4 approved sources support it:\n" +
              "   - S1: Drugs.com\n" +
              "   - S2: PubMed\n" +
              "   - S3: Medscape\n" +
              "   - S4: Empathia AI\n" +
              "   CRITICAL: Do NOT output any URLs or web addresses. Only return the source IDs (e.g. S1, S2) for the sources that have evidence.\n" +
              "2. Return a valid JSON object only — no markdown.\n\n" +
              "Return strict JSON:\n" +
              "{\n" +
              "  \"sources\": [\"S1\", \"S2\"]\n" +
              "}",
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Please find clinical references for the allergy cross-reactivity between ${pair.drug} and ${pair.allergen}.`,
            },
          ],
        },
      ],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini allergy references call failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || "";
  if (!text.trim()) {
    console.error("Gemini allergy references call returned empty text. Full API response:", JSON.stringify(data));
    throw new Error(`Gemini returned an empty allergy references payload. Full response: ${JSON.stringify(data)}`);
  }

  const groundingChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

  try {
    const parsed = parseJsonResponseText(text);
    return { parsed, groundingChunks };
  } catch (parseError) {
    throw new Error(`JSON parse failure: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
  }
};

// ─── Main Deno serve handler ─────────────────────────────────────────────────
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await request.json();
    const mode = String(body?.mode || "review").trim().toLowerCase();

    // ── REFERENCES MODE: on-demand Google Search Grounding for one pair ──────
    if (mode === "references") {
      const pair = body?.pair;
      if (!pair || !pair.drug || !pair.allergen) {
        return new Response(
          JSON.stringify({ error: "pair with drug and allergen fields is required for references mode." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const sampleMaxTwoSources = (sources: string[]): string[] => {
        if (sources.length <= 2) return sources;
        const shuffled = [...sources].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, 2);
      };

      let corrected: AllergyFinding[] = [];
      try {
        const result = await callGeminiForAllergyReferences({
          drug: String(pair.drug),
          allergen: String(pair.allergen),
          drugSource: String(pair.drugSource || pair.drug),
          allergenSource: String(pair.allergenSource || pair.allergen),
        });

        // Correct evidence URLs using grounding chunks + deterministic fallback
        const parsedSources = Array.isArray(result.parsed?.sources) ? result.parsed.sources : [];
        const selectedSources = sampleMaxTwoSources(parsedSources);
        
        const initialEvidence = selectedSources.map((srcId: string) => ({
          source: srcId,
          title: "",
          url: "",
        }));

        const tempFinding: AllergyFinding = {
          type: "Drug-Allergy",
          severity: "high",
          signal: `${pair.drug} — ${pair.allergen} Allergy`,
          reasoning: "",
          detail: "",
          action: "",
          drug: String(pair.drug),
          allergen: String(pair.allergen),
          drugSource: String(pair.drugSource || pair.drug),
          allergenSource: String(pair.allergenSource || pair.allergen),
          evidence: initialEvidence,
        };

        corrected = correctAllergyEvidenceUrls([tempFinding], result.groundingChunks || []);
      } catch (error) {
        console.warn("Gemini allergy references call failed, falling back to deterministic search URLs:", error);
        const selected = sampleMaxTwoSources(["S1", "S2", "S3", "S4"]);
        corrected = [{
          type: "Drug-Allergy",
          severity: "high",
          signal: `${pair.drug} — ${pair.allergen} Allergy`,
          detail: "",
          action: "",
          evidence: selected.map(srcId => buildEvidenceUrl(
            srcId,
            pair.drug,
            pair.allergen,
            pair.drugSource || pair.drug,
            pair.allergenSource || pair.allergen
          ))
        }];
      }
      return new Response(
        JSON.stringify({ evidence: corrected[0].evidence || [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── REVIEW MODE: full allergy check WITH Google Search Grounding ─────────
    const patientCode = String(body?.patientCode || "").trim();
    let proposedMedications = Array.isArray(body?.proposedMedications)
      ? (body.proposedMedications as ProposedMedicationInput[]).filter((item) =>
          String(item?.name || item?.ingredient || "").trim()
        )
      : [];
    proposedMedications = expandProposedMedications(proposedMedications);

    if (!patientCode) {
      return new Response(
        JSON.stringify({ error: "patientCode is required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (proposedMedications.length === 0) {
      return new Response(
        JSON.stringify({ error: "At least one proposed medication is required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
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
      return new Response(
        JSON.stringify({ error: `Patient record not found for code: ${patientCode}` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!ehrData) {
      return new Response(
        JSON.stringify({ error: `No EHR record found for patient: ${patientCode}` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const ehr = ehrData as PatientEhr;
    // Deduplicate allergies and extract active ones
    const allergyKeys = new Set<string>();
    const activeAllergies = [];
    for (const a of (ehr.allergies || [])) {
      const display = String(a.substance_display || "").trim();
      const status = String(a.clinical_status || "").trim();
      const reaction = String(a.reaction_display || "").trim();
      const criticality = String(a.criticality || "").trim();
      if (!display || status !== "active") continue;
      
      const key = `${display.toLowerCase()}|${reaction.toLowerCase()}|${criticality.toLowerCase()}`;
      if (!allergyKeys.has(key)) {
        allergyKeys.add(key);
        activeAllergies.push({
          substance_display: display,
          reaction_display: reaction,
          criticality,
          clinical_status: status,
        });
      }
    }

    // No allergies on record — return clean result without calling LLM
    if (activeAllergies.length === 0) {
      return new Response(
        JSON.stringify({
          overallRisk: "none",
          clinicalSummary: "No active allergies found on record for this patient.",
          findings: [],
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Check for "no known allergy" placeholder entries
    const isNoKnownAllergy = activeAllergies.every((a) =>
      a.substance_display.toLowerCase().includes("no known") ||
      a.substance_display.toLowerCase().includes("nkda") ||
      a.substance_display.toLowerCase() === ""
    );

    if (isNoKnownAllergy) {
      return new Response(
        JSON.stringify({
          overallRisk: "none",
          clinicalSummary: "Patient has no known drug allergies documented in the EHR.",
          findings: [],
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Build a map of drug-allergen pairs for signal matching later
    const drugAllergenMap = new Map<string, { drug: string; allergen: string; drugSource: string; allergenSource: string }>();
    for (const med of proposedMedications) {
      const drug = fallbackIngredient(String(med.ingredient || med.name || ""));
      const drugSource = String(med.name || drug);
      for (const allergy of activeAllergies) {
        const allergen = fallbackIngredient(allergy.substance_display);
        const key = `${drug}|${allergen}`;
        if (!drugAllergenMap.has(key)) {
          drugAllergenMap.set(key, { drug, allergen, drugSource, allergenSource: allergy.substance_display });
        }
      }
    }

    let modelReview: { overallRisk?: string; clinicalSummary?: string; findingsText?: string } | null = null;
    let geminiError: string | null = null;
    let groundingChunks: unknown[] = [];

    try {
      // Always use Google Search Grounding for the allergy review
      const result = await callGeminiForAllergyReview(patientCode, proposedMedications, activeAllergies, true);
      modelReview = result.parsed;
      groundingChunks = result.groundingChunks;
    } catch (error) {
      console.error("Gemini allergy review failed.", error);
      geminiError = error instanceof Error ? error.message : String(error);
    }

    let rawFindings: AllergyFinding[] = [];
    if (modelReview?.findingsText) {
      rawFindings = parseFindingsText(modelReview.findingsText, drugAllergenMap);
    } else if (geminiError) {
      rawFindings = [
        {
          type: "Drug-Allergy",
          severity: "none",
          signal: "Allergy review service unavailable",
          detail: "The AI allergy agent could not complete the review at this time.",
          action: "Please manually review the prescribed medications against the patient's allergy history.",
          evidence: [],
        },
      ];
    }

    // Apply URL correction using grounding chunks
    const validatedFindings = correctAllergyEvidenceUrls(
      rawFindings,
      groundingChunks as Array<{ web?: { uri: string; title: string } }>,
    );

    // Ensure all findings have empty evidence initially to trigger "Fetch Clinical References" in frontend
    validatedFindings.forEach(f => {
      f.evidence = [];
    });

    const rawOverallRisk = String(modelReview?.overallRisk || "none").toLowerCase();
    const overallRisk = (["none", "low", "medium", "high", "critical"].includes(rawOverallRisk)
      ? rawOverallRisk
      : "none") as "none" | "low" | "medium" | "high" | "critical";

    const clinicalSummary = String(modelReview?.clinicalSummary || "").trim();

    // Save review session and findings to Supabase
    const { data: reviewSession, error: reviewSessionError } = await supabase
      .from("prescription_review_sessions")
      .insert({
        patient_id: patientRow.id,
        requested_medications: proposedMedications,
        normalized_ingredients: proposedMedications.map((item) =>
          fallbackIngredient(String(item.ingredient || item.name || ""))
        ),
        overall_severity: overallRisk,
        report_status: "completed",
      })
      .select("id")
      .single();

    if (reviewSessionError) throw reviewSessionError;

    if (validatedFindings.length > 0) {
      const findingRows = validatedFindings.map((finding) => ({
        review_session_id: reviewSession.id,
        interaction_type: "drug_allergy",
        severity: finding.severity,
        signal: finding.signal,
        explanation: finding.reasoning
          ? `Medical Reasoning: ${finding.reasoning}\n\nDetail: ${finding.detail}`
          : finding.detail,
        recommendation: finding.action,
        evidence: finding.evidence || [],
      }));
      const { error: findingsError } = await supabase.from("interaction_findings").insert(findingRows);
      if (findingsError) throw findingsError;
    }

    return new Response(
      JSON.stringify({
        reviewSessionId: reviewSession.id,
        overallRisk,
        clinicalSummary,
        findings: validatedFindings,
        geminiError,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error(error);
    const errorMessage = error instanceof Error ? error.message : "Unexpected allergy agent failure.";
    return new Response(
      JSON.stringify({
        reviewSessionId: null,
        overallRisk: "none",
        clinicalSummary: "The allergy review agent encountered an error. Please retry or review manually.",
        findings: [
          {
            type: "Drug-Allergy",
            severity: "none",
            signal: "Allergy review agent error",
            detail: errorMessage,
            action: "Please retry the review. If the error persists, manually verify medications against the patient's allergy history.",
            evidence: [],
          },
        ],
        geminiError: errorMessage,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
