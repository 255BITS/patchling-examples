/** Validate a book create/replace body. Returns a list of error strings. */
export function validateBook(body) {
  const errors = [];
  if (!body || typeof body !== "object") return ["body must be an object"];
  if (typeof body.title !== "string" || !body.title.trim()) errors.push("title is required");
  if (typeof body.author !== "string" || !body.author.trim()) errors.push("author is required");
  if (!Number.isInteger(body.priceCents) || body.priceCents < 0) {
    errors.push("priceCents must be a non-negative integer");
  }
  if (body.tags !== undefined && !Array.isArray(body.tags)) errors.push("tags must be an array");
  return errors;
}
