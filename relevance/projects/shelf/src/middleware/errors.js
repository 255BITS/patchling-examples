export function notFound(_req, res) {
  res.status(404).json({ error: "not found" });
}

export function errors(err, _req, res, _next) {
  const status = Number(err.status) || 500;
  const message = status === 500 ? "internal error" : err.message || "error";
  if (status === 500) console.error(err);
  res.status(status).json({ error: message });
}
