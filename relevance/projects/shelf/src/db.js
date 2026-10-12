import { readFileSync } from "node:fs";
import { SEED_PATH } from "./config.js";

let books = [];
let seedLoaded = false;

export function load(path = SEED_PATH) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw.books)) throw new Error("seed file has no books array");
  books = raw.books.map((book) => ({ ...book }));
  seedLoaded = true;
  return books.length;
}

export function reset() {
  books = [];
  seedLoaded = false;
}

export function listBooks() {
  return books.map((book) => ({ ...book }));
}

export function getBook(id) {
  const found = books.find((book) => book.id === id);
  return found ? { ...found } : null;
}

export function addBook(book) {
  books.push({ ...book });
  return { ...book };
}

export function replaceBook(id, book) {
  const index = books.findIndex((item) => item.id === id);
  if (index === -1) return null;
  books[index] = { ...book, id };
  return { ...books[index] };
}

export function countBooks() {
  return books.length;
}

export function wasSeedLoaded() {
  return seedLoaded;
}

export function listAuthors() {
  const counts = new Map();
  for (const book of books) {
    counts.set(book.author, (counts.get(book.author) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, bookCount]) => ({ name, bookCount }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
