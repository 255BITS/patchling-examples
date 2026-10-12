import express from "express";
import { errors, notFound } from "./middleware/errors.js";
import { requestLog } from "./middleware/requestLog.js";
import { authors } from "./routes/authors.js";
import { books } from "./routes/books.js";
import { health } from "./routes/health.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(requestLog);
  app.use("/health", health);
  app.use("/books", books);
  app.use("/authors", authors);
  app.use(notFound);
  app.use(errors);
  return app;
}

export const app = createApp();
