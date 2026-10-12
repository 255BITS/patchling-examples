# Shelf

A small Express API for the inventory of a corner bookstore. Books live in
`data/seed.json`. Prices are stored as integer cents.

```bash
npm install
npm start          # http://localhost:8787
npm test
```

Routes:

- `GET /health` — liveness
- `GET /books` and `GET /books/:id` — the catalog
- `POST /books` and `PUT /books/:id` — create and replace
- `GET /authors` — authors derived from the catalog

`PORT` and `SEED_PATH` override the defaults in `src/config.js`.
