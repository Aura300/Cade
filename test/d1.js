import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

// A stand-in for a D1 binding, backed by an in-memory SQLite database with
// the migrations applied. reset() empties it, for a fresh one per test.
export function fakeD1() {
  let db;
  const binding = {
    reset() {
      db = new DatabaseSync(":memory:");
      for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
        db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
      }
    },
    prepare(sql) {
      const statement = (params) => ({
        bind: (...values) => statement(values),
        first: async () => db.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        run: async () => db.prepare(sql).run(...params),
      });
      return statement([]);
    },
  };
  binding.reset();
  return binding;
}
