export function RecipeDetail({ recipe }) {
  if (!recipe) {
    return <p className="empty">Select a recipe.</p>;
  }
  return (
    <article className="detail">
      <h2>{recipe.title}</h2>
      <p className="meta">{recipe.tags.join(", ")}</p>
      <h3>Ingredients</h3>
      <ul>
        {recipe.ingredients.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h3>Steps</h3>
      <ol>
        {recipe.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </article>
  );
}
