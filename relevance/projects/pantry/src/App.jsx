import { useState } from "react";
import { Footer } from "./components/Footer.jsx";
import { Header } from "./components/Header.jsx";
import { RecipeDetail } from "./components/RecipeDetail.jsx";
import { RecipeList } from "./components/RecipeList.jsx";
import { SearchBox } from "./components/SearchBox.jsx";
import { TagPicker } from "./components/TagPicker.jsx";
import { useRecipes } from "./hooks/useRecipes.js";

export function App() {
  const { recipes, tag, setTag } = useRecipes();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(recipes[0] ? recipes[0].id : null);
  const selected = recipes.find((recipe) => recipe.id === selectedId) || recipes[0] || null;

  return (
    <div className="app">
      <Header />
      <div className="layout">
        <aside>
          <SearchBox value={query} onChange={setQuery} />
          <TagPicker tag={tag} onChange={setTag} />
          <RecipeList recipes={recipes} selectedId={selected && selected.id} onSelect={setSelectedId} />
        </aside>
        <RecipeDetail recipe={selected} />
      </div>
      <Footer />
    </div>
  );
}
