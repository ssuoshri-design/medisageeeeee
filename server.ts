import express from "express";
import path from "path";
import dotenv from "dotenv";
import fs from "fs";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = 3000;

// Initialize Google Gen AI
const apiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;
if (apiKey) {
  ai = new GoogleGenAI({ apiKey });
} else {
  console.warn("WARNING: GEMINI_API_KEY environment variable is not set.");
}

app.use(express.json());

// API route: config
app.get("/api/config", (req, res) => {
  // Read firebase config securely
  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return res.json({
        firebaseConfig: config,
        status: "configured",
      });
    }
  } catch (error) {
    console.error("Error reading Firebase config file", error);
  }

  // Fallback to environment variables
  res.json({
    firebaseConfig: {
      apiKey: process.env.FIREBASE_API_KEY || "",
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
      projectId: process.env.FIREBASE_PROJECT_ID || "",
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
      appId: process.env.FIREBASE_APP_ID || "",
    },
    status: "env_fallback",
  });
});

// API route: chat
app.post("/api/chat", async (req, res) => {
  const { messages, userProfile } = req.body;

  if (!ai) {
    return res.status(500).json({
      error: "AI Service is not configured. Please add GEMINI_API_KEY to your Secrets.",
    });
  }

  try {
    const formattedMessages = [];
    for (const m of messages) {
      const parts: any[] = [{ text: m.content || "" }];

      // Handle media attachments
      if (m.media && m.media.length > 0) {
        for (const file of m.media) {
          if (file.base64) {
            parts.push({
              inlineData: {
                mimeType: file.type || "image/jpeg",
                data: file.base64,
              }
            });
          } else if (file.content) {
            // Text contents (like CSV) can be encoded as base64
            const base64Content = Buffer.from(file.content).toString("base64");
            parts.push({
              inlineData: {
                mimeType: file.type || "text/plain",
                data: base64Content,
              }
            });
          } else if (file.url && file.url.startsWith("http")) {
            // Fetch remote URL on server and convert to base64
            try {
              const fetchResponse = await fetch(file.url);
              const arrayBuffer = await fetchResponse.arrayBuffer();
              const base64 = Buffer.from(arrayBuffer).toString("base64");
              parts.push({
                inlineData: {
                  mimeType: file.type || "image/jpeg",
                  data: base64,
                }
              });
            } catch (fetchErr) {
              console.error(`Failed to fetch remote attachment: ${file.url}`, fetchErr);
            }
          }
        }
      }

      formattedMessages.push({
        role: m.role === "assistant" ? "model" : "user",
        parts,
      });
    }

    let systemInstruction = `You are MediSage AI, an elite medical AI consultant with a "Minimal Luxury Medical" design aesthetic. Your answers must be incredibly structured, calm, professional, empathetic, and authoritative.
    
    You MUST structure your responses in a clear medical format. When analyzing symptoms, your output should include a structured response that can be parsed or rendered elegantly.
    
    Format your response using clean Markdown with specific headers so the UI can render beautiful custom widgets:
    
    ### Symptom Analysis
    Based on your symptoms...
    - [x] Consideration 1 (e.g., Seasonal Respiratory Infection)
    - [x] Consideration 2
    
    ### Rest & Hydration
    (Provide clinical, practical self-care recommendations)
    
    ### Diagnostics
    - BPM: 72 (or recommended monitoring)
    - O2: 98%
    
    When explaining lab reports or prescriptions:
    - Extract all medical measurements (blood values, dosage limits, etc.).
    - Clearly identify if values are low, high, or within the normal reference range.
    - Provide likely clinical causes, clear lifestyle/dietary guidance, and specific follow-up questions to ask their doctor.
    - Present information in an empathetic, reassuring, but authoritative medical tone.
    
    Keep explanations scannable, highly legible, and use bolding for key clinical terms. Never include any alarming language, and always maintain a professional, reassuring clinical tone. Add a disclaimer that this is an AI-powered advisory tool and they should consult a real health professional.`;

    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (projectId) {
      try {
        const configUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/configs/gemini`;
        const configRes = await fetch(configUrl);
        if (configRes.ok) {
          const configJson: any = await configRes.json();
          if (configJson?.fields?.instruction?.stringValue) {
            systemInstruction = configJson.fields.instruction.stringValue;
            console.log("Loaded custom system instruction from Firestore configs/gemini REST API");
          }
        }
      } catch (err) {
        console.error("Failed to load dynamic system prompt from Firestore REST API:", err);
      }
    }

    // Use gemini-2.5-flash for speed and reliability
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: formattedMessages,
      config: {
        systemInstruction,
        temperature: 0.3,
      },
    });

    const replyText = response.text || "I was unable to analyze that. Please try describing your symptoms again.";
    res.json({ content: replyText });
  } catch (error: any) {
    console.error("Error generating AI content:", error);
    res.status(500).json({ error: error.message || "Failed to generate AI response." });
  }
});

// Start server and mount Vite middleware
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
