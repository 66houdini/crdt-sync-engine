import { FugueMax, RGA } from "@crdt/core";
import type { CrdtFactory } from "../src/index";

export type CrdtName = "fugue" | "rga";

/** Runs `body` with the factory for the named CRDT (the two have different op types). */
export function withCrdt<R>(name: CrdtName, body: <Op>(factory: CrdtFactory<Op>) => R): R {
  return name === "rga" ? body((id) => new RGA(id)) : body((id) => new FugueMax(id));
}

export function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(arg.slice(2), "true");
    else flags.set(arg.slice(2), argv[++i] as string);
  }
  return flags;
}

export function intFlag(flags: Map<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} must be an integer, got ${raw}`);
  return value;
}

export function crdtFlag(flags: Map<string, string>, fallback: CrdtName): CrdtName {
  const raw = flags.get("crdt") ?? fallback;
  if (raw !== "fugue" && raw !== "rga") throw new Error(`--crdt must be fugue or rga, got ${raw}`);
  return raw;
}
