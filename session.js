// Estado de la sesión en vivo: lectura pública, votos públicos y acciones del facilitador.
const L = require("./_lib");

async function tally(sid) {
  const flat = (await L.redis(["HGETALL", "votes:" + sid])) || [];
  const counts = [0, 0, 0, 0];
  let total = 0;
  for (let i = 1; i < flat.length; i += 2) {
    const c = parseInt(flat[i], 10);
    if (c >= 0 && c <= 3) { counts[c]++; total++; }
  }
  return { counts, total };
}

const isLive = s => !!(s && s.sessionId && s.phase && s.phase !== "idle");

module.exports = async (req, res) => L.handle(res, async () => {
  /* ---------- Lectura ---------- */
  if (req.method === "GET") {
    const fac = req.query && req.query.fac === "1";
    if (fac && !L.isFacilitator(req)) throw L.httpError(401, "PIN incorrecto.");

    const session = (await L.getJSON("session")) || { phase: "idle" };
    const out = { session, counts: null, total: 0 };

    if (isLive(session) && (fac || session.phase === "revealed")) {
      const t = await tally(session.sessionId);
      out.counts = t.counts; out.total = t.total;
    }
    if (fac) {
      out.prepared = await L.getJSON("prepared");
      const act = await L.getJSON("active");
      out.hintsAvailable = act && session.sessionId && act.sessionId === session.sessionId ? (act.pistas || []).length : 0;
      res.setHeader("Cache-Control", "no-store");
    } else {
      // Los participantes comparten una copia de 2 s en el borde de Vercel: ahorra lecturas.
      res.setHeader("Cache-Control", "public, s-maxage=2");
    }
    return res.status(200).json(out);
  }

  if (req.method !== "POST") throw L.httpError(405, "Método no permitido.");
  res.setHeader("Cache-Control", "no-store");
  const body = L.readBody(req);

  /* ---------- Voto (sin PIN) ---------- */
  if (body.action === "vote") {
    const voter = String(body.voter || "");
    const choice = Number.isInteger(body.choice) ? body.choice : -1;
    if (voter.length < 8 || voter.length > 64 || choice < 0 || choice > 3) throw L.httpError(400, "Voto inválido.");
    const s = await L.getJSON("session");
    if (!isLive(s) || s.phase !== "voting" || s.sessionId !== body.sid) {
      throw L.httpError(409, "La votación ya no está abierta.");
    }
    await L.redis(["HSET", "votes:" + s.sessionId, voter, String(choice)]);
    await L.redis(["EXPIRE", "votes:" + s.sessionId, 172800]);
    return res.status(200).json({ ok: true });
  }

  /* ---------- Acciones del facilitador ---------- */
  if (!L.isFacilitator(req)) throw L.httpError(401, "PIN incorrecto.");

  if (body.action === "launch") {
    const p = await L.getJSON("prepared");
    if (!p) throw L.httpError(409, "No hay una pregunta preparada.");
    const cur = await L.getJSON("session");
    if (isLive(cur) && cur.phase === "voting") throw L.httpError(409, "Revela o termina la sesión actual primero.");
    const sid = String(Date.now());
    await L.setJSON("active", Object.assign({}, p, { sessionId: sid }));
    await L.setJSON("session", {
      sessionId: sid, phase: "voting", role: p.role, question: p.question,
      respuesta: p.respuesta, opciones: p.opciones, hints: [], launchedAt: Date.now()
    });
    return res.status(200).json({ ok: true });
  }

  const s = await L.getJSON("session");
  const a = await L.getJSON("active");

  if (body.action === "hint") {
    if (!isLive(s) || s.phase !== "voting" || !a || a.sessionId !== s.sessionId) throw L.httpError(409, "No hay votación en curso.");
    const next = (a.pistas || [])[(s.hints || []).length];
    if (!next) throw L.httpError(409, "No hay más pistas.");
    s.hints = (s.hints || []).concat(next);
    await L.setJSON("session", s);
    return res.status(200).json({ ok: true });
  }

  if (body.action === "reveal") {
    if (!isLive(s) || s.phase !== "voting" || !a || a.sessionId !== s.sessionId) throw L.httpError(409, "No hay votación en curso.");
    s.phase = "revealed";
    s.correctIdx = a.correctIdx;
    s.reveal = {
      dato_omitido: a.dato_omitido, por_que_importa: a.por_que_importa,
      consecuencia: a.consecuencia, enfoque_mejor: a.enfoque_mejor,
      preguntas_debate: a.preguntas_debate || []
    };
    await L.setJSON("session", s);
    return res.status(200).json({ ok: true });
  }

  if (body.action === "end") {
    await L.setJSON("session", { phase: "idle" });
    return res.status(200).json({ ok: true });
  }

  throw L.httpError(400, "Acción desconocida.");
});
