// Muestra la omisión solo a quien conozca el código (por defecto 123456; se puede cambiar con REVEAL_CODE).
const crypto = require("crypto");
const { open } = require("./_crypto");

// Solo se cuentan los intentos con código incorrecto (en una sala todos comparten IP).
const fails = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 30;

function recent(ip) {
  const now = Date.now();
  return (fails.get(ip) || []).filter(t => now - t < WINDOW_MS);
}
function blocked(ip) { return recent(ip).length >= MAX_FAILS; }
function recordFail(ip) {
  const list = recent(ip); list.push(Date.now()); fails.set(ip, list);
  if (fails.size > 5000) fails.clear();
}

function fail(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") throw fail(405, "Método no permitido.");
    let body = req.body || {};
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }

    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "desconocida";
    if (blocked(ip)) throw fail(429, "Demasiados intentos con código incorrecto. Espera unos minutos.");

    const expected = process.env.REVEAL_CODE || "123456";
    const a = Buffer.from(String(body.code || "")), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { recordFail(ip); throw fail(401, "Código incorrecto."); }

    if (!body.token) throw fail(404, "Esta respuesta no tiene una omisión disponible.");
    let omision;
    try { omision = open(body.token); } catch (e) { throw fail(400, "No se pudo leer la omisión."); }

    res.status(200).json({ omision });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Error inesperado." });
  }
};
