// =============================================================
// server.js — Final Stable Backend (Gemini + Fuzzy Fallback)
// Uses your exact structure, filenames, and route logic.
// =============================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import axios from "axios";
import fuzzy from "fuzzy";
import { GoogleGenerativeAI } from "@google/generative-ai";

// -------------------- Setup --------------------
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 5000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

// -------------------- File Paths --------------------
const DISEASE_FILE = path.join(process.cwd(), "disease_dataset_200_real_medium_v2.json");
const USER_FILE = path.join(process.cwd(), "user_symptoms.json");

// -------------------- Load JSON Helpers --------------------
function loadJSON(filepath, fallback) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, "utf8"));
    }
    return fallback;
  } catch (err) {
    console.warn(`⚠️ Error loading ${filepath}:`, err.message);
    return fallback;
  }
}

function saveJSON(filepath, data) {
  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.warn(`⚠️ Error saving ${filepath}:`, err.message);
  }
}

// -------------------- Load Data --------------------
let DISEASE_DATA = loadJSON(DISEASE_FILE, []);
let USER_DATA = loadJSON(USER_FILE, {});

console.log("📄 Diseases loaded:", DISEASE_DATA.length);

// -------------------- Gemini Client --------------------
let genAI = null;

if (GEMINI_API_KEY) {
  try {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    console.log("🤖 Gemini AI initialized");
  } catch (err) {
    console.warn("⚠️ Gemini initialization failed:", err.message);
    genAI = null;
  }
} else {
  console.warn("⚠️ No GEMINI_API_KEY found → Using fallback only");
}

// -------------------- Extract Text Helper --------------------
function extractTextFromGenResult(result) {
  try {
    if (!result) return "";
    if (result.response?.text) return result.response.text();
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

// -------------------- Symptom Normalization --------------------
async function normalizeSymptoms(text, knownSymptoms = []) {
  if (!text) return [];

  const inputText = Array.isArray(text) ? text.join(", ") : String(text);

  // 1️⃣ Gemini Primary
  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

      const prompt = `
Given this list of valid symptoms:
${JSON.stringify(knownSymptoms)}

Extract ONLY the symptoms from the list that match the user input.
Return them as a comma-separated list, no explanations.
User input: "${inputText}"
`;

      let result = await model.generateContent(prompt);
      let raw = extractTextFromGenResult(result).trim();

      if (raw) {
        let parts = raw.split(",").map(s => s.trim().toLowerCase());
        let matched = knownSymptoms.filter(sym =>
          parts.includes(sym.toLowerCase())
        );

        if (matched.length > 0) {
          console.log("✨ Gemini normalized:", matched);
          return matched;
        }
      }
    } catch (err) {
      console.log("⚠️ Gemini normalization failed → using fallback:", err.message);
    }
  }

  // 2️⃣ Fuzzy Fallback
  console.log("🔄 Fuzzy fallback running...");
  const options = { extract: x => x };
  const fuzzyMatches = fuzzy.filter(inputText, knownSymptoms, options).map(r => r.string);

  const tokens = inputText.toLowerCase().split(/[\s,]+/);
  const directMatches = knownSymptoms.filter(sym =>
    tokens.includes(sym.toLowerCase())
  );

  return [...new Set([...fuzzyMatches, ...directMatches])];
}

// -------------------- Prolonged Symptom Checker --------------------
function checkProlonged(user_id) {
  const user = USER_DATA[user_id] || {};
  const history = user.history || [];

  if (history.length < 3) return [];

  let count = {};
  history.slice(-3).forEach(rec => {
    rec.symptoms.forEach(s => count[s] = (count[s] || 0) + 1);
  });

  return Object.keys(count)
    .filter(s => count[s] >= 3)
    .map(s => `The symptom '${s}' has persisted for 3 days. Please consult a doctor.`);
}

// -------------------- Environment Factors --------------------
function fetchEnvironment(city = "") {
  const c = city.toLowerCase();
  return {
    AQI: ["delhi", "kanpur"].includes(c) ? 200 : 100,
    water_quality: ["delhi", "kanpur"].includes(c) ? "poor" : "good"
  };
}

// =============================================================
// ROUTES
// =============================================================

// ✔ Health Check
app.get("/health", (req, res) => {
  res.json({ status: "OK", time: new Date().toISOString() });
});

