export function SearchBox({ value, onChange }) {
  return (
    <label className="search">
      Search
      <input
        value={value}
        placeholder="title or ingredient"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
