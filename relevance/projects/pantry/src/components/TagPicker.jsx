import { tags } from "../data/recipes.js";

export function TagPicker({ tag, onChange }) {
  return (
    <div className="tag-row" role="group" aria-label="Filter by tag">
      {tags.map((name) => (
        <button
          key={name}
          type="button"
          className={name === tag ? "tag on" : "tag"}
          onClick={() => onChange(name)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
