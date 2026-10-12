import { useMemo, useState } from "react";
import { recipes as seed } from "../data/recipes.js";

/**
 * Tag filtering already happens here. A text query is not applied.
 * Favorites are not tracked.
 */
export function useRecipes() {
  const [tag, setTag] = useState("all");

  const recipes = useMemo(() => {
    if (tag === "all") return seed;
    return seed.filter((recipe) => recipe.tags.includes(tag));
  }, [tag]);

  return { recipes, tag, setTag, total: seed.length };
}
