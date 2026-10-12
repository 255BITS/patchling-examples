import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PORT = Number(process.env.PORT || 8787);
export const SEED_PATH = process.env.SEED_PATH || join(root, "data", "seed.json");
