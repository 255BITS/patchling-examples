import { Router } from "express";
import { randomUUID } from "node:crypto";
import { addBook, getBook, listBooks, replaceBook } from "../db.js";
import { slugify } from "../lib/slug.js";
import { validateBook } from "../lib/validate.js";

export const books = Router();

function publicBook(book) {
  return {
    id: book.id,
    slug: book.slug,
    title: book.title,
    author: book.author,
    priceCents: book.priceCents,
    tags: book.tags || [],
  };
}

books.get("/", (_req, res) => {
  const all = listBooks().map(publicBook);
  res.json({ books: all });
});

books.get("/:id", (req, res) => {
  const book = getBook(req.params.id);
  if (!book) {
    res.status(404).json({ error: "book not found" });
    return;
  }
  res.json({ book: publicBook(book) });
});

books.post("/", (req, res) => {
  const problems = validateBook(req.body);
  if (problems.length) {
    res.status(400).json({ errors: problems });
    return;
  }
  const book = addBook({
    id: `bk_${randomUUID().slice(0, 8)}`,
    slug: req.body.slug || slugify(req.body.title),
    title: req.body.title.trim(),
    author: req.body.author.trim(),
    priceCents: req.body.priceCents,
    tags: req.body.tags || [],
  });
  res.status(201).json({ book: publicBook(book) });
});

books.put("/:id", (req, res) => {
  const current = getBook(req.params.id);
  if (!current) {
    res.status(404).json({ error: "book not found" });
    return;
  }
  const problems = validateBook(req.body);
  if (problems.length) {
    res.status(400).json({ errors: problems });
    return;
  }
  const book = replaceBook(req.params.id, {
    slug: req.body.slug || slugify(req.body.title),
    title: req.body.title.trim(),
    author: req.body.author.trim(),
    priceCents: req.body.priceCents,
    tags: req.body.tags || [],
  });
  res.json({ book: publicBook(book) });
});
