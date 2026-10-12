import { app } from "./app.js";
import { PORT } from "./config.js";
import { load } from "./db.js";

load();
app.listen(PORT, () => {
  console.log(`shelf listening on ${PORT}`);
});
