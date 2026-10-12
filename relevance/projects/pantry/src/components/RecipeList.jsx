export function RecipeList({ recipes, selectedId, onSelect }) {
  if (!recipes.length) {
    return <p className="empty">No recipes match.</p>;
  }
  return (
    <ul className="list">
      {recipes.map((recipe) => (
        <li key={recipe.id}>
          <button
            type="button"
            className={recipe.id === selectedId ? "row on" : "row"}
            onClick={() => onSelect(recipe.id)}
          >
            {recipe.title}
          </button>
        </li>
      ))}
    </ul>
  );
}