// ✔ Submit Symptoms
app.post("/submit_symptoms", async (req, res) => {
  try {
    const { user_id, symptoms, language = "en", gender = "other", city = "" } = req.body;

    if (!user_id || !symptoms)
      return res.status(400).json({ error: "user_id and symptoms required" });

    let known = [...new Set(DISEASE_DATA.flatMap(d => d.symptoms || []))];

    let norm = [];
    if (typeof symptoms === "string") norm = await normalizeSymptoms(symptoms, known);
    else if (Array.isArray(symptoms))
      for (const s of symptoms) norm.push(...await normalizeSymptoms(s, known));

    norm = [...new Set(norm)];

    if (!USER_DATA[user_id])
      USER_DATA[user_id] = { language, gender, city, points: 0, badges: [], history: [] };

    USER_DATA[user_id].history.push({
      date: new Date().toISOString().slice(0, 10),
      symptoms: norm
    });

    USER_DATA[user_id].points += 10;
    saveJSON(USER_FILE, USER_DATA);

    res.json({
      message: "Symptoms recorded.",
      normalized_symptoms: norm
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✔ Match Diseases
app.post("/match_diseases", async (req, res) => {
  const { symptoms, user_id } = req.body;

  if (!user_id || !symptoms)
    return res.status(400).json({ error: "user_id and symptoms required" });

  const user = USER_DATA[user_id] || {};
  const env = fetchEnvironment(user.city);

  let known = [...new Set(DISEASE_DATA.flatMap(d => d.symptoms || []))];
  let userNorm = await normalizeSymptoms(symptoms, known);

  let result = [];

  DISEASE_DATA.forEach(d => {
    let score = userNorm.filter(s => (d.symptoms || []).includes(s)).length;

    if (d.higher_risk_gender === user.gender) score++;
    if ((d.tags || []).includes("respiratory") && env.AQI > 150) score++;
    if ((d.tags || []).includes("water-borne") && env.water_quality === "poor") score += 2;

    if (score > 0) {
      result.push({
        name: d.name,
        severity: d.severity || "unknown",
        match_score: score,
        requires_doctor: d.requires_doctor || false,
        verified_info_url: `https://medlineplus.gov/search/?query=${encodeURIComponent(d.name)}`,
        advice: d.advice?.[user.language] || d.advice?.en || null,
        prevention: d.prevention?.[user.language] || d.prevention?.en || null
      });
    }
  });

  result.sort((a, b) => b.match_score - a.match_score);
  res.json(result);
});

// ✔ Daily Check-in
app.get("/daily_checkin/:id", (req, res) => {
  const user = USER_DATA[req.params.id];

  if (!user || !user.history.length)
    return res.json({ message: "Start by submitting symptoms.", last_symptoms: null, alerts: [] });

  res.json({
    message: "How are you feeling today?",
    last_symptoms: user.history[user.history.length - 1],
    alerts: checkProlonged(req.params.id)
  });
});

// ✔ Chat with Gemini
app.post("/chat", async (req, res) => {
  if (!req.body.message) return res.json({ response: "Please enter a message." });
  if (!genAI) return res.json({ response: "AI unavailable." });

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(`User: ${req.body.message}\nAssistant:`);
    const reply = extractTextFromGenResult(result).trim();
    res.json({ response: reply || "AI returned no response." });
  } catch (err) {
    res.json({ response: "AI error." });
  }
});

// ✔ User Stats
app.get("/user_stats/:id", (req, res) => {
  const u = USER_DATA[req.params.id];
  if (!u) return res.status(404).json({ error: "User not found" });

  res.json({
    points: u.points,
    badges: u.badges,
    history_length: u.history.length
  });
});

// ✔ Doctor Locator
app.post("/doctor_locator", async (req, res) => {
  const { latitude, longitude, city } = req.body;

  const placeholder = [
    { name: "City Hospital", address: `${city || "Unknown"}` }
  ];

  if (!latitude || !longitude || !GOOGLE_MAPS_API_KEY)
    return res.json({ hospitals: placeholder });

  try {
    const response = await axios.get("https://maps.googleapis.com/maps/api/place/nearbysearch/json", {
      params: {
        location: `${latitude},${longitude}`,
        radius: 5000,
        type: "hospital",
        key: GOOGLE_MAPS_API_KEY
      }
    });

    let hospitals = response.data.results.map(h => ({
      name: h.name,
      address: h.vicinity,
      rating: h.rating || "N/A"
    }));

    res.json({ hospitals: hospitals.length ? hospitals : placeholder });
  } catch {
    res.json({ hospitals: placeholder });
  }
});

// ✔ Medicine Info
app.get("/medicine_info", async (req, res) => {
  const drug = req.query.drug_name;
  if (!drug) return res.status(400).json({ error: "drug_name required" });

  try {
    const r = await axios.get("https://api.fda.gov/drug/label.json", {
      params: { search: `openfda.brand_name:"${drug}"`, limit: 1 }
    });

    const d = r.data.results?.[0];
    if (!d) return res.json({ info: null });

    res.json({
      drug_info: {
        brand_name: d.openfda?.brand_name,
        generic_name: d.openfda?.generic_name,
        indications: d.indications_and_usage,
        dosage: d.dosage_and_administration,
        warnings: d.warnings
      }
    });

  } catch {
    res.json({ error: "Could not fetch medicine info" });
  }
});

// =============================================================
// SERVE FRONTEND SPA
// =============================================================
app.use(express.static(path.join(process.cwd(), "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "app.html"));
});

// =============================================================
// START SERVER
// =============================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
