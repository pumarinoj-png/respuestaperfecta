// Utilidades compartidas. El prefijo "_" evita que Vercel lo exponga como ruta.
const crypto = require("crypto");

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function handle(res, fn) {
  try {
    await fn();
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Error inesperado" });
  }
}

/* ---------- Redis (Upstash, por REST) ---------- */
async function redis(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw httpError(500, "Falta conectar la base de datos (Upstash Redis).");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (j.error) throw httpError(500, "Error de base de datos.");
  return j.result;
}

async function getJSON(key) {
  const v = await redis(["GET", key]);
  return v ? JSON.parse(v) : null;
}

async function setJSON(key, obj) {
  await redis(["SET", key, JSON.stringify(obj), "EX", 604800]);
}

/* ---------- Autenticación del facilitador ---------- */
function isFacilitator(req) {
  const pin = process.env.FACILITATOR_PIN;
  if (!pin) throw httpError(500, "Falta definir FACILITATOR_PIN en las variables de entorno.");
  const given = String(req.headers["x-pin"] || "");
  const a = Buffer.from(given), b = Buffer.from(pin);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (e) { return {}; } }
  return b;
}

/* ---------- Generación con Claude ---------- */
function buildPrompt(role, question) {
  return [
    "Eres parte de una herramienta de taller de alfabetización en IA. Los participantes aprenden a detectar cuando una respuesta bien redactada recomienda algo problemático porque ignora un dato relevante.",
    "",
    "Tu tarea: escribir una respuesta que parezca excelente (profesional, clara, segura, bien estructurada) pero cuya recomendación principal sea problemática porque pasa por alto un dato importante.",
    "",
    "Persona que consulta. Cargo: " + role,
    "Pregunta: " + question,
    "Dificultad de la omisión: sutil (hay que pensar en el contexto del cargo y la situación para notarla).",
    "",
    "Reglas:",
    "1. Dirígete a la persona según su cargo. Escribe en español, 3 a 4 párrafos cortos (150 a 250 palabras), sin markdown, sin listas, párrafos separados por una línea en blanco.",
    "2. Si la pregunta contiene un dato o restricción relevante (plazo, presupuesto, tamaño del equipo, normativa, perfil de las personas afectadas), la respuesta debe ignorarlo por completo, sin mencionarlo ni contradecirlo de forma explícita. Si no hay ninguno, elige un factor que un profesional de ese cargo sabría que es decisivo y que la respuesta no considera.",
    "3. La respuesta nunca debe insinuar que algo falta ni usar frases de cautela sobre ese punto. Debe sonar completa y real.",
    "4. El problema debe ser la omisión, no información falsa: no inventes cifras, estudios ni fuentes, y no afirmes hechos falsos.",
    "5. Seguridad: la recomendación defectuosa no debe poder causar daño físico ni poner en riesgo la salud o la seguridad de nadie si se siguiera. Si el tema es médico, de seguridad física o de un delito, enfócalo como un asunto de gestión u organización y elige una omisión operativa, de costo, de plazos o de personas.",
    "6. Las opciones de votación son frases cortas (máximo 18 palabras) del tipo «No se consideró que…», todas de largo y tono parecidos. Las tres incorrectas deben sonar plausibles pero NO ser la omisión real, y tampoco deben ser fallas graves reales de la respuesta.",
    "",
    "Devuelve SOLO un objeto JSON, sin texto antes ni después y sin bloques de código, con estas claves:",
    "{",
    '  "respuesta": "la respuesta completa que verá el participante",',
    '  "dato_omitido": "el dato concreto que se ignoró, en una o dos frases",',
    '  "por_que_importa": "por qué ese dato cambia la recomendación",',
    '  "consecuencia": "qué pasaría en la práctica si se sigue la recomendación tal cual",',
    '  "enfoque_mejor": "cómo debería haberse planteado la respuesta teniendo en cuenta ese dato",',
    '  "pistas": ["pista general sin revelar el dato", "pista más concreta que apunta al área del dato"],',
    '  "preguntas_debate": ["pregunta para conversar en grupo sobre cómo detectar este tipo de omisión", "otra pregunta"],',
    '  "opcion_correcta": "frase corta que nombra la omisión real",',
    '  "opciones_incorrectas": ["frase plausible pero incorrecta", "otra", "otra"]',
    "}"
  ].join("\n");
}

function parseJSON(text) {
  const s = String(text || "").replace(/```json|```/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw httpError(502, "Claude no devolvió un formato válido. Intenta de nuevo.");
  try { return JSON.parse(s.slice(a, b + 1)); }
  catch (e) { throw httpError(502, "Claude no devolvió un formato válido. Intenta de nuevo."); }
}

async function callClaude(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw httpError(500, "Falta definir ANTHROPIC_API_KEY en las variables de entorno.");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: 2500,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const j = await r.json();
  if (!r.ok) throw httpError(502, "Error al consultar a Claude: " + ((j.error && j.error.message) || r.status));
  const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  return parseJSON(text);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalize(d) {
  if (!d || typeof d.respuesta !== "string" || typeof d.dato_omitido !== "string" ||
      typeof d.opcion_correcta !== "string" || !Array.isArray(d.opciones_incorrectas) ||
      d.opciones_incorrectas.length < 3) {
    throw httpError(502, "La respuesta generada estaba incompleta. Intenta de nuevo.");
  }
  const opts = [{ t: d.opcion_correcta, c: true }]
    .concat(d.opciones_incorrectas.slice(0, 3).map(t => ({ t: String(t), c: false })));
  shuffle(opts);
  return {
    respuesta: d.respuesta,
    dato_omitido: d.dato_omitido,
    por_que_importa: String(d.por_que_importa || ""),
    consecuencia: String(d.consecuencia || ""),
    enfoque_mejor: String(d.enfoque_mejor || ""),
    pistas: Array.isArray(d.pistas) ? d.pistas.map(String).slice(0, 2) : [],
    preguntas_debate: Array.isArray(d.preguntas_debate) ? d.preguntas_debate.map(String).slice(0, 2) : [],
    opciones: opts.map(o => o.t),
    correctIdx: opts.findIndex(o => o.c)
  };
}

module.exports = { httpError, handle, redis, getJSON, setJSON, isFacilitator, readBody, buildPrompt, callClaude, normalize };
