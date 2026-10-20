// Solo el facilitador (con PIN) puede generar. Así nadie más gasta tu clave de API.
const L = require("./_lib");

module.exports = async (req, res) => L.handle(res, async () => {
  res.setHeader("Cache-Control", "no-store");
  if (!L.isFacilitator(req)) throw L.httpError(401, "PIN incorrecto.");
  if (req.method !== "POST") throw L.httpError(405, "Método no permitido.");

  const body = L.readBody(req);
  const role = String(body.role || "").trim();
  const question = String(body.question || "").trim();
  if (!role || !question) throw L.httpError(400, "Escribe el cargo y la pregunta.");
  if (role.length > 120 || question.length > 1200) throw L.httpError(400, "El texto es demasiado largo.");

  const raw = await L.callClaude(L.buildPrompt(role, question));
  const data = L.normalize(raw);
  data.role = role;
  data.question = question;
  data.preparedAt = Date.now();
  await L.setJSON("prepared", data);
  res.status(200).json({ prepared: data });
});
