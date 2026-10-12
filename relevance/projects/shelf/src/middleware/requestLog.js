/** Log one finished request. Tests assert this exact shape. */
export function formatLog(req, res, ms) {
  return `${req.method} ${req.path} ${res.statusCode} ${ms}ms`;
}

export function requestLog(req, res, next) {
  const started = Date.now();
  res.on("finish", () => {
    console.log(formatLog(req, res, Date.now() - started));
  });
  next();
}
