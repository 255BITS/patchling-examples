import { Router } from "express";
import { listAuthors } from "../db.js";

export const authors = Router();

authors.get("/", (_req, res) => {
  res.json({ authors: listAuthors() });
});
