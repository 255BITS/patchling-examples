/** Remote catalog client. The app still reads src/data/recipes.js instead. */

export async function fetchRecipes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`recipe request failed (${response.status})`);
  }
  const body = await response.json();
  if (!Array.isArray(body.recipes)) throw new Error("response has no recipes array");
  return body.recipes;
}
